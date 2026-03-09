#!/bin/bash
# Integration tests for sitemgr using local Supabase
# Tests the full pipeline: upload → detect → enrich → query
# Uses the TypeScript CLI (web/bin/smgr.ts)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

TEST_COUNT=0
PASS_COUNT=0
FAIL_COUNT=0

# CLI command helper — runs smgr via npm in the web directory
SMGR="npx tsx bin/smgr.ts"
WEB_DIR="$(cd "$(dirname "$0")/../web" && pwd)"

smgr() {
    (cd "$WEB_DIR" && $SMGR "$@")
}

# Test helper functions
test_start() {
    TEST_COUNT=$((TEST_COUNT + 1))
    echo ""
    echo -e "${YELLOW}=== Test $TEST_COUNT: $1 ===${NC}"
}

test_pass() {
    PASS_COUNT=$((PASS_COUNT + 1))
    echo -e "${GREEN}PASS${NC}"
}

test_fail() {
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo -e "${RED}FAIL: $1${NC}"
    if [ "${EXIT_ON_FAIL:-true}" = "true" ]; then
        exit 1
    fi
}

# Check prerequisites
echo "================================================"
echo "  sitemgr Integration Tests"
echo "================================================"
echo ""

# Ensure Supabase is running (check if Kong gateway is up)
# Kong returns 404 for root path, but that means it's running
if ! curl -s http://localhost:54321 > /dev/null 2>&1; then
  echo "Error: Supabase not running on localhost:54321"
  echo "Start it with: ./scripts/local-dev.sh"
  exit 1
fi

# Load environment
if [ -f .env.local ]; then
    echo "Loading environment from .env.local..."
    # shellcheck disable=SC2046
    export $(grep -v '^#' .env.local | xargs)
else
    echo "Warning: .env.local not found. Run ./scripts/local-dev.sh first."
    # Set defaults
    export SUPABASE_URL=${SUPABASE_URL:-http://localhost:54321}
    export SUPABASE_SECRET_KEY=${SUPABASE_SECRET_KEY:-}
    export SMGR_S3_ENDPOINT=${SMGR_S3_ENDPOINT:-$SUPABASE_URL/storage/v1}
    export SMGR_S3_BUCKET=${SMGR_S3_BUCKET:-media}
    export SMGR_DEVICE_ID=${SMGR_DEVICE_ID:-test}
    export SMGR_AUTO_ENRICH=${SMGR_AUTO_ENRICH:-false}
fi

# Extract service role key if not set
if [ -z "$SUPABASE_SECRET_KEY" ]; then
    SUPABASE_SECRET_KEY=$(supabase status -o json 2>/dev/null | jq -r .service_role_key)
fi

echo "Supabase URL: $SUPABASE_URL"
echo "Storage Endpoint: $SMGR_S3_ENDPOINT"
echo "S3 Bucket: $SMGR_S3_BUCKET"
echo ""

# ============================================================
# Test 1: Stats on empty/existing database
# ============================================================
test_start "Stats query"

STATS=$(smgr stats)
echo "$STATS"

if echo "$STATS" | jq -e '.total_events' > /dev/null 2>&1; then
    test_pass
else
    test_fail "Stats command failed or returned invalid JSON"
fi

# ============================================================
# Test 2: Create test image and upload to storage
# ============================================================
test_start "Upload test image to Supabase Storage"

# Storage REST API endpoint (different from S3 API endpoint)
STORAGE_REST_API="$SUPABASE_URL/storage/v1"

# Cleanup: delete test file if it exists from previous run
curl -sf -X DELETE "$STORAGE_REST_API/object/$SMGR_S3_BUCKET/photos/test_integration.jpg" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null 2>&1 || true

# Create a minimal test JPEG (1x1 red pixel)
TEST_IMAGE_PATH="/tmp/test_image_$$.jpg"
echo '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=' | base64 -d > "$TEST_IMAGE_PATH"

# Upload via Supabase Storage REST API (not S3 API)
if UPLOAD_RESPONSE=$(curl -sf -X POST "$STORAGE_REST_API/object/$SMGR_S3_BUCKET/photos/test_integration.jpg" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: image/jpeg" \
  --data-binary "@$TEST_IMAGE_PATH" 2>&1); then
    echo "Upload successful"
    test_pass
else
    echo "Upload response: $UPLOAD_RESPONSE"
    test_fail "Failed to upload to Supabase Storage"
fi

rm -f "$TEST_IMAGE_PATH"

# ============================================================
# Test 3: Watch detects new S3 object
# ============================================================
test_start "S3 watcher detects new object"

smgr watch --once

# Check if event was created
STATS_AFTER=$(smgr stats)
echo "$STATS_AFTER"

TOTAL_EVENTS=$(echo "$STATS_AFTER" | jq -r '.total_events')
if [ "$TOTAL_EVENTS" -ge 1 ] 2>/dev/null; then
    test_pass
else
    test_fail "Expected at least 1 event after watch"
fi

# ============================================================
# Test 4: Query returns the uploaded photo
# ============================================================
test_start "Query returns uploaded photo"

QUERY_RESULT=$(smgr query --format json --type photo)
echo "$QUERY_RESULT"

if echo "$QUERY_RESULT" | jq -e '.events[0].id' > /dev/null 2>&1; then
    EVENT_ID=$(echo "$QUERY_RESULT" | jq -r '.events[0].id')
    echo "Found event: $EVENT_ID"
    test_pass
else
    test_fail "No events returned from query"
fi

# ============================================================
# Test 5: Show event details
# ============================================================
test_start "Show event details"

if [ -n "$EVENT_ID" ]; then
    SHOW_RESULT=$(smgr show "$EVENT_ID")
    echo "$SHOW_RESULT"

    if echo "$SHOW_RESULT" | jq -e '.id' > /dev/null 2>&1; then
        test_pass
    else
        test_fail "Failed to show event details"
    fi
else
    echo "Skipping (no event ID from previous test)"
    test_fail "No event ID available"
fi

# ============================================================
# Test 6: Database stats are consistent
# ============================================================
test_start "Database consistency check"

FINAL_STATS=$(smgr stats)
echo "$FINAL_STATS"

# Check for expected fields
if echo "$FINAL_STATS" | jq -e '.total_events' > /dev/null 2>&1 && \
   echo "$FINAL_STATS" | jq -e '.by_content_type' > /dev/null 2>&1; then
    test_pass
else
    test_fail "Stats output missing expected fields"
fi

# ============================================================
# Cleanup
# ============================================================
echo ""
echo "Cleaning up test artifacts..."
STORAGE_REST_API="$SUPABASE_URL/storage/v1"
curl -sf -X DELETE "$STORAGE_REST_API/object/$SMGR_S3_BUCKET/photos/test_integration.jpg" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null 2>&1 || true
echo "Done"

# ============================================================
# Summary
# ============================================================
echo ""
echo "================================================"
echo "  Test Summary"
echo "================================================"
echo "Total:  $TEST_COUNT"
echo -e "Passed: ${GREEN}$PASS_COUNT${NC}"
echo -e "Failed: ${RED}$FAIL_COUNT${NC}"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed${NC}"
    exit 1
fi
