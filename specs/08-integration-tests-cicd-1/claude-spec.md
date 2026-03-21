# Synthesized Specification: Integration Test Refactor

## Problem Statement

The integration test suite has three structural problems that allowed the `phone_number` column removal to break production without test failures:

1. **Silent skips hide failures.** `migration-integrity.test.ts` has 12 `it.todo()` stubs. The 22 RLS tests used `describe.skipIf(!canRun)` — when a single seed insert failed (because it referenced the removed `phone_number` column), all tests skipped silently. CI reported "22 skipped" with a green build.

2. **Test fixtures drift from schema.** Each test file maintains its own seed data via inline `admin.from("table").insert({...})` calls. The `rls-policies.test.ts` seed data referenced a `phone_number` column that no longer exists after `20260315000002_schema_cleanup.sql` dropped it from `bucket_configs`. There is no shared fixture layer.

3. **Test organization is method-oriented, not behavior-oriented.** Tests describe _what_ they do ("user A cannot SELECT user B's events") but not _why_ it matters. No grouping by business capability.

## Goals

1. **Zero skipped tests.** Every test either runs and passes, or is deleted. No `.todo()`, no `describe.skipIf`.
2. **Migration-driven schema.** Test fixtures use the schema produced by actual migration files. A shared `seedUserData()` helper is the single source of truth for column lists.
3. **BDD-style organization.** Tests grouped by business behavior, readable as specifications.
4. **Fast failure.** A Vitest `globalSetup` validates Supabase connectivity before any tests run. If unavailable, the suite fails immediately with a clear error.

## Decisions (from research + interview)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Vitest configuration | Use `projects` (Vitest 3.2+) | Single config, named projects, `--project` flag for selective runs |
| Schema metadata testing | Add `schema_info` RPC migration | Enables testing indexes, RLS flags, column metadata via PostgREST |
| Seed failure handling | Throw in `beforeAll` | Fast-fail: if seeding fails, no tests run. Clear error message. |
| Test file location | All in `web/__tests__/integration/` | Clean separation from unit tests |
| Schema info RPC design | Single function returning JSON | One RPC call per test suite, returns tables/columns/indexes/policies |
| Skip handling | `globalSetup` that checks Supabase once | Fail fast with clear error instead of silent skip |
| CI changes | Just what the spec says | Merge scripts, remove FTS smoke test, single `test:integration` |

## Architecture

### File Structure (After Refactor)

```
web/
├── __tests__/
│   ├── integration/
│   │   ├── globalSetup.ts              # Validates Supabase is running (NEW)
│   │   ├── setup.ts                    # Shared helpers (EXTEND)
│   │   ├── schema-contract.test.ts     # Schema verification (NEW, replaces migration-integrity)
│   │   ├── tenant-isolation.test.ts    # RLS + RPC isolation (NEW, replaces rls-policies + rpc-user-isolation)
│   │   ├── media-lifecycle.test.ts     # Upload → enrich → search (NEW, replaces media-db + media-pipeline)
│   │   └── media-storage.test.ts       # S3 operations (REWRITE of media-s3)
│   └── ... (unit tests, unchanged)
├── vitest.config.ts                    # Single config with `projects` (REWRITE)
├── vitest.integration.config.ts        # DELETE
└── vitest.media-integration.config.ts  # DELETE
```

### Test-Support Migration

A new migration adds a `schema_info()` RPC function that queries `pg_catalog` / `information_schema` to return:
- Table names in public schema
- Column names and nullability per table
- Index names
- RLS enabled status per table
- RPC function signatures

This keeps all tests using the HTTP API consistently (PostgREST → RPC).

### Shared Seed Layer (`setup.ts` extensions)

```typescript
seedUserData(admin, userId, opts?) → SeedResult
  // Single source of truth for table columns
  // Inserts in dependency order: user_profiles → events → enrichments → watched_keys → bucket_configs → conversations

assertInsert(description, result) → void
  // Throws with full error context on failure
  // Use in beforeAll to get clear failure messages instead of cryptic PostgREST errors
```

### Test Suite Design

**Suite 1 — Schema Contract:** Validates tables, columns, NOT NULL constraints, indexes, RLS flags, and RPC signatures exist as expected. Uses `schema_info()` RPC + direct PostgREST operations.

**Suite 2 — Tenant Isolation:** Merges RLS + RPC isolation tests. Two users (Alice, Bob) test cross-tenant read/write blocking, anonymous access, RPC scoping, NULL user_id invisibility, and service-role-only restrictions.

**Suite 3 — Media Lifecycle:** End-to-end user journey: upload → enrich → search → filter → stats. Tests watched_key upsert and cross-user isolation.

**Suite 4 — Media Storage:** S3 operations: upload, list, download, batch upload. Minimal changes from current `media-s3.test.ts`, BDD naming.

### CI Changes

- Merge `test:integration` and `test:media-integration` into single `test:integration` script
- Remove inline FTS smoke test from ci.yml
- Single vitest config handles both via `--project integration`
- `globalSetup` validates env before any test runs

## Constraints

- Must work on GitHub Actions `ubuntu-latest` with Supabase CLI
- Suite completes in under 3 minutes
- Tests clean up all data in `afterAll`
- No production secrets — local Supabase with default credentials
- `seedUserData()` is single source of truth for column lists

## Migration Plan

| Old File | Action |
|----------|--------|
| `__tests__/rls-policies.test.ts` | Delete → replaced by `tenant-isolation.test.ts` |
| `__tests__/rpc-user-isolation.test.ts` | Delete → merged into `tenant-isolation.test.ts` |
| `__tests__/migration-integrity.test.ts` | Delete → replaced by `schema-contract.test.ts` |
| `__tests__/integration/media-db.test.ts` | Delete → merged into `media-lifecycle.test.ts` |
| `__tests__/integration/media-pipeline.test.ts` | Delete → merged into `media-lifecycle.test.ts` |
| `__tests__/integration/media-s3.test.ts` | Delete → rewritten as `media-storage.test.ts` |
| `__tests__/integration/setup.ts` | Keep and extend |
| `vitest.integration.config.ts` | Delete |
| `vitest.media-integration.config.ts` | Delete |

## Execution Order

1. Create `schema-contract.test.ts` + `schema_info` migration — highest value
2. Extend `setup.ts` with `seedUserData()` + `assertInsert()` — prerequisite for suites 2-3
3. Create `tenant-isolation.test.ts` — merge and rewrite
4. Create `media-lifecycle.test.ts` — merge and rewrite
5. Rewrite `media-storage.test.ts` — BDD naming
6. Add `globalSetup.ts`, remove `skipIf` from all tests
7. Consolidate vitest config to `projects` approach
8. Update CI workflow (merge scripts, remove FTS smoke test)
9. Delete old test files and old vitest configs
