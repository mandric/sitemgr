#!/bin/bash
# Seed test environment with realistic test data
# Creates sample photos and enrichments for testing

set -e

echo "================================================"
echo "  Seeding Test Data"
echo "================================================"
echo ""

# Load environment
if [ -f .env.local ]; then
    echo "Loading environment from .env.local..."
    export $(grep -v '^#' .env.local | xargs)
fi

# Check if Supabase is running
if ! curl -sf http://localhost:54321/health > /dev/null 2>&1; then
  echo "Error: Supabase not running. Start with: ./scripts/local-dev.sh"
  exit 1
fi

# Extract service role key if not set
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
    SUPABASE_SERVICE_ROLE_KEY=$(supabase status -o json 2>/dev/null | jq -r .service_role_key)
fi

SUPABASE_URL=${SUPABASE_URL:-http://localhost:54321}
STORAGE_ENDPOINT="$SUPABASE_URL/storage/v1"
BUCKET=${SMGR_S3_BUCKET:-media}

echo "Storage: $STORAGE_ENDPOINT"
echo "Bucket:  $BUCKET"
echo ""

# Ensure database is initialized
python3 prototype/smgr.py init

# Create fixtures directory if it doesn't exist
mkdir -p tests/fixtures/photos

# Generate test photos if they don't exist
# (Using base64-encoded 1x1 JPEGs with different "colors" for different test cases)
TEST_PHOTOS=(
    "bed_frame_broken.jpg"
    "wood_cutting.jpg"
    "glue_application.jpg"
    "clamping.jpg"
    "finished_repair.jpg"
)

echo "Creating test photo fixtures..."
for photo in "${TEST_PHOTOS[@]}"; do
    if [ ! -f "tests/fixtures/photos/$photo" ]; then
        # Create minimal JPEG (all will be same 1x1 red pixel for now)
        echo '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=' \
            | base64 -d > "tests/fixtures/photos/$photo"
        echo "  Created: $photo"
    else
        echo "  Exists:  $photo"
    fi
done

echo ""
echo "Uploading test photos to Supabase Storage..."
UPLOAD_COUNT=0

for photo in "${TEST_PHOTOS[@]}"; do
    echo -n "  $photo ... "

    RESPONSE=$(curl -sf -X POST "$STORAGE_ENDPOINT/object/$BUCKET/test-photos/$photo" \
        -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
        -H "Content-Type: image/jpeg" \
        --data-binary "@tests/fixtures/photos/$photo" 2>&1)

    if [ $? -eq 0 ]; then
        echo "✓"
        UPLOAD_COUNT=$((UPLOAD_COUNT + 1))
    else
        # Might already exist, try to check
        if echo "$RESPONSE" | grep -q "already exists"; then
            echo "✓ (already exists)"
            UPLOAD_COUNT=$((UPLOAD_COUNT + 1))
        else
            echo "✗ failed"
            echo "    Error: $RESPONSE"
        fi
    fi
done

echo ""
echo "Running watch to detect uploaded photos..."
python3 prototype/smgr.py watch --once

echo ""
echo "Checking stats..."
STATS=$(python3 prototype/smgr.py stats)
echo "$STATS" | jq .

# Check if enrichment is enabled and we have an API key
if [ "$SMGR_AUTO_ENRICH" = "true" ] && [ -n "$ANTHROPIC_API_KEY" ]; then
    echo ""
    echo "Enriching photos (this will use your Anthropic API key)..."
    python3 prototype/smgr.py enrich --pending
else
    echo ""
    echo "Skipping enrichment (SMGR_AUTO_ENRICH=$SMGR_AUTO_ENRICH)"
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        echo "Note: Set ANTHROPIC_API_KEY in .env.local to enable enrichment"
    fi
fi

echo ""
echo "================================================"
echo "  ✅ Test Data Seeded"
echo "================================================"
echo "Uploaded:     $UPLOAD_COUNT photos"
echo "Total events: $(echo "$STATS" | jq -r .total_events)"
echo ""
echo "Try these commands:"
echo "  python3 prototype/smgr.py query --type photo"
echo "  python3 prototype/smgr.py stats"
echo "  python3 prototype/bot.py --stdio"
echo ""
