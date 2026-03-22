# Integration Tests Setup - Quick Start

I've built a complete integration testing setup using Supabase local environment. Here's what you have and how to use it.

## What's New

### ✅ Files Created

```
scripts/
  local-dev.sh              # One-command local environment setup

scripts/
  test-integration.sh      # Integration test runner (sources .env.local automatically)

.github/workflows/
  ci.yml                   # Updated to use Supabase local (not MinIO)

docs/
  TESTING.md               # Complete testing strategy doc
```

### ✅ What Changed

**CI Workflow:**
- ❌ Old: `supabase db start` (Postgres only) + MinIO + Docker Compose
- ✅ New: `supabase start` (full stack) - one unified environment

**Benefits:**
- Same environment locally and in CI
- Tests Postgres + Storage + Edge Functions together
- No Docker Compose needed for testing
- Faster, simpler, more reliable

## Quick Start (Local)

### 0. Install uv (First Time Only)

```bash
# Install uv (fast Python package installer)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Or with Homebrew
brew install uv
```

### 1. Setup Python Environment

```bash
# One command: creates venv + installs dependencies
./scripts/setup.sh
```

### 2. Start Supabase and Configure Environment

```bash
# Activate virtual environment
source .venv/bin/activate

# Start Supabase and create .env.local
./scripts/local-dev.sh
```

This will:
- Start Supabase (Postgres + Storage + Edge Functions)
- Create storage bucket
- Generate `.env.local` with all configuration
- Show you next steps

### 3. Load Environment Variables

```bash
source .env.local
```

### 4. Run Integration Tests

```bash
./scripts/test-integration.sh --skip-ollama
```

Expected output:
```
=== Test 1: Database initialization ===
✓ PASS

=== Test 2: Stats on empty database ===
✓ PASS

=== Test 3: Upload test image to Supabase Storage ===
✓ PASS

... (8 tests total)

================================================
  Test Summary
================================================
Total:  8
Passed: 8
Failed: 0

✅ All tests passed!
```

### 5. (Optional) Seed Test Data

```bash
```

This uploads 5 test photos and creates events.

### 6. Play with the App

```bash
# Check stats
cd web && npx smgr stats

# Query photos
cd web && npx smgr query --type photo

# Test the bot (interactive)
# (bot.py removed — now Vercel API routes) --stdio
```

## Quick Start (CI)

### Run Tests in CI

Tests run automatically on every push/PR. To manually trigger:

```bash
git commit -m "Test integration tests"
git push
```

Check GitHub Actions for results.

### What CI Tests

Same tests as local:
1. ✅ Database initialization
2. ✅ FTS search
3. ✅ Storage upload
4. ✅ S3 watcher detection
5. ✅ Event creation
6. ✅ Query functionality
7. ✅ Bot conversation (if API key set)
8. ✅ Edge Function health

## Environment Variables

### Required (Auto-configured)

```bash
SUPABASE_URL                  # http://localhost:54321
SUPABASE_SERVICE_ROLE_KEY     # From supabase status
SMGR_S3_ENDPOINT              # Storage API endpoint
SMGR_S3_BUCKET                # media
```

### Optional

```bash
ANTHROPIC_API_KEY             # For bot tests and enrichment
SMGR_AUTO_ENRICH=true         # Enable auto-enrichment
```

**To enable enrichment/bot:**

Edit `.env.local` and add:
```bash
ANTHROPIC_API_KEY=sk-ant-your-key-here
SMGR_AUTO_ENRICH=true
```

Then reload:
```bash
source .env.local
```

## Common Commands

### Local Development

```bash
# Start environment (once)
./scripts/local-dev.sh

# Load variables (each new terminal)
source .env.local

# Run tests (anytime)
./scripts/test-integration.sh --skip-ollama

# Reset database
supabase db reset

# Re-seed data

# Stop Supabase
supabase stop
```

### Debugging

```bash
# Check Supabase status
supabase status

# View logs
supabase logs

# Check if API is responding
curl http://localhost:54321/health

# View Studio (web UI)
open http://localhost:54323
```

## What Gets Tested

### Integration Test Coverage

| Component | Tested |
|-----------|--------|
| Database schema | ✅ Migrations applied |
| Storage API | ✅ Upload, bucket creation |
| S3 watcher | ✅ Detects new objects |
| Event creation | ✅ Creates and retrieves |
| Query system | ✅ Filters, search |
| FTS search | ✅ Postgres tsvector |
| Bot | ✅ Basic conversation |
| Edge Function | ✅ Health check |

### Not Yet Tested

- ❌ Enrichment pipeline (mock LLM needed)
- ❌ Edge Function POST webhook
- ❌ Error handling (API failures)
- ❌ Performance/load
- ❌ Multi-device scenarios

## Next Steps

### Play with the App

1. **Start environment:** `./scripts/local-dev.sh`
3. **Try the CLI:**
   ```bash
   cd web && npx smgr stats
   cd web && npx smgr query --type photo
   cd web && npx smgr show <event-id>
   ```
4. **Try the bot:**
   ```bash
   # (bot.py removed — now Vercel API routes) --stdio
   # Type: "how many photos do I have?"
   # Type: "show me photos"
   ```

### Deploy Test Environment

Push to `develop` branch to auto-deploy:

```bash
git checkout -b develop
git push origin develop
```

This will:
- Deploy to your Supabase project
- Configure Twilio webhook
- Seed test data
- Run smoke tests

Then you can WhatsApp the bot!

### Add More Tests

Edit the vitest integration tests under `web/__tests__/integration/`:

```bash
test_start "Your new test"
# ... test code ...
if [ condition ]; then
    test_pass
else
    test_fail "Error message"
fi
```

### Add Real Test Photos

```bash
# Copy photos to fixtures
cp ~/Pictures/test*.jpg tests/fixtures/photos/

# Upload them
```

## Troubleshooting

### "Supabase not running"

```bash
supabase start
```

### "Bucket not found"

```bash
./scripts/local-dev.sh  # Recreates bucket
```

### "Tests fail in CI but pass locally"

Check:
- Environment variables match
- Migrations applied in both
- Same Supabase CLI version

### "Bot tests skipped"

Set `ANTHROPIC_API_KEY` in `.env.local`

## Documentation

- **Testing strategy:** `docs/TESTING.md`
- **Test suite details:** `docs/TESTING.md`
- **Architecture:** `design/architecture.md`

## Summary

You now have:
- ✅ Complete local dev environment (one command)
- ✅ Integration test suite (8 tests)
- ✅ CI pipeline (same environment as local)
- ✅ Test data seeding
- ✅ Documentation

**Try it now:**

```bash
./scripts/local-dev.sh
source .env.local
./scripts/test-integration.sh --skip-ollama
```

If tests pass, you're ready to build! 🚀
