<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: cd web && npm run test:integration
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-schema-info-migration
section-02-global-setup
section-03-shared-seed-layer
section-04-schema-contract-tests
section-05-tenant-isolation-tests
section-06-media-lifecycle-tests
section-07-media-storage-tests
section-08-vitest-config
section-09-ci-workflow
section-10-cleanup
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-schema-info-migration | - | 04 | Yes |
| section-02-global-setup | - | 04, 05, 06, 07 | Yes |
| section-03-shared-seed-layer | - | 04, 05, 06 | Yes |
| section-04-schema-contract-tests | 01, 02, 03 | 08 | Yes (after deps) |
| section-05-tenant-isolation-tests | 02, 03 | 08 | Yes (after deps) |
| section-06-media-lifecycle-tests | 02, 03 | 08 | Yes (after deps) |
| section-07-media-storage-tests | 02 | 08 | Yes (after deps) |
| section-08-vitest-config | 04, 05, 06, 07 | 09 | No |
| section-09-ci-workflow | 08 | 10 | No |
| section-10-cleanup | 09 | - | No |

## Execution Order

1. section-01-schema-info-migration, section-02-global-setup, section-03-shared-seed-layer (parallel — no dependencies)
2. section-04-schema-contract-tests, section-05-tenant-isolation-tests, section-06-media-lifecycle-tests, section-07-media-storage-tests (parallel — after batch 1)
3. section-08-vitest-config (after all test suites)
4. section-09-ci-workflow (after config)
5. section-10-cleanup (final)

## Section Summaries

### section-01-schema-info-migration
Creates the `schema_info()` RPC function as a Supabase migration. Returns table, column, index, RLS, policy, and function metadata from pg_catalog. Restricted to service_role only.

### section-02-global-setup
Creates `globalSetup.ts` that validates Supabase connectivity before any integration test runs. Replaces the `describe.skipIf(!canRun)` pattern with fail-fast behavior.

### section-03-shared-seed-layer
Extends `setup.ts` with `seedUserData()`, `assertInsert()`, and `cleanupUserData()`. Single source of truth for table column definitions and test data creation.

### section-04-schema-contract-tests
New `schema-contract.test.ts` — validates tables, columns, NOT NULL constraints, indexes, RLS flags, RPC functions, and policy structure against expected schema. Highest-value test.

### section-05-tenant-isolation-tests
New `tenant-isolation.test.ts` — merges rls-policies + rpc-user-isolation + rls-audit test coverage. Tests read/write isolation, anonymous blocking, RPC scoping, service-role restrictions, and append-only enforcement.

### section-06-media-lifecycle-tests
New `media-lifecycle.test.ts` — merges media-db + media-pipeline. End-to-end user journey from upload to search, plus stats, enrichment status, watched key upsert, and cross-user isolation.

### section-07-media-storage-tests
Rewritten `media-storage.test.ts` — S3 operations (upload, list, download, batch) with BDD naming. Minimal changes from existing media-s3.test.ts.

### section-08-vitest-config
Consolidates three vitest configs into single `vitest.config.ts` using Vitest 4.x `projects` feature. Defines `unit` and `integration` projects. Configures file ordering for schema-contract-first execution.

### section-09-ci-workflow
Updates `.github/workflows/ci.yml`: merges two test commands into one, removes inline FTS smoke test, updates npm scripts in package.json.

### section-10-cleanup
Deletes 7 old test files (rls-policies, rpc-user-isolation, migration-integrity, rls-audit, media-db, media-pipeline, media-s3), 2 old vitest configs, and removes stale exclusions from the new config.
