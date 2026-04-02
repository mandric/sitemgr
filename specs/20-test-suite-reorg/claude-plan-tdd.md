# TDD Plan: Test Suite Reorganization (Spec 20)

Testing framework: Vitest (unit + integration + e2e-cli), Playwright (e2e-web)
Existing patterns: `describe`/`it` blocks, `beforeAll`/`afterAll` setup, `createTestUser()` + `cleanupUserData()` helpers.

## Section 1: New API Route Integration Tests

These tests ARE the deliverable for this section — the "test-first" principle applies to the mock-heavy tests they replace.

### `api-bucket-routes.test.ts`

```
# Test: POST /api/buckets creates bucket config and returns 200 with id
# Test: GET /api/buckets lists created bucket configs for user
# Test: DELETE /api/buckets/[id] removes bucket, subsequent GET returns empty
# Test: POST /api/buckets/[id]/test returns 200 for valid S3 config (local Supabase S3)
# Test: GET /api/buckets without Authorization header returns 401
# Test: DELETE /api/buckets/[id] for another user's bucket returns 404 or empty
```

### `api-events-routes.test.ts`

```
# Test: GET /api/events returns seeded events for authenticated user
# Test: GET /api/events?bucket_config_id=X filters to matching events
# Test: GET /api/events?limit=1 returns single event
# Test: GET /api/events/[id] returns event detail with enrichment
# Test: GET /api/events/by-hash/[hash] returns matching event
# Test: GET /api/events without auth returns 401
# Test: GET /api/events/[id] for another user's event returns 404/null
```

### `api-stats-routes.test.ts`

```
# Test: GET /api/stats returns correct event and enrichment counts
# Test: GET /api/stats?bucket_config_id=X returns filtered stats
# Test: GET /api/stats without auth returns 401
```

### `api-enrichment-routes.test.ts`

```
# Test: GET /api/enrichments/status returns enriched vs pending counts
# Test: GET /api/enrichments/pending returns events without enrichments
# Test: GET /api/enrichments returns enrichment list for user
# Test: GET /api/enrichments without auth returns 401
```

### `api-health-route.test.ts`

```
# Test: GET /api/health returns 200 with status ok (no auth needed)
```

### `createTestUserWithToken` helper

```
# Test: returns valid accessToken that authenticates fetch() requests
# Test: throws if session is null (implicit — tested by all API route tests using the token)
```

## Section 2: Delete Mock-Heavy Unit Tests

### Before deleting each test file:

```
# Verify: code paths in the deleted test are covered by integration tests
# Verify: no unique edge case logic that only the mock test exercised
# Verify: encryption-rotation.test.ts covers the same rotation scenarios as encryption-lifecycle.test.ts
# Verify: remaining unit tests still pass after deletion (npm run test)
```

### `device-approve-form.test.ts` split:

```
# Test: parseCodeFromUrl tests remain as unit test (pure logic)
# Verify: approveDevice tests are deleted (mock-fetch, no value)
```

## Section 3: Reclassify CLI Tests as E2E

### Vitest config changes:

```
# Verify: e2e-cli project picks up __tests__/e2e-cli/**/*.test.ts
# Verify: unit project excludes __tests__/e2e-cli/**
# Verify: npm run test:e2e:cli runs the e2e-cli project
# Verify: npm run test runs only unit tests (no e2e-cli)
# Verify: npm run test:integration runs only integration tests
```

### `sitemgr-commands.test.ts` (merged from sitemgr-cli.test.ts):

```
# Test: no command → exit 0 with usage
# Test: unknown command → exit 1
# Test: stats → valid JSON output
# Test: query → table format output
# Test: query --format json → JSON output
# Test: query --limit → respects limit
# Test: show [id] → event details
# Test: exit code non-zero when not logged in
```

### `sitemgr-pipeline.test.ts` (from sitemgr-e2e.test.ts):

```
# Test: watch --once discovers uploaded images
# Test: enrich --dry-run lists pending
# Test: enrich --pending processes images (requires Ollama)
# Test: FTS search returns results from enrichment descriptions
# Test: final stats show all enriched
```

## Section 4: Verification and Cleanup

```
# Verify: npm run test passes (unit only)
# Verify: npm run test:integration passes
# Verify: npm run test:e2e:cli passes
# Verify: npm run test:e2e passes (Playwright, unchanged)
# Verify: npm run typecheck passes
# Verify: npm run lint passes
# Verify: npm run build passes
# Verify: npm run test:all runs all vitest projects
```
