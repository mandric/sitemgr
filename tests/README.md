# Integration Tests

This directory contains integration tests for sitemgr using Supabase local environment.

## Quick Start

### Local Development

```bash
# 1. Start Supabase local environment
./scripts/local-dev.sh

# 2. Load environment variables
source .env.local

# 3. Run integration tests
./tests/integration_test.sh

# 4. Seed test data (optional)
./tests/seed_test_data.sh
```

### What Gets Tested

The integration test suite validates:

- ✅ Database initialization
- ✅ Storage bucket creation
- ✅ Photo upload to Supabase Storage
- ✅ S3 watcher detection
- ✅ Event creation and querying
- ✅ Full-text search
- ✅ Bot conversation (if ANTHROPIC_API_KEY is set)
- ✅ Database consistency

## Test Structure

```
tests/
  integration_test.sh       # Main test suite
  seed_test_data.sh         # Populate with test data
  fixtures/
    photos/                 # Test images
    expected_enrichments/   # Expected LLM responses (future)
  README.md                 # This file
```

## Requirements

- Supabase CLI installed
- Python 3.12+
- jq (for JSON parsing)
- curl

### Installing Prerequisites

**macOS:**
```bash
brew install supabase/tap/supabase jq
```

**Ubuntu/Debian:**
```bash
# Supabase CLI
curl -fsSL https://raw.githubusercontent.com/supabase/supabase/master/install.sh | sh

# jq
sudo apt-get install jq
```

## Environment Variables

The test suite uses these environment variables (auto-configured by `local-dev.sh`):

```bash
SUPABASE_URL                  # Local Supabase API (http://localhost:54321)
SUPABASE_SERVICE_ROLE_KEY     # Admin key from supabase status
SMGR_S3_ENDPOINT              # Storage API endpoint
SMGR_S3_BUCKET                # Bucket name (default: media)
SMGR_DEVICE_ID                # Device identifier for tests
SMGR_AUTO_ENRICH              # Enable auto-enrichment (default: false)
ANTHROPIC_API_KEY             # Optional: for bot tests
```

## Running Tests

### Run All Tests
```bash
./tests/integration_test.sh
```

### Run Tests in CI Mode (fail fast)
```bash
EXIT_ON_FAIL=true ./tests/integration_test.sh
```

### Seed Test Data First
```bash
./tests/seed_test_data.sh
./tests/integration_test.sh
```

## Test Fixtures

### Creating Test Photos

The `seed_test_data.sh` script generates minimal test JPEGs. For realistic testing with actual photos:

1. Add real photos to `tests/fixtures/photos/`
2. Run the seed script to upload them

```bash
# Example: copy some test photos
cp ~/Pictures/test_photo_*.jpg tests/fixtures/photos/

# Upload them
./tests/seed_test_data.sh
```

### Test Data Naming Convention

Use descriptive names that indicate what the photo should contain:
- `bed_frame_broken.jpg` - Photo of damaged furniture
- `wood_cutting.jpg` - Woodworking process shot
- `finished_repair.jpg` - Completed project

This helps validate enrichment accuracy when implemented.

## Continuous Integration

The CI pipeline (`.github/workflows/ci.yml`) runs the same tests:

1. Starts Supabase local environment
2. Configures environment variables
3. Runs `integration_test.sh`
4. Tests Edge Function
5. Cleans up

### CI Environment

CI uses the same Supabase local setup as development:
- Same database schema (migrations applied)
- Same Storage API (S3-compatible)
- Same Edge Functions (Deno runtime)

**No MinIO or Docker Compose needed** - Supabase CLI provides everything.

## Troubleshooting

### Supabase not starting

```bash
# Check if already running
supabase status

# Stop and restart
supabase stop
supabase start
```

### Tests failing with "connection refused"

Ensure Supabase is running:
```bash
curl http://localhost:54321/health
```

### Storage upload fails

Check if the bucket exists:
```bash
source .env.local
curl -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  "$SUPABASE_URL/storage/v1/bucket"
```

### Bot tests skipped

Bot tests require an Anthropic API key:
```bash
# Add to .env.local
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env.local
source .env.local
```

## Adding New Tests

1. Add test scenario to `integration_test.sh`:
```bash
test_start "Your test name"
# ... test code ...
if [ condition ]; then
    test_pass
else
    test_fail "Error message"
fi
```

2. Test locally:
```bash
./tests/integration_test.sh
```

3. Commit and push (CI will run automatically)

## Performance

Integration tests typically take **30-60 seconds** to run:
- Supabase startup: ~10s (cached in CI)
- Test execution: ~20-30s
- Cleanup: ~5s

For faster iteration during development, keep Supabase running and run individual test commands directly.

## Future Enhancements

- [ ] Mock LLM responses for enrichment tests
- [ ] Performance benchmarks (query speed, upload throughput)
- [ ] Edge Function POST webhook tests
- [ ] Multi-device event handling tests
- [ ] Storage quota and error handling tests
- [ ] Bot conversation flow validation
