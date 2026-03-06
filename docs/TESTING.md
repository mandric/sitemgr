# Testing Strategy

This document outlines the testing approach for sitemgr, with a focus on integration testing and local/CI environment parity.

## Philosophy

**Integration tests over unit tests** (for now)

The prototype phase prioritizes end-to-end validation over comprehensive unit test coverage. We test the full pipeline (upload → detect → enrich → query → bot) in an environment that mirrors production.

**Benefits:**
- ✅ Validates real system behavior
- ✅ Catches integration issues early
- ✅ Same tests run locally and in CI
- ✅ Faster to write and maintain initially
- ✅ Tests actual user workflows

**Trade-offs:**
- ❌ Slower than unit tests
- ❌ Harder to isolate failures
- ❌ Requires external dependencies (Supabase)

Unit tests will be added as components stabilize and edge cases are discovered.

## Architecture: Supabase Local Environment

### What Supabase Local Provides

Running `supabase start` gives you a **complete local stack**:

```
Component              Port    Purpose
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PostgreSQL             54322   Event store + FTS
PostgREST API          54321   REST API for database
Storage API (S3)       54321   S3-compatible blob storage
Edge Functions         54321   Deno runtime for webhooks
Supabase Studio        54323   Web UI for management
Inbucket (email)       54324   Email testing (future)
```

### Why This Approach?

**Before (problematic):**
- Local Postgres + separate MinIO + Docker Compose
- Different setup for CI vs local
- Edge Functions not testable locally
- Complex environment management

**After (unified):**
- One command: `supabase start`
- Same environment locally, in CI, and production
- All components work together
- Simple, standardized workflow

## Test Environments

### 1. Local Development

**Purpose:** Rapid iteration, debugging, experimentation

**Setup:**
```bash
./scripts/local-dev.sh    # Starts Supabase + configures environment
source .env.local         # Load environment variables
```

**Workflow:**
```bash
# Terminal 1: Keep Supabase running
supabase start

# Terminal 2: Run tests
./tests/integration_test.sh

# Terminal 3: Interactive testing
python3 prototype/smgr.py watch
python3 prototype/bot.py --stdio
```

**Reset:**
```bash
supabase db reset         # Reset database to migrations
./tests/seed_test_data.sh # Re-populate with test data
```

### 2. Continuous Integration (GitHub Actions)

**Purpose:** Validate every commit, prevent regressions

**Workflow (`.github/workflows/ci.yml`):**
1. Lint Python code
2. Start Supabase local environment
3. Apply migrations
4. Run integration test suite
5. Test Edge Function
6. Report results

**Same environment as local** - tests pass locally → tests pass in CI

### 3. Test Deployment (Supabase Cloud)

**Purpose:** Persistent test environment for manual validation

**Setup:** Auto-deployed when you push to `develop` branch

**Workflow (`.github/workflows/deploy-supabase.yml`):**
1. Deploy database migrations
2. Deploy Edge Functions
3. Configure Twilio webhook
4. Seed test data
5. Run smoke tests
6. Output test environment URLs

**Result:** Live test environment you can interact with via WhatsApp

## Integration Test Suite

### Coverage

**Current tests (`tests/integration_test.sh`):**

| Test | What It Validates |
|------|-------------------|
| Database init | Migrations apply successfully |
| Stats query | Database is queryable |
| Storage upload | Supabase Storage API works |
| S3 watcher | Detects new objects in bucket |
| Event creation | Events are created correctly |
| Query by type | Content type filtering works |
| Show event | Event detail retrieval works |
| Bot conversation | Natural language → query translation |
| Stats consistency | Database state is coherent |

**Future tests (roadmap):**
- [ ] Enrichment with mock LLM
- [ ] Full-text search ranking
- [ ] Edge Function POST webhook handling
- [ ] Multi-device event handling
- [ ] Error recovery (API failures, network errors)
- [ ] Performance benchmarks

### Running Tests

**Quick validation:**
```bash
./tests/integration_test.sh
```

**With fresh test data:**
```bash
./tests/seed_test_data.sh
./tests/integration_test.sh
```

**Individual test scenario:**
```bash
# Edit integration_test.sh to comment out tests you don't want
# Or extract specific commands
source .env.local
python3 prototype/smgr.py init
python3 prototype/smgr.py stats
```

### Test Fixtures

**Location:** `tests/fixtures/photos/`

**Current:** Minimal 1x1 JPEG placeholders (for speed)

**To add real photos:**
```bash
cp ~/Pictures/test_*.jpg tests/fixtures/photos/
./tests/seed_test_data.sh
```

**Naming convention:** Use descriptive names that indicate expected content:
- `bed_frame_broken.jpg` - Should be recognized as furniture damage
- `wood_cutting.jpg` - Should be recognized as woodworking
- `finished_repair.jpg` - Should be recognized as completed project

This enables validating enrichment accuracy when implemented.

## Deployment Testing

### Test Environment Auto-Deploy

**Trigger:** Push to `develop` branch

**What happens:**
1. Migrations deployed to Supabase cloud project
2. Edge Functions deployed
3. Twilio webhook auto-configured
4. Test data seeded (5 sample photos)
5. Smoke test runs
6. Deployment summary posted

**Result:** You can immediately WhatsApp the bot and test real workflows

**Example interaction:**
```
You: how many photos do I have?
Bot: You have 5 photos in your library.

You: show me photos about woodworking
Bot: Found 3 photos:
     - bed_frame_broken.jpg (damaged furniture)
     - wood_cutting.jpg (cutting lumber)
     - finished_repair.jpg (completed project)
```

### Manual Testing Checklist

After deployment, validate:
- [ ] WhatsApp bot responds to messages
- [ ] Stats query returns correct counts
- [ ] Search finds uploaded photos
- [ ] Edge Function logs show no errors
- [ ] Storage bucket contains test photos

**Check Edge Function logs:**
```bash
supabase functions logs whatsapp --project-ref <your-ref>
```

**Check database:**
```bash
supabase db dump --project-ref <your-ref>
```

## Test Data Management

### Seeding Test Data

**Purpose:** Populate environment with realistic data for testing

**Script:** `tests/seed_test_data.sh`

**What it does:**
1. Generates test photos (or uses existing fixtures)
2. Uploads to Supabase Storage
3. Runs `smgr watch` to detect uploads
4. Optionally enriches photos (if API key configured)

**Usage:**
```bash
# Seed with default fixtures
./tests/seed_test_data.sh

# Check what was created
python3 prototype/smgr.py stats
python3 prototype/smgr.py query --type photo
```

### Reset Test Data

**Local:**
```bash
supabase db reset
./tests/seed_test_data.sh
```

**Cloud test environment:**
```bash
# Reset database
supabase db reset --linked

# Or re-run deployment
git push origin develop --force-with-lease
```

## Debugging Failed Tests

### Test fails locally

1. **Check Supabase is running:**
   ```bash
   supabase status
   curl http://localhost:54321/health
   ```

2. **Check environment variables:**
   ```bash
   source .env.local
   echo $SUPABASE_URL
   echo $SMGR_S3_ENDPOINT
   ```

3. **Run test commands manually:**
   ```bash
   python3 prototype/smgr.py init
   python3 prototype/smgr.py stats
   ```

4. **Check Supabase logs:**
   ```bash
   supabase logs
   ```

### Test fails in CI

1. **Check workflow logs** in GitHub Actions
2. **Look for differences** between local and CI environment
3. **Verify migrations** applied successfully
4. **Check service availability** (all ports bound correctly)

### Common Issues

**"Connection refused"**
- Supabase not started
- Wrong port in environment variable
- Firewall blocking localhost

**"Bucket not found"**
- Storage bucket not created
- Wrong bucket name in config
- Storage API not accessible

**"No events found"**
- Watch command didn't run
- Upload failed silently
- Database not initialized

## Future: Unit Tests

As components stabilize, add unit tests for:

**Priority 1: Core logic**
- SHA-256 content hashing
- Content type detection
- Image dimension extraction
- Query builder (FTS)
- Event schema validation

**Priority 2: Error handling**
- API timeouts and retries
- Network failures
- Malformed data handling
- Constraint violations

**Priority 3: Provider abstractions**
- Enrichment provider interface
- Storage provider interface
- Query provider interface

**Test framework:** `pytest` with fixtures and mocking

**Coverage target:** 60-80% for stable components

## Metrics

### Current Coverage (Estimate)

| Component | Integration | Unit | Total |
|-----------|-------------|------|-------|
| smgr.py CLI | 30% | 0% | 30% |
| bot.py | 10% | 0% | 10% |
| Edge Function | 5% | 0% | 5% |
| Database | 40% | N/A | 40% |
| **Overall** | **~20%** | **0%** | **~20%** |

### Target Coverage (3 months)

| Component | Integration | Unit | Total |
|-----------|-------------|------|-------|
| smgr.py CLI | 60% | 40% | 70% |
| bot.py | 40% | 30% | 50% |
| Edge Function | 50% | 30% | 60% |
| Database | 70% | N/A | 70% |
| **Overall** | **~55%** | **~25%** | **~65%** |

### Success Metrics

**Reliability:**
- CI pass rate > 95%
- Zero flaky tests
- Test runtime < 2 minutes

**Confidence:**
- Can deploy to production with passing CI
- Regressions caught before merge
- Edge cases documented and tested

**Velocity:**
- Tests don't slow down development
- Easy to add new test cases
- Quick feedback loop (< 30s locally)

## Resources

- [Supabase CLI Docs](https://supabase.com/docs/guides/cli)
- [Supabase Local Development](https://supabase.com/docs/guides/cli/local-development)
- [Integration Testing Best Practices](https://martinfowler.com/bliki/IntegrationTest.html)
- [Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html)
