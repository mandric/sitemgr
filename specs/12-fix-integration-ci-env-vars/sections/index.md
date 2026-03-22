<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: cd web && npx vitest run --project integration --reporter=verbose
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-ci-workflow
section-02-global-setup
section-03-smoke-test
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-ci-workflow | - | - | Yes |
| section-02-global-setup | - | - | Yes |
| section-03-smoke-test | - | - | Yes |

## Execution Order

1. section-01-ci-workflow, section-02-global-setup, section-03-smoke-test (all parallel — no dependencies)

## Section Summaries

### section-01-ci-workflow
Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` env vars to the CI integration test job in `.github/workflows/ci.yml`. Add them to the "Configure environment for smgr" step (mapped from `SMGR_API_URL`/`SMGR_API_KEY`) and to the "Verify integration test env vars" step for fast-fail on missing values.

### section-02-global-setup
Add defensive env var fallback in `web/__tests__/integration/globalSetup.ts` so the spawned dev server gets `NEXT_PUBLIC_*` vars even if only `SMGR_*` are set. Falls back `NEXT_PUBLIC_SUPABASE_URL` to `SMGR_API_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to `SMGR_API_KEY` in the spawn env object. Includes a comment documenting the local-only equivalence constraint.

### section-03-smoke-test
Add retry logic and improved diagnostics to the `smoke_test` function in `scripts/lib.sh`. Retry up to 3 times on connection errors or transient 5xx. Fail immediately on `status: "degraded"` (config error). Print HTTP status and response body on each attempt.
