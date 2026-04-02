# Implementation Plan: Test Suite Reorganization (Spec 20)

## Background

The sitemgr test suite has ~41 test files with two structural problems. First, ~18 "unit" tests mock Supabase, S3, and encryption so heavily they verify call ordering rather than catching real bugs. Second, two CLI subprocess tests (`sitemgr-cli.test.ts`, `sitemgr-e2e.test.ts`) live in the integration tier but test through the user-facing CLI interface — they're E2E tests by definition.

The goal is to reorganize into four tiers that match the testing philosophy in CLAUDE.md: Unit (pure logic), Integration (real services), E2E CLI (CLI subprocess), and E2E Web (Playwright browser).

## Architecture: Four Test Tiers

### Tier 1: Unit (`npm run test`)
Pure logic, no service dependencies, no Docker. Tests that use `vi.stubEnv()` for environment are fine; tests that mock Supabase/S3 clients are not.

**Kept tests:** encryption.test.ts, encryption-rotation.test.ts, encryption-versioned.test.ts, validation.test.ts, retry.test.ts, media-utils.test.ts, device-codes.test.ts

**Borderline (evaluate individually):**
- `logger.test.ts` — uses `vi.spyOn(console)`, not heavy mocking. Keep as unit.
- `request-context.test.ts` — tests async context (AsyncLocalStorage). Keep as unit.
- `cli-open-browser.test.ts` — mocks `child_process.exec` to test platform detection. Keep as unit — testing the platform-detection logic, not a service.
- `device-approve-form.test.ts` — no `vi.mock` blocks. Keep if pure, evaluate if it renders React components.

### Tier 2: Integration (`npm run test:integration`)
Real Supabase + Next.js dev server. Direct function calls and `fetch()` with Bearer tokens.

**Existing (unchanged):** schema-contract, tenant-isolation, media-lifecycle, media-storage, device-auth, device-codes-schema, auth-smoke, model-configs, webhook-service-account

**New API route integration tests** (replaces mock-heavy unit tests):
- `api-bucket-routes.test.ts` — Bucket CRUD via `fetch()` against Next.js
- `api-events-routes.test.ts` — Events query, show, by-hash, filtering
- `api-stats-routes.test.ts` — Stats with bucket filtering, enrichment status
- `api-health-route.test.ts` — Health check against real dev server
- `api-enrichment-routes.test.ts` — Enrichment status and pending endpoints

Authentication pattern: `createTestUser()` for setup → extract `session.access_token` → `fetch(url, { headers: { Authorization: 'Bearer <token>' } })`.

### Tier 3: E2E CLI (`npm run test:e2e:cli`)
CLI subprocess tests. Spawns `tsx bin/sitemgr.ts`, tests through the user-facing CLI binary.

**Reclassified from integration:**
- `sitemgr-cli.test.ts` → merged into `e2e-cli/sitemgr-commands.test.ts`
- `sitemgr-e2e.test.ts` → merged into `e2e-cli/sitemgr-pipeline.test.ts`
- `sitemgr-cli-auth.test.ts` — stays as a unit test (it's at `__tests__/sitemgr-cli-auth.test.ts`, not in integration/; it's static analysis of source code, not a CLI E2E test)

**Overlap resolution:** Tests in `sitemgr-cli.test.ts` that just verify API response shapes through the CLI wrapper (stats, query, show) should be simplified or removed if the same routes are now covered by Tier 2 API route tests. Keep CLI-specific behavior: arg parsing, exit codes, output formatting, credential handling.

### Tier 4: E2E Web (`npm run test:e2e`)
Playwright browser tests. No changes — already correctly classified.

## Section 1: New API Route Integration Tests

### Helper: Bearer Token Authentication

Add a helper to `setup.ts` that returns a user's access token for `fetch()` calls:

```typescript
export async function createTestUserWithToken(email?: string): Promise<{
  userId: string;
  client: SupabaseClient;
  accessToken: string;
}>
```

This calls `createTestUser()`, then extracts the access token from the session via `client.auth.getSession()`. Must assert that `session` is non-null (sign-in could silently fail) and throw a clear error if it is.

### Helper: API fetch wrapper

A thin helper in the test file (not a shared utility) that builds fetch URLs against the dev server:

```typescript
function apiFetch(path: string, token: string, init?: RequestInit): Promise<Response>
```

Constructs URL from `http://localhost:${process.env.WEB_PORT ?? '3000'}` + path, adds `Authorization: Bearer ${token}` header. Uses `WEB_PORT` for consistency with `globalSetup.ts`.

### Test File: `api-bucket-routes.test.ts`

Tests against `GET/POST /api/buckets`, `DELETE /api/buckets/[id]`, `POST /api/buckets/[id]/test`.

Setup: `createTestUserWithToken()` + seed a bucket config via `POST /api/buckets`.

Test cases:
- `POST /api/buckets` — create bucket config, verify 200 + returned shape
- `GET /api/buckets` — list buckets, verify contains created bucket
- `DELETE /api/buckets/[id]` — remove bucket, verify 200
- `GET /api/buckets` after delete — verify empty
- `POST /api/buckets/[id]/test` — test connectivity using local Supabase S3 (use `getS3Config()` values for the test bucket config, expect 200 success)
- `GET /api/buckets` without auth — verify 401
- `DELETE /api/buckets/[id]` for wrong user — verify 404 or 403

### Test File: `api-events-routes.test.ts`

Tests against `GET /api/events`, `GET /api/events/[id]`, `GET /api/events/by-hash/[hash]`.

Setup: `createTestUserWithToken()` + seed events via `admin.from('events').insert(...)`.

Test cases:
- `GET /api/events` — list events for user
- `GET /api/events?bucket_config_id=X` — filter by bucket
- `GET /api/events?limit=1` — limit results
- `GET /api/events/[id]` — get single event with enrichment
- `GET /api/events/by-hash/[hash]` — lookup by content hash
- `GET /api/events/[id]` with wrong user — verify 404/empty
- `GET /api/events` without auth — verify 401

### Test File: `api-stats-routes.test.ts`

Tests against `GET /api/stats`.

Setup: `createTestUserWithToken()` + seed events and enrichments.

Test cases:
- `GET /api/stats` — verify event counts, enrichment counts
- `GET /api/stats?bucket_config_id=X` — filtered stats
- `GET /api/stats` without auth — verify 401

### Test File: `api-enrichment-routes.test.ts`

Tests against `GET /api/enrichments`, `GET /api/enrichments/status`, `GET /api/enrichments/pending`.

Setup: `createTestUserWithToken()` + seed events, some with enrichments, some without.

Test cases:
- `GET /api/enrichments/status` — counts of enriched vs pending
- `GET /api/enrichments/pending` — list unenriched events
- `GET /api/enrichments` — list all enrichments for user
- Without auth — verify 401

### Test File: `api-health-route.test.ts`

Simple test that `GET /api/health` returns 200. No auth needed.

## Section 2: Delete Mock-Heavy Unit Tests

After integration tests from Section 1 are green, delete mock-heavy unit tests whose code paths are now covered.

**Delete these files:**
- `__tests__/health-route.test.ts` — replaced by `api-health-route.test.ts`
- `__tests__/db-operations.test.ts` — DB queries covered by integration tests
- `__tests__/s3-actions.test.ts` — S3 operations covered by media-storage + pipeline tests
- `__tests__/agent-core.test.ts` — agent flow covered by integration + E2E CLI pipeline
- `__tests__/agent-actions.test.ts` — agent actions covered by integration tests
- `__tests__/enrichment.test.ts` — enrichment covered by E2E pipeline + enrichment route tests
- `__tests__/whatsapp-route.test.ts` — webhook covered by webhook-service-account integration test
- `__tests__/device-approve-route.test.ts` — device auth covered by device-auth integration test
- `__tests__/device-initiate-route.test.ts` — same
- `__tests__/device-token-route.test.ts` — same
- `__tests__/encryption-lifecycle.test.ts` — real crypto in encryption.test.ts + DB roundtrip in integration
- `__tests__/s3-client.test.ts` — client construction tested indirectly by media-storage integration
- `__tests__/supabase-client.test.ts` — mocks `@supabase/supabase-js` createClient; tests mock wiring, not real behavior
- `__tests__/instrumentation.test.ts` — mocks OpenTelemetry, low value
- `__tests__/phone-migration-app.test.ts` — mocks Supabase, migration is one-time

**Delete shared mock helper:**
- `__tests__/helpers/agent-test-setup.ts` — mock infrastructure no longer needed

**Keep as unit tests (pure logic or light mocking):**
- `logger.test.ts` — spyOn console, tests formatting logic
- `request-context.test.ts` — tests AsyncLocalStorage patterns
- `cli-open-browser.test.ts` — tests platform detection logic
- `device-approve-form.test.ts` — keep `parseCodeFromUrl` tests (pure logic), delete `approveDevice` tests (mocks fetch)
- `sitemgr-login-command.test.ts` — minimal, keep if it tests pure logic

**Evaluate (may need integration replacement first):**
- `api-auth.test.ts` — mocks multiple deps; if auth middleware is tested by all API route tests, delete
- `cli-auth-device-flow.test.ts` — mocks child_process + fetch; device flow tested by device-auth integration test. If the test covers CLI-specific credential file logic, keep. Otherwise delete.

## Section 3: Reclassify CLI Tests as E2E

### New Directory Structure

```
web/__tests__/e2e-cli/
  sitemgr-commands.test.ts    # Merged from sitemgr-cli.test.ts
  sitemgr-pipeline.test.ts    # From sitemgr-e2e.test.ts
```

Note: `sitemgr-cli-auth.test.ts` stays as a unit test — it's static analysis, not E2E.

### Vitest Configuration

Add a third project to `vitest.config.ts`:

```typescript
{
  extends: true,
  test: {
    name: "e2e-cli",
    globals: true,
    environment: "node",
    include: ["__tests__/e2e-cli/**/*.test.ts"],
    testTimeout: 120000,  // CLI tests need longer timeouts
    hookTimeout: 60000,
    globalSetup: ["__tests__/integration/globalSetup.ts"],  // reuse
    fileParallelism: false,
  },
}
```

### Package.json Script

Add: `"test:e2e:cli": "vitest run --project e2e-cli"`

Update `test:all` to include all three vitest projects.

### Merging CLI Tests

**`sitemgr-commands.test.ts`** (from `sitemgr-cli.test.ts`):
- Keep: help/usage, exit codes, arg parsing, output formatting (table vs JSON)
- Keep: credential file handling tests
- Simplify or remove: `stats`, `query`, `show` tests that just verify API response shapes (now covered by API route integration tests). Keep only tests that verify CLI-specific formatting of those responses.

**`sitemgr-pipeline.test.ts`** (from `sitemgr-e2e.test.ts`):
- Keep the full pipeline: watch → enrich → search
- Ollama should be available in the test environment per stakeholder decision
- Keep as sequential tests with long timeouts (up to 300s for enrichment)

### Remove From Integration

Delete old files from `__tests__/integration/`:
- `sitemgr-cli.test.ts`
- `sitemgr-e2e.test.ts`

### Vitest Config Exclusion

When adding the e2e-cli project to `vitest.config.ts`, also add `__tests__/e2e-cli/**` to the unit project's `exclude` list. This prevents the unit runner from picking up e2e-cli tests (which would fail without services). Do this in the same config change, not as a later cleanup step.

## Section 4: Verification and Cleanup

### All Tests Green

After all changes, verify:

1. `npm run test` — unit tests pass (mock-heavy tests deleted, pure logic tests remain)
2. `npm run test:integration` — integration tests pass (new API route tests + existing DB tests)
3. `npm run test:e2e:cli` — CLI E2E tests pass (reclassified from integration)
4. `npm run test:e2e` — Playwright tests unchanged
5. `npm run typecheck` — no type errors
6. `npm run lint` — no lint errors
7. `npm run build` — build succeeds

### CI Integration

`test:all` runs `vitest run` which executes all vitest projects. Adding e2e-cli as a project means it runs in `test:all`. For CI, the new tier is automatically included without CI config changes.

### Test Data Isolation

All new API route integration tests must:
- Create a unique test user per test file via `createTestUser()` (unique email with `Date.now()`)
- Clean up all data in `afterAll` via `cleanupUserData()`
- Never rely on data from other test files

## Execution Order

1. Write API route integration tests (Section 1)
2. Run new integration test files individually — verify they pass before running full suite
3. Delete mock-heavy unit tests (Section 2)
4. Run unit tests — verify remaining pass
5. Create e2e-cli directory and vitest project (Section 3)
6. Move + merge CLI tests into e2e-cli
7. Remove old CLI test files from integration
8. Run all four tiers — verify everything passes
9. Final cleanup (Section 4)

## Risks and Mitigations

**Risk:** API routes may have inconsistent error response shapes, making integration tests brittle.
**Mitigation:** Read each route handler before writing tests. Test status codes, not exact error messages.

**Risk:** Deleting mock-heavy tests removes coverage that integration tests don't fully replace.
**Mitigation:** Write integration tests first (Pass 1), verify coverage before deleting (Pass 2). For any edge case that's hard to test via integration, extract the pure logic and keep a unit test for it.

**Risk:** CLI E2E tests depend on Next.js dev server + Supabase, same as integration. Moving them to a separate tier could cause CI overhead.
**Mitigation:** Reuse the same `globalSetup.ts`. The infrastructure is shared; only the vitest project config separates them.

**Risk:** Ollama availability in test environment for enrichment pipeline.
**Mitigation:** Per stakeholder decision, add Ollama to the test environment or use a smaller model. If Ollama isn't available, the pipeline test will fail clearly in `beforeAll` with an informative message (existing check for `localhost:11434`).
