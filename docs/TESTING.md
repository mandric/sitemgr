# Testing Strategy

This document outlines the testing approach for sitemgr, with a focus on integration testing and local/CI environment parity.

## Philosophy

**Test through our code, not infrastructure directly**

Integration tests call our application layer — TypeScript modules (`db.ts`, `s3.ts`), HTTP API routes (`/api/*`), and CLI commands. They do NOT call Supabase SDK, raw SQL, or AWS SDK directly in test assertions.

- Queries go through `queryEvents()`, `getStats()`, `getEnrichStatus()` from `db.ts`
- Writes go through `insertEvent()`, `insertEnrichment()`, `upsertWatchedKey()` from `db.ts`
- S3 operations go through `uploadS3Object()`, `listS3Objects()`, `downloadS3Object()` from `s3.ts`
- HTTP endpoints are tested via `fetch("/api/...")` against the running Next.js dev server

**Exception:** Test-only setup/teardown (creating auth users, seeding bulk data, cleanup) can use the Supabase admin SDK directly — this is test infrastructure, not app behavior.

**Why:** If tests call Supabase directly, we're only proving Supabase works. By going through our code, we validate our retry logic, error handling, client factories, query builders, and type contracts. A passing test means our app works, not just our database.

**Integration tests over unit tests** (for now)

The prototype phase prioritizes end-to-end validation over comprehensive unit test coverage. We test the full pipeline (upload → detect → enrich → query → bot) in an environment that mirrors production.

**Benefits:**
- Validates real system behavior through our actual code paths
- Catches integration issues early
- Same tests run locally and in CI
- Faster to write and maintain initially
- Tests actual user workflows

**Trade-offs:**
- Slower than unit tests
- Harder to isolate failures
- Requires external dependencies (Supabase, Next.js dev server)

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
cd web && npm run setup:supabase && npm run setup:env  # Start Supabase + generate .env.local
cd .. && source .env.local                             # Load environment variables
```

**Workflow:**
```bash
# Terminal 1: Keep Supabase running
supabase start

# Terminal 2: Run integration tests
./scripts/test-integration.sh --skip-ollama
```

**Reset:**
```bash
supabase db reset         # Wipes and replays all migrations; .env.local is unaffected
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

The canonical integration test runner is `./scripts/test-integration.sh`, which sources `.env.local` automatically and runs the vitest integration project under `web/__tests__/integration/`.

### Running Tests

**Integration tests (requires Supabase running):**
```bash
./scripts/test-integration.sh --skip-ollama
```

**With Ollama enrichment (optional):**
```bash
./scripts/test-integration.sh
```

**Unit tests only (no Supabase required):**
```bash
cd web && npm test
```

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

Integration tests create and destroy their own isolated data per run. No manual seeding is required. To reset the local database:

```bash
supabase db reset    # Wipes and replays all migrations
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

3. **Check environment health:**
   ```bash
   ./scripts/setup/verify.sh
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

**Test framework:** `vitest` (already in use for unit tests)

**Coverage target:** 60-80% for stable components

## Metrics

### Current Coverage (Estimate)

| Component | Integration | Unit | Total |
|-----------|-------------|------|-------|
| smgr CLI (TypeScript) | 30% | 0% | 30% |
| API routes / webhooks | 10% | 0% | 10% |
| Database / migrations | 40% | N/A | 40% |
| **Overall** | **~20%** | **0%** | **~20%** |

### Target Coverage (3 months)

| Component | Integration | Unit | Total |
|-----------|-------------|------|-------|
| smgr CLI (TypeScript) | 60% | 40% | 70% |
| API routes / webhooks | 40% | 30% | 50% |
| Database / migrations | 70% | N/A | 70% |
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
