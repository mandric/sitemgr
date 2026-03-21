<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: npm test
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-local-dev-sh
section-02-test-integration-sh
section-03-setup-sh
section-04-env-examples
section-05-delete-legacy
section-06-smgr-e2e
section-07-verify-sh
section-08-docs-readme
section-09-deploy-sh
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---|---|---|---|
| section-01-local-dev-sh | — | 02, 07, 08 | Yes |
| section-02-test-integration-sh | 01 | 08 | No |
| section-03-setup-sh | — | — | Yes |
| section-04-env-examples | — | — | Yes |
| section-05-delete-legacy | — | — | Yes |
| section-06-smgr-e2e | — | — | Yes |
| section-07-verify-sh | 01 | 08 | No |
| section-08-docs-readme | 01, 02, 07 | — | No |
| section-09-deploy-sh | — | — | Yes |

## Execution Order

1. sections 01, 03, 04, 05, 06, 09 — parallel (no dependencies)
2. sections 02, 07 — parallel after 01
3. section 08 — after 01, 02, and 07

## Section Summaries

### section-01-local-dev-sh
Rewrite `scripts/local-dev.sh`: replace table parsing with `supabase status -o json` + `jq`, add `print_setup_env_vars` function that outputs dotenv format to stdout, add idempotent Supabase start, add `set -euo pipefail`, remove bucket creation curl, update printed instructions.

### section-02-test-integration-sh
Fix `scripts/test-integration.sh`: replace `supabase status` extraction block with `source .env.local`, remove bucket creation curl, remove S3 credential fallback to `SUPABASE_SECRET_KEY`.

### section-03-setup-sh
Fix `scripts/setup.sh`: add `set -euo pipefail`, add prerequisite check function that collects all missing tools before failing, include `supabase`, `docker`, `node` 20+, `npm`, `jq`.

### section-04-env-examples
Fix `.env.example` (root) and `web/.env.example`: replace deprecated `ENCRYPTION_KEY` with `ENCRYPTION_KEY_CURRENT`, reorganize `web/.env.example` into labelled sections (Supabase, S3, CLI, Encryption, Optional).

### section-05-delete-legacy
Delete `tests/integration_test.sh`, `tests/seed_test_data.sh`, `tests/README.md`. Check and conditionally delete `tests/edge_function_*.ts` if unreferenced by CI. Update `docs/TESTING.md` to remove references to legacy shell runners.

### section-06-smgr-e2e
Add `beforeAll` / `afterAll` bucket management to `web/__tests__/integration/smgr-e2e.test.ts` so it creates the `media` bucket itself rather than assuming it pre-exists.

### section-07-verify-sh
Create `scripts/setup/verify.sh`: sources `.env.local` if present, checks required env vars are non-empty, checks Supabase API reachable, prints `✓`/`✗` per check, exits non-zero on any failure.

### section-08-docs-readme
Write `docs/setup/README.md`: linear quickstart narrative covering prerequisites, three setup steps (`setup.sh`, `local-dev.sh print_setup_env_vars > .env.local`, `verify.sh`), running tests, resetting, stopping, and troubleshooting.

### section-09-deploy-sh
Fix `scripts/deploy.sh`: replace two occurrences of deprecated `ENCRYPTION_KEY` with `ENCRYPTION_KEY_CURRENT`. Check `scripts/lib.sh` and `.github/workflows/` for any remaining references.
