# 20: Test Suite Reorganization

## Problem

Two related issues:

1. **Overlap and confusion** — `smgr-cli.test.ts` and `smgr-e2e.test.ts` both spawn CLI subprocesses, both require Next.js + Supabase, and test overlapping commands. It's unclear where new tests belong.

2. **Over-mocking** — Many "unit" tests mock Supabase, S3, and encryption so heavily that they test mock wiring rather than real behavior. A test that mocks `createS3Client`, `listS3Objects`, `downloadS3Object`, `insertEvent`, `upsertWatchedKey`, `encryptSecretVersioned`, and `decryptSecretVersioned` verifies that functions are called in order — it doesn't catch wrong column names, RLS violations, encryption roundtrip failures, or S3 API incompatibilities.

The DB integration tests (schema-contract, tenant-isolation, media-lifecycle) are the most valuable tests in the suite because they hit real Supabase and catch real problems. The mock-heavy unit tests are the least valuable because they mostly verify mock wiring.

## Philosophy: Real Code Paths First

See CLAUDE.md "Test Philosophy" section — this spec implements that philosophy across the existing test suite.

## Current State

| Suite | What it tests | Requires | Value |
|-------|--------------|----------|-------|
| Unit (`npm run test`) | Logic + mock wiring | Nothing | Mixed — pure logic tests are high value, mock-heavy tests are low value |
| `smgr-cli.test.ts` | CLI via subprocess → API → DB | Supabase + Next.js | Medium — tests real paths but through CLI subprocess overhead |
| `smgr-e2e.test.ts` | Full pipeline: S3 → watch → enrich → search | Supabase + Next.js + S3 + Ollama | High — exercises the real user journey |
| DB integration tests | Schema, RLS, tenant isolation | Supabase only | High — catches real DB issues |
| `media-storage.test.ts` | S3 operations directly | Supabase S3 | High — real S3 calls |

### Mock-heavy unit tests to evaluate for deletion

These tests mock most of their dependencies and primarily verify call ordering:

- `s3-actions.test.ts` — mocks S3, Supabase, encryption. Tests agent action dispatch.
- `agent-core.test.ts` — mocks S3, Supabase, encryption. Tests indexBucket flow.
- `agent-actions.test.ts` — mocks Anthropic, Supabase. Tests plan/execute.
- `encryption-lifecycle.test.ts` — mocks Supabase. Tests encrypt/decrypt roundtrip with real crypto (this one has value).
- `health-route.test.ts` — mocks Supabase. Tests response shape.
- `device-*.test.ts` — mocks Supabase, auth. Tests route handlers.
- `whatsapp-route.test.ts` — mocks everything.

### Unit tests to keep (pure logic, no mocking)

- `media-utils.test.ts` — pure functions
- `encryption.test.ts` / `encryption-versioned.test.ts` — real crypto, no DB
- `validation.test.ts` — pure validation
- `logger.test.ts` — pure formatting
- `retry.test.ts` — pure retry logic
- `request-context.test.ts` — async context
- `supabase-client.test.ts` — client construction
- `smgr-cli-auth.test.ts` — credential file parsing (pure I/O)

## Goal

Four test tiers aligned with the CLAUDE.md test philosophy and tier definitions:

### Tier 1: Unit (fast, no services)

Pure logic only. No mocks of Supabase, S3, or other services. If a function needs a Supabase client to test, it belongs in Tier 2.

```bash
npm run test          # < 3 seconds, no docker needed
```

### Tier 2: Integration (real services, no user interface)

Tests that call functions, API routes, and DB queries directly against real local services. Entry point is a direct function/API call, not a user-facing interface.

```bash
npm run test:integration   # requires: supabase start + next dev
```

Sub-categories (organized by infra needs, run as one suite):

**DB tests** (Supabase only — no dev server):
- Schema validation, RLS, tenant isolation, media lifecycle
- Direct Supabase client queries
- Existing tests, keep as-is

**API route tests** (Supabase + Next.js):
- `fetch()` directly against running dev server with Bearer token
- Bucket CRUD, test connectivity, scan, upload, enrich
- Events/stats filtering by bucket_config_id
- Auth: 401 without token, user isolation
- Replaces mock-heavy route unit tests

### Tier 3: E2E — CLI (full stack via CLI binary)

Tests that spawn `smgr` as a subprocess — the same way a user runs it. Goes through the full stack: CLI arg parsing → HTTP request → API route → Supabase/S3 → response → stdout.

```bash
npm run test:e2e:cli   # requires: supabase start + next dev + S3
```

Tests CLI-specific behavior that can't be tested via direct API calls:
- Argument parsing, help text, `bucket` subcommand routing
- Exit codes for auth errors, missing args, service failures
- Output formatting (table vs JSON)
- Credential file handling
- Full pipeline: `bucket add` → `watch --once` → `enrich --pending` → `query`

### Tier 4: E2E — Web (full stack via browser)

Tests that drive a browser via Playwright — the same way a user interacts with the web UI.

```bash
npm run test:e2e   # requires: supabase start + next dev + chromium
```

- UI flows, form submissions, navigation
- Auth redirects, session handling
- Bucket management page
- Media grid, search

## Key Changes

### 1. Audit and delete mock-heavy unit tests

For each test file that mocks Supabase/S3:
1. Check if the same code path is covered by an existing integration test
2. If yes → delete the unit test
3. If no → write an integration test that covers it, then delete the unit test
4. If the test covers pure logic mixed with I/O → extract the pure logic into a testable function, unit test that, integration test the rest

### 2. New API route integration tests

`__tests__/integration/api-bucket-routes.test.ts`:
- Create test user, get access token
- Test all bucket CRUD operations against real Supabase
- Test bucket connectivity against real S3
- Test scan, upload against real S3
- Test 401/404 error cases

`__tests__/integration/api-events-routes.test.ts`:
- Test bucket_config_id filtering on events and stats
- Test event CRUD

These use `fetch()` directly — no CLI subprocess.

### 3. Reclassify CLI tests as E2E

Rename/move `smgr-cli.test.ts` and `smgr-e2e.test.ts` into an E2E CLI tier:
- These spawn subprocesses — they test the system through the user-facing CLI interface
- That makes them E2E, not integration
- Merge overlapping coverage between the two files
- Keep CLI-specific tests (arg parsing, exit codes, output formatting)
- Keep the full pipeline test (watch → enrich → search)
- Remove tests that just verify API responses through the CLI wrapper (covered by Tier 2 API route tests)

### 4. Web E2E stays as-is

Playwright tests are already correctly classified as E2E. No changes needed.

## Migration Strategy

Do this incrementally, not all at once:

1. **First pass:** Write API route integration tests for new bucket routes (spec 15 gap). Don't delete anything yet.
2. **Second pass:** For each mock-heavy unit test, check if the new integration tests cover the same paths. Delete the unit test if covered.
3. **Third pass:** Audit remaining unit tests. Extract pure logic where possible.

Each pass should leave all remaining tests green.

## Out of Scope

- Changing vitest as test runner
- Writing new Playwright web E2E tests (existing ones stay)
- Rewriting the DB integration tests (they're already good)
- Performance benchmarking of test suite
- CI pipeline restructuring (may need a follow-up to add `test:e2e:cli` as a separate CI job)

## Dependencies

- Spec 15 (bucket API routes) — done
- Local Supabase + Next.js dev server for integration tests
- Existing `setup.ts` helpers (createTestUser, getAdminClient, etc.)
