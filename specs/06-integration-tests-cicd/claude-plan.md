# Implementation Plan: Add Integration Tests to CI/CD Pipeline

## Overview

The Site Manager CI pipeline runs unit tests and E2E tests but skips two vitest-based integration test suites that validate database security (RLS/RPC) and media pipeline (S3 + DB) functionality. These tests exist and work locally but are not wired into CI, creating a gap where regressions can reach production undetected.

This plan adds both integration test suites to the existing `integration-tests` CI job, fixes an environment variable naming mismatch that would cause tests to silently skip or fail cryptically, and ensures failures block deployment.

## Why This Matters

The two test suites have different failure modes when environment variables are missing:

**DB integration tests** (`rls-policies.test.ts`, `rpc-user-isolation.test.ts`) use a `describe.skipIf(!canRun)` guard: if required environment variables are missing, tests silently pass with 0 assertions. In CI, the job would report "green" even though no tests ran.

**Media integration tests** (`media-db.test.ts`, `media-s3.test.ts`, `media-pipeline.test.ts`) have no skip guard. They import from `setup.ts`, which throws if `SUPABASE_SECRET_KEY` is missing. However, if `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is empty (the `setup.ts` fallback is `""`), the Supabase client will be created with an empty auth key, leading to cryptic API auth failures rather than a clear error message.

The env var fix and verification step are as important as adding the test steps — without them, we'd get either false confidence (DB tests) or confusing failures (media tests).

**Note on `migration-integrity.test.ts`:** This file currently contains only `it.todo(...)` stubs — zero actual assertions. Including it in CI is still correct (vitest reports them as "pending", and future implementations will be automatically covered), but it provides no validation today. This is a known gap.

## Architecture Decision: Same Job, New Steps

We add test steps to the existing `integration-tests` job rather than creating separate jobs because:
- The job already starts Supabase, extracts credentials, and creates the storage bucket
- Supabase startup takes ~30s — duplicating this across jobs wastes CI minutes
- The deploy job already depends on `integration-tests`, so no dependency changes needed
- DB tests (30s) run before media tests (60s) for fail-fast behavior

## Changes

### Section 1: Consolidate and Fix Environment Variable Export

**File:** `.github/workflows/ci.yml`
**Step:** "Extract Supabase connection details" (lines 83-93)

The current step makes multiple separate `supabase status -o json` calls. Consolidate into a single JSON capture and add the `NEXT_PUBLIC_` prefixed exports that the test code reads.

Rewrite the step to:
```yaml
- name: Extract Supabase connection details
  run: |
    STATUS_JSON=$(supabase status -o json)
    echo "SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)" >> $GITHUB_ENV
    echo "NEXT_PUBLIC_SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)" >> $GITHUB_ENV
    echo "SUPABASE_SECRET_KEY=$(echo "$STATUS_JSON" | jq -r .SERVICE_ROLE_KEY)" >> $GITHUB_ENV
    echo "SUPABASE_PUBLISHABLE_KEY=$(echo "$STATUS_JSON" | jq -r .ANON_KEY)" >> $GITHUB_ENV
    echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$(echo "$STATUS_JSON" | jq -r .ANON_KEY)" >> $GITHUB_ENV
    echo "STORAGE_S3_URL=$(echo "$STATUS_JSON" | jq -r .STORAGE_S3_URL)" >> $GITHUB_ENV

    AWS_ACCESS_KEY=$(supabase status | grep "Access Key" | awk -F '│' '{print $3}' | tr -d ' ')
    AWS_SECRET_KEY=$(supabase status | grep "Secret Key" | awk -F '│' '{print $3}' | tr -d ' ')
    echo "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY" >> $GITHUB_ENV
    echo "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_KEY" >> $GITHUB_ENV
```

This reduces 4+ separate `supabase status -o json` subprocess calls to 1, avoiding flaky Docker socket issues in CI. The S3 key extraction still requires the text-format output (S3 keys aren't in the JSON output).

**Why both prefixed and unprefixed?** The unprefixed `SUPABASE_URL` is used by other CI steps (FTS smoke test, bucket creation). The `NEXT_PUBLIC_` prefixed versions are what the test code reads. Both must exist.

### Section 2: Add Env Var Verification Step

**File:** `.github/workflows/ci.yml`
**Position:** After "Extract Supabase connection details", before "Configure environment for smgr"

New step:
```yaml
- name: Verify integration test env vars
  run: |
    missing=0
    for var in SUPABASE_URL SUPABASE_SECRET_KEY SUPABASE_PUBLISHABLE_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; do
      if [ -z "${!var}" ]; then
        echo "ERROR: $var is not set"
        missing=1
      fi
    done
    if [ "$missing" -eq 1 ]; then
      echo "::error::Required Supabase env vars are missing. DB tests would silently skip; media tests would get cryptic auth failures."
      exit 1
    fi
    echo "All required env vars verified"
```

This fails the job early and with a clear message if `supabase start` didn't produce the expected output.

### Section 3: Add DB Integration Test Step

**File:** `.github/workflows/ci.yml`
**Position:** After "Install web dependencies", before "FTS smoke test"

New step:
```yaml
- name: Run DB integration tests (RLS, RPC, migrations)
  run: cd web && npm run test:integration
```

This runs `vitest run --config vitest.integration.config.ts` which executes:
- `rls-policies.test.ts` — verifies RLS policies enforce tenant isolation across all tables
- `rpc-user-isolation.test.ts` — verifies RPC functions respect user boundaries
- `migration-integrity.test.ts` — currently all `.todo` stubs (runs but validates nothing)

30-second timeout per test. These tests create temporary auth users, run assertions, and clean up. The required env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`) are available from `$GITHUB_ENV` set in Section 1.

**Test isolation note:** The DB tests use separate users per file (`rls-test-a@test.local` in rls-policies, hardcoded UUIDs in rpc-user-isolation), so vitest's default parallelism is safe. No need for `singleThread` configuration.

### Section 4: Add Media Integration Test Step

**File:** `.github/workflows/ci.yml`
**Position:** After DB integration tests, before "FTS smoke test"

New step:
```yaml
- name: Run media integration tests (S3, DB, pipeline)
  run: cd web && npm run test:media-integration
```

This runs `vitest run --config vitest.media-integration.config.ts` which executes:
- `media-db.test.ts` — event insertion, enrichment, FTS, watched keys, multi-user isolation
- `media-s3.test.ts` — S3 upload/list/retrieve via Supabase Storage API
- `media-pipeline.test.ts` — full pipeline combining S3 + DB with mocked enrichment

60-second timeout per test. The `setup.ts` shared helper constructs S3 credentials from the Supabase service key directly (using the service role key as both `accessKeyId` and `secretAccessKey`). This works with local Supabase Storage but differs from the CI pipeline's proper S3 credentials (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`). This divergence is acceptable for local Supabase but should be noted for future reference if S3 auth tightens.

## Final CI Job Step Order

After changes, the `integration-tests` job steps are:

1. Checkout
2. Setup Node 20
3. Setup Supabase CLI
4. Start Supabase local environment
5. Extract Supabase connection details *(rewritten — consolidated, adds NEXT_PUBLIC_ exports)*
6. **Verify integration test env vars** *(new)*
7. Configure environment for smgr
8. Create storage bucket
9. Install web dependencies
10. **Run DB integration tests** *(new)*
11. **Run media integration tests** *(new)*
12. FTS smoke test *(unchanged)*
13. Stop Supabase *(unchanged, `if: always()`)*

## What Does NOT Change

- **Deploy job dependencies** — already includes `integration-tests`
- **FTS smoke test** — kept as fast-fail signal (cheap, complements vitest tests)
- **E2E job** — already working, no changes needed
- **Unit test job** — already working, no changes needed
- **Test code** — no changes to test files (env var names already use the new naming convention)
- **Vitest configs** — no changes needed
- **Test cleanup** — tests use `afterAll` cleanup, which is acceptable in CI because `supabase stop` (with `if: always()`) destroys the entire instance

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Integration tests flaky on first CI run | Run locally first with `supabase start` + both test commands to verify stability |
| Supabase start timing — tests run before DB ready | Supabase CLI blocks until services are ready; existing FTS test validates this |
| Media tests fail due to missing storage bucket | Bucket creation step runs before tests; same bucket (`media`) used by existing CI |
| CI job takes too long with added tests | DB tests ~30s + media tests ~60s = ~90s additional. Acceptable for the safety gained |
| DB tests silently skip due to env var issues | Verification step (Section 2) catches this and fails the job early |
| Media tests give cryptic auth failures | Verification step (Section 2) catches missing keys before tests run |
| `migration-integrity.test.ts` provides false confidence | Documented as `.todo` stubs; consider implementing or adding `passWithNoTests: false` as follow-up |

## Follow-Up Items (Not in Scope)

- Implement actual assertions in `migration-integrity.test.ts` (currently all `.todo` stubs)
- Consider adding `passWithNoTests: false` to vitest integration configs to catch zero-assertion files
- Align media test S3 credentials with CI's `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` if Supabase Storage tightens S3 auth
- Add `canRun` guard to media tests for consistency with DB test pattern (or remove from DB tests — pick one convention)

## Estimated Impact on CI Time

- Current `integration-tests` job: ~2 min (Supabase start + FTS smoke)
- Added: ~90s (DB tests 30s + media tests 60s)
- New total: ~3.5 min
- All CI jobs run in parallel, so this doesn't affect overall pipeline time unless `integration-tests` becomes the bottleneck (unlikely — E2E is typically slowest)
