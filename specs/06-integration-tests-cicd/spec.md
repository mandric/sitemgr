# Add Integration Tests to CI/CD Pipeline

## Problem

The codebase has three tiers of integration tests that work locally but are **not running in CI**:

1. **Media pipeline integration tests** (`web/__tests__/integration/media-*.test.ts`) — S3, DB, and full pipeline tests against local Supabase
2. **Database security/integrity tests** (`web/__tests__/rls-policies.test.ts`, `web/__tests__/rpc-user-isolation.test.ts`, `web/__tests__/migration-integrity.test.ts`) — RLS, RPC isolation, and migration integrity
3. **Legacy CLI integration test** (`tests/integration_test.sh`) — shell script testing smgr CLI

The existing `integration-tests` job in `.github/workflows/ci.yml` only runs a minimal FTS smoke test via inline SQL — it does **not** execute any of the vitest-based integration test suites.

## Goal

Wire the vitest-based integration tests into the CI pipeline so they run on every PR and push to `main`, using the local Supabase instance that the `integration-tests` job already starts.

## Scope

- Add `npm run test:integration` (RLS/RPC/migration tests) to the CI pipeline
- Add `npm run test:media-integration` (media pipeline tests) to the CI pipeline
- Ensure the existing Supabase setup in the `integration-tests` job provides the necessary environment variables and storage buckets for both test suites
- Keep the existing FTS smoke test (it's cheap and provides a fast-fail signal)
- Ensure test failures block the deploy job

## Out of Scope

- The legacy shell script (`tests/integration_test.sh`) — defer to future work
- Preview environment setup
- Atomic deployment / rollback improvements
- Adding new integration tests (only wiring existing ones into CI)

## Constraints

- Must work with GitHub Actions ubuntu-latest runners
- Must use Supabase CLI (`supabase start`) for local services
- Integration tests require: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, S3 endpoint/credentials
- Media integration tests have 60s timeout; DB integration tests have 30s timeout
- Tests must not interfere with each other (cleanup between suites)
