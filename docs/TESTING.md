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
   echo $SITEMGR_S3_ENDPOINT
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

## Test Tiers

| Tier | Command | What it tests | Requires |
|------|---------|---------------|----------|
| **Unit** | `npm run test` | Pure logic (encryption, validation, retry, media-utils) | Nothing |
| **Integration** | `npm run test:integration` | Real services via direct calls + fetch() | Supabase + Next.js |
| **E2E CLI** | `npm run test:e2e:cli` | Full stack via CLI subprocess | Supabase + Next.js |
| **E2E Web** | `npm run test:e2e` | Full stack via Playwright browser | Supabase + Next.js + Chromium |

## Coverage Pipeline

Coverage is collected from all test tiers — both server-side (Node.js) and client-side (browser) — merged, and visible on the CI workflow summary page.

### Workflow Summary Page

Each CI job writes a coverage summary to GitHub Actions' Job Summary. Click any workflow run to see per-job coverage tables with file-level detail and links to uncovered lines. The Combined Coverage Report job merges all sources into one view.

### Artifacts

Every CI run uploads downloadable LCOV artifacts:
- `unit-coverage` — LCOV + HTML report from unit tests
- `integration-coverage` — LCOV + HTML report from integration tests
- `e2e-cli-coverage` — LCOV from E2E CLI server coverage
- `e2e-web-coverage` — LCOV from E2E Web server coverage
- `e2e-web-client-coverage` — LCOV from E2E Web browser coverage
- `combined-coverage` — Merged LCOV from all sources

### What Can and Can't Be Measured

| Test type | Coverage | How |
|-----------|----------|-----|
| Unit tests | Server | Vitest V8 coverage — tests call `lib/` functions directly |
| Integration (direct-call) | Server | Vitest V8 coverage — schema-contract, media-storage call `lib/` directly |
| Integration (fetch-based) | Server | `NODE_V8_COVERAGE` on the dev server — coverage flushed on exit, converted via `c8` |
| E2E CLI | Server | `NODE_V8_COVERAGE` on the dev server — same as integration |
| E2E Web | Server + Client | Server: `NODE_V8_COVERAGE`. Client: Playwright `page.coverage` API collects browser-side JS coverage via Chrome DevTools Protocol |

### What's Included in Coverage Reports

Coverage is scoped via `--coverage.include` to files where in-process testing is meaningful:

| Included | Why |
|----------|-----|
| `lib/**` | Core logic — encryption, DB queries, S3 operations, auth, validation, retry |
| `components/**` | React components with testable pure logic (e.g., `parseCodeFromUrl`) |
| `bin/**` | CLI entry point |

| `app/api/**` | Route handlers in the Next.js dev server — covered via `NODE_V8_COVERAGE` (server process writes V8 data on exit, converted by `c8`) |

| Excluded | Why |
|----------|-----|
| `app/**/page.tsx` | React pages rendered by Next.js, tested via Playwright (out-of-process) |
| `e2e/**`, `__tests__/**` | Test files themselves — not application code |

Coverage numbers reflect "what percentage of our application code is exercised by tests." Route handlers (`app/api/**`) are included via the dev server's `NODE_V8_COVERAGE` — the globalSetup spawns the server with this env var, and on teardown `c8` converts the V8 data to LCOV which is merged with vitest's in-process coverage.

### CI Permissions

The CI workflow follows least-privilege: `contents: read` and `pull-requests: write` at the workflow level. No job needs elevated permissions — coverage is reported via job summaries (no git push needed).

### How the Merge Works

1. Unit job runs vitest with `--coverage` producing LCOV for `lib/`, `components/`, `bin/`
2. Integration job runs vitest with `--coverage` (in-process) + captures dev server coverage via `NODE_V8_COVERAGE`
3. After integration tests, `c8 report` converts the server's V8 coverage to LCOV
4. `lcov -a vitest.lcov -a server.lcov` merges both into a single integration LCOV
5. The Combined Coverage Report job downloads unit + integration artifacts
6. `lcov -a unit.lcov -a integration.lcov -o combined.info` merges them
7. `genhtml` produces the browsable HTML report
8. A node script parses the combined LCOV for per-file stats and writes a job summary

### How Dev Server Coverage Works

The globalSetup (`__tests__/integration/globalSetup.ts`) spawns the Next.js dev server with `NODE_V8_COVERAGE=/tmp/v8-coverage-nextjs`. This is a built-in Node.js env var — when set, Node writes raw V8 coverage JSON to that directory when the process exits.

On teardown, the server receives SIGTERM and exits gracefully, flushing coverage data. In CI, `c8 report` then converts the V8 JSON to LCOV format, filtered to `app/api/**` and `lib/**`. This LCOV is merged with vitest's in-process coverage before uploading.

This means fetch-based integration tests (`api-*.test.ts`) now contribute real coverage data for route handlers — no Istanbul build step needed.
