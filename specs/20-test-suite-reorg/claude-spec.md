# Spec 20: Test Suite Reorganization — Complete Specification

## Problem

The test suite has two related issues:

1. **Overlap and confusion** — `sitemgr-cli.test.ts` and `sitemgr-e2e.test.ts` both spawn CLI subprocesses, both require Next.js + Supabase, and test overlapping commands. It's unclear where new tests belong.

2. **Over-mocking** — ~18 "unit" tests mock Supabase, S3, and encryption so heavily that they test mock wiring rather than real behavior. They don't catch wrong column names, RLS violations, encryption roundtrip failures, or S3 API incompatibilities.

## Goal: Four Test Tiers

### Tier 1: Unit (`npm run test`)
Pure logic only. No mocks of Supabase, S3, or other services. Fast, no Docker needed.

**Keep:** encryption.test.ts, encryption-rotation.test.ts, encryption-versioned.test.ts, validation.test.ts, retry.test.ts, media-utils.test.ts, device-codes.test.ts

### Tier 2: Integration (`npm run test:integration`)
Real services (Supabase + Next.js). Direct function/API calls with `fetch()` + Bearer tokens.

**Existing (keep):** schema-contract, tenant-isolation, media-lifecycle, media-storage, device-auth, device-codes-schema, auth-smoke, model-configs, webhook-service-account

**New API route tests:** bucket CRUD, events/stats filtering, auth error cases — using `fetch()` with Bearer tokens against running dev server.

### Tier 3: E2E CLI (`npm run test:e2e:cli`)
CLI subprocess tests. Spawns `sitemgr` binary, tests through user-facing CLI interface.

**Reclassified from integration:** sitemgr-cli.test.ts → e2e-cli.test.ts (merged with sitemgr-e2e.test.ts)
- Merge overlapping coverage between the two files
- Keep CLI-specific tests: arg parsing, exit codes, output formatting, credential handling
- Keep full pipeline: watch → enrich → search
- Remove tests that just verify API responses through CLI (covered by Tier 2)
- Ollama should be available in the test environment for the enrichment pipeline

**New vitest project** in vitest.config.ts with its own configuration.

### Tier 4: E2E Web (`npm run test:e2e`)
Playwright browser tests. Unchanged.

## Migration Strategy

### Pass 1: Write API route integration tests
New `fetch()`-based integration tests for:
- Bucket CRUD routes (list, add, remove, test connectivity)
- Event routes (query, show, by-hash, bucket_config_id filtering)
- Stats routes (with bucket filtering, enrichment status)
- Auth error cases (401 without token, 404 for wrong user)

Authentication: `createTestUser()` for setup → extract access_token → `fetch()` with `Authorization: Bearer <token>`

### Pass 2: Delete mock-heavy unit tests
For each mock-heavy test:
1. Verify the same code path is now covered by integration tests
2. Delete the unit test
3. If it covers pure logic mixed with I/O → extract pure logic, unit test that, delete the rest

Target deletions (after integration coverage exists):
- `db-operations.test.ts` — mocks Supabase queries
- `s3-actions.test.ts` — mocks S3 + DB operations
- `agent-core.test.ts` — mocks everything
- `agent-actions.test.ts` — mocks everything
- `enrichment.test.ts` — mocks Anthropic + validation
- `health-route.test.ts` — mocks Supabase
- `whatsapp-route.test.ts` — mocks everything
- `device-approve-route.test.ts` — mocks Supabase auth
- `device-initiate-route.test.ts` — mocks multiple deps
- `device-token-route.test.ts` — mocks Supabase
- `phone-migration-app.test.ts` — mocks Supabase
- `encryption-lifecycle.test.ts` — mocks DB (real crypto is valuable but can integrate)
- `s3-client.test.ts` — mocks AWS SDK
- `supabase-client.test.ts` — mocks @supabase/supabase-js
- `instrumentation.test.ts` — mocks OpenTelemetry

Evaluate case-by-case:
- `logger.test.ts` — uses spyOn on console (may be fine as unit test)
- `request-context.test.ts` — async context tracking (may be pure enough)
- `cli-auth-device-flow.test.ts` — mocks child_process/fetch
- `cli-open-browser.test.ts` — mocks child_process
- `api-auth.test.ts` — mocks multiple deps

### Pass 3: Reclassify CLI tests as E2E
- Create new vitest project "e2e-cli" 
- Move sitemgr-cli.test.ts + sitemgr-e2e.test.ts to `__tests__/e2e-cli/`
- Merge overlapping tests, remove API-verification tests covered by Tier 2
- Add `npm run test:e2e:cli` script
- Ensure Ollama is available in test environment for pipeline tests

### Pass 4: Cleanup
- Delete `__tests__/helpers/agent-test-setup.ts` (mock infrastructure no longer needed)
- Remove any orphaned mock utilities
- Verify all remaining tests pass

## Vitest Configuration Changes

Add third project to `vitest.config.ts`:
```
e2e-cli:
  include: __tests__/e2e-cli/**/*.test.ts
  testTimeout: 120000
  hookTimeout: 60000
  globalSetup: __tests__/integration/globalSetup.ts (reuse)
  fileParallelism: false
```

## package.json Script Changes

```
test:e2e:cli → vitest run --project e2e-cli
```

## Out of Scope

- Changing vitest as test runner
- Writing new Playwright web E2E tests
- Rewriting DB integration tests
- CI pipeline restructuring (follow-up)
- Performance benchmarking
