# Combined Spec: Add Integration Tests to CI/CD Pipeline

## Background

The Site Manager codebase has a three-tier test strategy:
- **Unit tests** — fast, no external deps, already running in CI
- **Integration tests** — require local Supabase, **NOT running in CI**
- **E2E tests** — Playwright with local Supabase, already running in CI

The `integration-tests` job in `.github/workflows/ci.yml` already starts a local Supabase instance, extracts connection details, creates a storage bucket, and runs an inline FTS smoke test. However, it does **not** execute any of the vitest-based integration test suites.

## What Needs to Happen

### 1. Add vitest integration test steps to the existing `integration-tests` CI job

Two new steps, in order:

1. **DB integration tests** (`npm run test:integration`) — RLS policy isolation, RPC user isolation, migration integrity. 30s timeout. These run first because they're faster and catch fundamental DB issues early.

2. **Media pipeline integration tests** (`npm run test:media-integration`) — S3 storage, DB operations, full media pipeline. 60s timeout. These run second.

Both steps go between "Install web dependencies" and "Stop Supabase" in the existing job. The existing FTS smoke test stays as-is (fast-fail signal).

### 2. Fix environment variable naming gap

The CI job currently exports:
- `SUPABASE_URL` — but tests read `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY` — but tests read `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY` — matches what tests expect

The "Extract Supabase connection details" step must also export the `NEXT_PUBLIC_` prefixed versions so the integration tests can read them. (The tests use `describe.skipIf(!canRun)` which silently skips if env vars are missing — a dangerous failure mode in CI where we'd think tests passed when they actually didn't run.)

### 3. Ensure tests block deploy

The `deploy` job already depends on `integration-tests` via `needs: [lint, build, unit-tests, integration-tests, e2e-tests]`. Since the new test steps are added to the existing `integration-tests` job, failures will automatically block deploy. No `continue-on-error` — strict blocking.

## Constraints

- Ubuntu-latest GitHub Actions runners
- Supabase CLI for local services (already set up in the job)
- Tests must have env vars set or they'll silently skip (the `canRun` guard pattern)
- Media tests need: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, plus S3 env vars (already configured via "Configure environment for smgr" step)
- DB integration tests need: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`

## Out of Scope

- Legacy CLI integration test (`tests/integration_test.sh`)
- Preview Supabase environment
- Atomic deployment / rollback
- Writing new integration tests
- Full codebase rename of deprecated key names (only CI + test files touched by this task)
