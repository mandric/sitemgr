<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: cd web && npm test
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-env-extraction
section-02-env-verification
section-03-db-integration-step
section-04-media-integration-step
section-05-local-validation
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-env-extraction | - | 02, 03, 04 | Yes |
| section-02-env-verification | 01 | 03, 04 | Yes |
| section-03-db-integration-step | 01, 02 | 05 | Yes |
| section-04-media-integration-step | 01, 02 | 05 | Yes |
| section-05-local-validation | 03, 04 | - | No |

## Execution Order

1. section-01-env-extraction (no dependencies)
2. section-02-env-verification (after 01)
3. section-03-db-integration-step, section-04-media-integration-step (parallel after 02)
4. section-05-local-validation (final — runs everything end-to-end locally)

## Section Summaries

### section-01-env-extraction
Rewrite the "Extract Supabase connection details" step in ci.yml to consolidate `supabase status` calls into a single JSON capture and add `NEXT_PUBLIC_` prefixed exports for the integration test code.

### section-02-env-verification
Add a new "Verify integration test env vars" step to the CI workflow that fails early if required Supabase env vars are missing, preventing silent test skipping or cryptic auth failures.

### section-03-db-integration-step
Add a "Run DB integration tests (RLS, RPC, migrations)" step to the CI workflow that runs `npm run test:integration` after dependency installation.

### section-04-media-integration-step
Add a "Run media integration tests (S3, DB, pipeline)" step to the CI workflow that runs `npm run test:media-integration` after the DB integration tests.

### section-05-local-validation
End-to-end local validation: start Supabase, run the full integration-tests job sequence locally (env extraction, verification, both test suites), and verify everything passes before pushing the CI change.
