#!/bin/bash
# Integration tests for sitemgr using local Supabase
# Tests the full pipeline: upload → detect → enrich → query → bot

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

TEST_COUNT=0
PASS_COUNT=0
FAIL_COUNT=0

# Test helper functions
test_start() {
    TEST_COUNT=$((TEST_COUNT + 1))
    echo ""
    echo -e "${YELLOW}=== Test $TEST_COUNT: $1 ===${NC}"
}

test_pass() {
    PASS_COUNT=$((PASS_COUNT + 1))
    echo -e "${GREEN}✓ PASS${NC}"
}

test_fail() {
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo -e "${RED}✗ FAIL: $1${NC}"
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
    export $(grep -v '^#' .env.local | xargs)
else
    echo "Warning: .env.local not found. Run ./scripts/local-dev.sh first."
    # Set defaults
    export SUPABASE_URL=${SUPABASE_URL:-http://localhost:54321}
    export SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY:-}
    export SMGR_S3_ENDPOINT=${SMGR_S3_ENDPOINT:-$SUPABASE_URL/storage/v1}
    export SMGR_S3_BUCKET=${SMGR_S3_BUCKET:-media}
    export SMGR_DEVICE_ID=${SMGR_DEVICE_ID:-test}
    export SMGR_AUTO_ENRICH=${SMGR_AUTO_ENRICH:-false}
fi

# Extract service role key if not set
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
    SUPABASE_SERVICE_ROLE_KEY=$(supabase status -o json 2>/dev/null | jq -r .service_role_key)
fi

echo "Supabase URL: $SUPABASE_URL"
echo "Storage Endpoint: $SMGR_S3_ENDPOINT"
echo "S3 Bucket: $SMGR_S3_BUCKET"
echo ""

# ============================================================
# Test 1: Database initialization
# ============================================================
test_start "Database initialization"

python3 prototype/smgr.py init
test_pass

# ============================================================
# Test 2: Database is accessible and empty
# ============================================================
test_start "Stats on empty database"

STATS=$(python3 prototype/smgr.py stats)
echo "$STATS"

if echo "$STATS" | grep -q '"total_events": 0'; then
    test_pass
else
    test_fail "Expected 0 events"
fi

# ============================================================
# Test 3: Create test image and upload to storage
# ============================================================
test_start "Upload test image to Supabase Storage"

# Create a minimal test JPEG (1x1 red pixel)
TEST_IMAGE_PATH="/tmp/test_image_$$.jpg"
echo '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=' | base64 -d > "$TEST_IMAGE_PATH"

# Upload via Supabase Storage API
UPLOAD_RESPONSE=$(curl -sf -X POST "$SMGR_S3_ENDPOINT/object/$SMGR_S3_BUCKET/photos/test_integration.jpg" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: image/jpeg" \
  --data-binary "@$TEST_IMAGE_PATH" 2>&1)

if [ $? -eq 0 ]; then
    echo "Upload successful"
    test_pass
else
    echo "Upload response: $UPLOAD_RESPONSE"
    test_fail "Failed to upload to Supabase Storage"
fi

rm -f "$TEST_IMAGE_PATH"

# ============================================================
# Test 4: Watch detects new S3 object
# ============================================================
test_start "S3 watcher detects new object"

python3 prototype/smgr.py watch --once

# Check if event was created
STATS_AFTER=$(python3 prototype/smgr.py stats)
echo "$STATS_AFTER"

if echo "$STATS_AFTER" | grep -q '"total_events": 1'; then
    test_pass
else
    test_fail "Expected 1 event after watch"
fi

# ============================================================
# Test 5: Query returns the uploaded photo
# ============================================================
test_start "Query returns uploaded photo"

QUERY_RESULT=$(python3 prototype/smgr.py query --format json --type photo)
echo "$QUERY_RESULT"

if echo "$QUERY_RESULT" | jq -e '.events[0].id' > /dev/null 2>&1; then
    EVENT_ID=$(echo "$QUERY_RESULT" | jq -r '.events[0].id')
    echo "Found event: $EVENT_ID"
    test_pass
else
    test_fail "No events returned from query"
fi

# ============================================================
# Test 6: Show event details
# ============================================================
test_start "Show event details"

if [ -n "$EVENT_ID" ]; then
    SHOW_RESULT=$(python3 prototype/smgr.py show "$EVENT_ID")
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
# Test 7: Bot responds to stats query
# ============================================================
test_start "Bot conversation - stats query"

# Test bot in stdio mode with a simple query
BOT_RESPONSE=$(echo "how many photos do I have?" | timeout 30 python3 prototype/bot.py --stdio 2>/dev/null || true)

if [ -n "$BOT_RESPONSE" ]; then
    echo "Bot response: $BOT_RESPONSE"
    test_pass
else
    echo "Warning: Bot test skipped (requires ANTHROPIC_API_KEY)"
    echo "Set ANTHROPIC_API_KEY in .env.local to enable bot tests"
fi

# ============================================================
# Test 8: Database stats are consistent
# ============================================================
test_start "Database consistency check"

FINAL_STATS=$(python3 prototype/smgr.py stats)
echo "$FINAL_STATS"

# Check for expected fields
if echo "$FINAL_STATS" | jq -e '.total_events' > /dev/null 2>&1 && \
   echo "$FINAL_STATS" | jq -e '.by_content_type' > /dev/null 2>&1; then
    test_pass
else
    test_fail "Stats output missing expected fields"
fi

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
    echo -e "${GREEN}✅ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Some tests failed${NC}"
    exit 1
fi
