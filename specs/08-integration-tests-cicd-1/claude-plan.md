# Implementation Plan: Integration Test Refactor

## Background

The sitemgr project uses Supabase (Postgres + Auth + Storage) with a Next.js frontend deployed on Vercel. The database schema has evolved through 12 migrations, most recently dropping a `phone_number` column from `bucket_configs` and making `user_id` NOT NULL across all tables.

This column removal exposed a critical gap: the integration tests silently skipped instead of catching the schema drift. The root causes are (1) `describe.skipIf` hiding failures, (2) each test file maintaining its own inline seed data against a stale schema, and (3) no shared fixture layer.

This plan refactors the integration test suite to prevent this class of failure. It replaces 7 test files with 4 behavior-oriented suites, adds a shared seed layer, introduces fail-fast environment validation, and consolidates the vitest configuration.

**Note on schema:** The `phone_number` column was dropped from `bucket_configs` but still exists on `conversations` as a nullable column (no longer PK). The plan accounts for this throughout.

## Goals

1. **Zero silent skips.** Every test either runs or the suite fails loudly. No `.todo()`, no `describe.skipIf`.
2. **Schema-aware fixtures.** A single `seedUserData()` helper owns table column lists. When schema changes, one file changes.
3. **BDD organization.** Tests grouped by business behavior. Test names use "should ... when ..." pattern and read as specifications.
4. **Schema contract tests.** A new suite validates that the schema produced by migrations matches what application code expects — the test that would have caught the `phone_number` drift.

## Target File Structure

```
web/
├── __tests__/
│   ├── integration/
│   │   ├── globalSetup.ts              # Validates Supabase connectivity (NEW)
│   │   ├── setup.ts                    # Shared helpers + seedUserData (EXTEND)
│   │   ├── schema-contract.test.ts     # Schema verification (NEW)
│   │   ├── tenant-isolation.test.ts    # RLS + RPC isolation (NEW)
│   │   ├── media-lifecycle.test.ts     # Upload → enrich → search (NEW)
│   │   └── media-storage.test.ts       # S3 operations (REWRITE)
│   └── ... (unit tests, unchanged)
├── vitest.config.ts                    # Rewritten with projects config
supabase/
└── migrations/
    └── 2026MMDD000000_test_schema_info.sql   # schema_info() RPC (NEW)
```

**Deleted files:**
- `web/__tests__/rls-policies.test.ts`
- `web/__tests__/rpc-user-isolation.test.ts`
- `web/__tests__/migration-integrity.test.ts`
- `web/__tests__/rls-audit.test.ts` (all `it.todo()` stubs — unique cases absorbed into new suites)
- `web/__tests__/integration/media-db.test.ts`
- `web/__tests__/integration/media-pipeline.test.ts`
- `web/__tests__/integration/media-s3.test.ts`
- `web/vitest.integration.config.ts`
- `web/vitest.media-integration.config.ts`

## Section 1: Schema Info Migration

### Purpose

Create a test-support RPC function that exposes schema metadata through PostgREST. This lets `schema-contract.test.ts` verify indexes, RLS flags, and column metadata through the same HTTP API the application uses — no direct SQL access needed.

### Function Design

Create a single `schema_info()` RPC that returns a JSON object with four sections:

```typescript
interface SchemaInfo {
  tables: Array<{ table_name: string; has_rls: boolean }>;
  columns: Array<{ table_name: string; column_name: string; is_nullable: boolean; data_type: string }>;
  indexes: Array<{ index_name: string; table_name: string }>;
  functions: Array<{ function_name: string; argument_types: string; return_type: string }>;
  policies: Array<{ table_name: string; policy_name: string; command: string; roles: string[] }>;
}
```

The function queries `information_schema.tables`, `information_schema.columns`, `pg_indexes`, `pg_class`/`pg_catalog` for RLS status, `pg_policies` for policy metadata, and `information_schema.routines` for function signatures.

### Access Control

Grant `schema_info()` to the `service_role` only. Revoke access from `authenticated` and `anon` roles explicitly.

**Security note:** This function ships to production via the migration pipeline. This is an accepted trade-off: the function is read-only, returns only public schema metadata (not data), and is restricted to `service_role` which is never exposed to end users. PostgREST does not expose service-role-only functions through the anonymous or authenticated API. The alternative (Supabase seed files) doesn't run in CI, making it unsuitable.

### Migration File

Name: `supabase/migrations/2026MMDD000000_test_schema_info.sql` (use the next available timestamp after the last migration `20260315000002`).

The function should filter to the `public` schema only and exclude internal Supabase tables (those in `auth`, `storage`, `extensions` schemas).

## Section 2: Global Setup and Environment Validation

### Purpose

Replace `describe.skipIf(!canRun)` with a `globalSetup` that validates Supabase is running before any test executes. If validation fails, the entire suite fails with a clear error message telling the developer what to do.

### globalSetup.ts

The file exports a default `setup` function and optional `teardown`. The setup function:

1. Reads `NEXT_PUBLIC_SUPABASE_URL` from environment (default: `http://127.0.0.1:54321`)
2. Performs a simple `fetch(url)` health check against the Supabase REST API root URL (no Supabase client dependency needed in globalSetup)
3. If the request fails or times out (5s), throws an error:
   ```
   Integration tests require a running Supabase instance.
   Run: supabase start
   Then: npm run test:integration
   ```

Tests continue using `getSupabaseConfig()` from `setup.ts` to access connection details — no `provide()`/`inject()` needed.

### Registration

The `globalSetup` is registered in the vitest config under the integration project's `globalSetup` property. It only runs for integration tests, not unit tests.

### What This Replaces

Every existing test file has a pattern like:
```typescript
const canRun = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);
describe.skipIf(!canRun)("Suite Name", () => { ... });
```

All of these guards are removed. If the integration project is invoked, the tests must run.

## Section 3: Shared Seed Layer (setup.ts Extensions)

### Purpose

Extend the existing `setup.ts` to become the single source of truth for table column definitions and test data creation. When the schema changes, only this file needs updating.

### New Exports

**`seedUserData(admin, userId, opts?)`**

Creates a complete dataset for one test user. Inserts in dependency order: `user_profiles` → `events` → `enrichments` → `watched_keys` → `bucket_configs` → `conversations`.

Options control what gets created:
```typescript
interface SeedOptions {
  eventCount?: number;        // default: 2
  withEnrichments?: boolean;  // default: true
  withWatchedKeys?: boolean;  // default: true
  withBucketConfig?: boolean; // default: true
  withConversation?: boolean; // default: true
  withUserProfile?: boolean;  // default: true
}

interface SeedResult {
  userId: string;
  eventIds: string[];
  enrichmentIds: string[];
  watchedKeyIds: string[];
  bucketConfigId: string | null;
  conversationUserId: string | null;
}
```

Each table's column list is defined once in this function. The exact columns per table:
- `events`: `id, timestamp, device_id, type, content_type, content_hash, local_path, remote_path, metadata, parent_id, user_id`
- `enrichments`: `event_id, description, objects, context, tags, user_id` (fts is auto-generated)
- `watched_keys`: `s3_key, first_seen, event_id, etag, size_bytes, user_id`
- `bucket_configs`: `user_id, bucket_name, endpoint_url, access_key_id, secret_access_key, key_version`
- `conversations`: `user_id, history, phone_number` (phone_number is nullable, still exists on this table)
- `user_profiles`: `id, phone_number`

Event content is deterministic and unique per user — use a counter-based scheme: event IDs like `${userId.slice(0,8)}-evt-1`, `${userId.slice(0,8)}-evt-2`. This lets tests assert on specific values without randomness.

**`assertInsert(description, result)`**

Wraps a Supabase insert result and throws with full error context on failure. Use in `beforeAll` so seed failures produce clear messages:
```
Seed failed: "Insert Alice's events" — column "phone_number" does not exist (PGRST204)
```

This replaces the pattern of `if (result.error) throw new Error(...)` scattered across test files.

**`cleanupUserData(admin, userId)`**

Enhanced version of existing `cleanupTestData`. Deletes in reverse dependency order. Cleanup errors are logged via `console.warn` (not swallowed silently) but do not throw — cleanup must not mask test failures. Handles partial seeds gracefully (if only some tables were populated).

### Existing Exports (Unchanged)

`getSupabaseConfig()`, `getAdminClient()`, `createTestUser()`, `getS3Config()`, `TINY_JPEG` — all remain as-is.

## Section 4: Schema Contract Test Suite

### Purpose

Validate that the database schema produced by migrations matches what the application code expects. This is the highest-value test — it would have caught the `phone_number` column removal immediately.

### File: `web/__tests__/integration/schema-contract.test.ts`

### Test Groups

**Group 1: Table existence**
- Verify all expected public tables exist: `events`, `enrichments`, `watched_keys`, `bucket_configs`, `conversations`, `user_profiles`
- Use `schema_info()` RPC to get the table list
- Assert no unexpected tables are missing

**Group 2: Column contracts**
- For each table, verify expected columns exist with correct types and nullability
- Key assertions:
  - `bucket_configs` does NOT have `phone_number` (the exact drift that caused the failure)
  - `user_id` is NOT NULL on `events`, `enrichments`, `watched_keys`, `bucket_configs`
  - `conversations` has `user_id` as NOT NULL and as primary key
  - `conversations` still has `phone_number` as a nullable column (not dropped, unlike `bucket_configs`)
- Use `schema_info()` RPC for column metadata

**Group 3: Index existence**
- Verify critical indexes exist: `idx_enrichments_fts`, `idx_events_user_id`, `idx_events_timestamp`, `idx_bucket_configs_user_bucket`, `idx_watched_keys_user_id`
- Use `schema_info()` RPC for index list

**Group 4: RLS enforcement**
- Verify RLS is enabled on all user-data tables: `events`, `enrichments`, `watched_keys`, `bucket_configs`, `conversations`, `user_profiles`
- Use `schema_info()` RPC for RLS flags

**Group 5: NOT NULL constraints**
- Insert a row with `user_id: null` via admin client on each table that requires it
- Assert the insert is rejected with a constraint violation
- This validates the constraint at the application layer (PostgREST), not just metadata

**Group 6: RPC function existence**
- Call each RPC via `admin.rpc()` with minimal valid parameters
- Verify functions exist and accept expected parameter types: `search_events`, `stats_by_content_type`, `stats_by_event_type`, `get_user_id_from_phone`, `schema_info`

**Group 7: Policy structure (no redundant policies)**
- Use `schema_info()` to check that tables don't have redundant SELECT + ALL policies (from `rls-audit.test.ts` Finding 7)
- Verify `watched_keys`, `enrichments`, `conversations` each have clean policy sets without overlap
- This is a structural check — it validates migration cleanup was thorough

### Data Handling

This suite requires minimal seed data. Most tests check metadata or constraints, not data correctness. The few tests that insert (NOT NULL validation) clean up after themselves.

## Section 5: Tenant Isolation Test Suite

### Purpose

Merge `rls-policies.test.ts` and `rpc-user-isolation.test.ts` into a single behavior-oriented suite. These both validate the same business guarantee — multi-tenant data isolation — at different layers.

### File: `web/__tests__/integration/tenant-isolation.test.ts`

### Setup

`beforeAll`:
1. Create two test users (Alice and Bob) via `createTestUser()`
2. Seed both users' data via `seedUserData()` with known quantities
3. If any seed fails, `assertInsert()` throws immediately — suite aborts

`afterAll`:
1. Clean up both users' data via `cleanupUserData()`
2. Delete auth users via `admin.auth.admin.deleteUser()`

### Test Groups

**Group 1: Read isolation ("should only see own data when querying...")**
- For each table (`events`, `enrichments`, `watched_keys`, `bucket_configs`, `conversations`, `user_profiles`): Alice queries, sees only her data, none of Bob's
- Verify correct counts (Alice seeded 2 events, Bob seeded 1 event, etc.)

**Group 2: Write isolation ("should reject cross-tenant writes")**
- Alice tries to INSERT an event with Bob's `user_id` → rejected
- Alice tries to INSERT a `bucket_config` with Bob's `user_id` → rejected
- Alice tries to INSERT an enrichment with Bob's `user_id` → rejected
- Alice tries to UPDATE Bob's events → no rows affected
- Alice tries to DELETE Bob's bucket_configs → no rows affected

**Group 3: Anonymous access ("should block unauthenticated access")**
- Anonymous client (anon key, no auth) cannot SELECT from each table → empty results or access denied
- Anonymous client cannot INSERT into each table → rejected (test each table explicitly: events, enrichments, watched_keys, bucket_configs, conversations, user_profiles)

**Group 4: RPC scoping ("should scope RPC results to requesting user")**
- Alice calls `search_events` → only Alice's events
- Alice calls `search_events` with Bob's `user_id` parameter → empty (RLS blocks underlying data)
- Alice calls `stats_by_content_type` → counts reflect only Alice's data
- Alice calls `stats_by_event_type` → counts reflect only Alice's data

**Group 5: Service-role restrictions ("should block user access to admin functions")**
- Alice calls `get_user_id_from_phone` → permission denied
- Anonymous calls `get_user_id_from_phone` → permission denied
- Admin (service role) calls `get_user_id_from_phone` → succeeds

**Group 6: Append-only enforcement ("should prevent modification of events")**
- Alice tries to UPDATE her own events → rejected (no UPDATE policy exists)
- Alice tries to DELETE her own events → rejected (no DELETE policy exists)
- This validates the business invariant that events are immutable once created

**Note:** The `globalThis` UUID pattern from `rpc-user-isolation.test.ts` is eliminated. Test user IDs come from `SeedResult` return values, passed through `beforeAll` scope variables.

**Note:** NULL user_id handling is NOT tested here. Since `user_id` is NOT NULL on all tables, constraint validation is covered by `schema-contract.test.ts` Group 5.

### BDD Naming Convention

All test names follow the pattern: `it('should [behavior] when [condition]')`. Groups use `describe('when [context]')`.

## Section 6: Media Lifecycle Test Suite

### Purpose

Merge `media-db.test.ts` and `media-pipeline.test.ts` into a single end-to-end suite organized around the user journey from upload to search.

### File: `web/__tests__/integration/media-lifecycle.test.ts`

### Setup

`beforeAll`:
1. Create test user via `createTestUser()`
2. Create an S3 test bucket with dynamic name (`test-lifecycle-${Date.now()}`)
3. Seed bucket config for the user
4. Create second user (for isolation test)

`afterAll`:
1. Remove uploaded S3 objects (tracked in array during tests)
2. Delete test bucket
3. Clean up both users' data
4. Delete auth users

### Test Groups

**Group 1: Upload and search ("should find uploaded media via full-text search")**
- Upload a JPEG to S3
- Create an event record for the upload
- Create an enrichment with description "sunset over mountains"
- Call `search_events` with query "sunset" → returns the photo
- Call `search_events` with query "cat" → does not return the photo

**Group 2: Filtered search ("should filter results by content type and date range")**
- Seed events with different content types (photo, video) and timestamps
- Search with `content_type` filter → only matching type returned
- Search with date range → only events within range returned

**Group 3: Stats ("should reflect user's actual data in stats")**
- Seed known quantities: 2 photos, 1 video
- Call `stats_by_content_type` → photo=2, video=1
- Call `stats_by_event_type` → matches expected counts

**Group 4: Enrichment status ("should track enrichment progress")**
- Seed 3 events, create enrichment for 1
- Query enrichment status → pending=2, enriched=1

**Group 5: Watched key upsert ("should update metadata on re-scan")**
- Upsert a watched key with etag "abc"
- Upsert same key with etag "def"
- Query → etag is "def" (updated, not duplicated)

**Group 6: Cross-user isolation ("should not show other users' media")**
- Both users have events
- User A queries → User B's events not included
- This overlaps with tenant-isolation but validates at the media operation layer

### Timeout

This suite needs 60s timeout due to S3 operations and multiple DB round-trips.

## Section 7: Media Storage Test Suite

### Purpose

Rewrite `media-s3.test.ts` with BDD naming. The existing test is already clean and well-structured — minimal logic changes needed.

### File: `web/__tests__/integration/media-storage.test.ts`

### Test Groups

**Group 1: Upload and list**
- `it('should upload an object and list it in the bucket')`
- Upload a JPEG using `TINY_JPEG` fixture
- List objects with the test prefix → uploaded object appears

**Group 2: Download**
- `it('should download an uploaded object with correct content')`
- Upload, then download → content matches original

**Group 3: Empty listing**
- `it('should return empty list for nonexistent prefix')`
- List with a prefix that has no objects → empty array

**Group 4: Batch upload**
- `it('should upload and list multiple objects')`
- Upload 3 objects, list → all 3 present

### Timeout

60s timeout (S3 operations).

## Section 8: Vitest Configuration Consolidation

### Purpose

Replace the three separate vitest config files with a single `vitest.config.ts` using Vitest `projects` feature. The project uses Vitest `^4.0.18` — verify the `projects` configuration syntax against the Vitest 4.x documentation, as the API may differ from the 3.2 release where it was introduced.

### Configuration Structure

The root `vitest.config.ts` defines two projects:

**Project "unit":**
- Includes all test files except `__tests__/integration/**`, `__tests__/rls-policies*`, `__tests__/rpc-user-isolation*`, `__tests__/migration-integrity*`, `e2e/**`
- Default timeout (5s)
- No globalSetup
- Path alias: `@` → `process.cwd()`

**Project "integration":**
- Includes `__tests__/integration/**/*.test.ts`
- Test timeout: 60s (unified — the longest suite needs 60s for S3)
- Hook timeout: 30s
- globalSetup: `__tests__/integration/globalSetup.ts`
- `fileParallelism: false` (tests share the Supabase instance)
- `sequence.files`: Configure to run `schema-contract` first (fail fast on schema drift before data-heavy tests). Default alphabetical order would run media tests first, which is suboptimal.
- Path alias: `@` → `process.cwd()`

### NPM Scripts

```json
{
  "test": "vitest run --project unit",
  "test:integration": "vitest run --project integration",
  "test:all": "vitest run",
  "test:watch": "vitest --project unit"
}
```

### Files to Delete

- `web/vitest.integration.config.ts`
- `web/vitest.media-integration.config.ts`

## Section 9: CI Workflow Updates

### Purpose

Simplify the CI integration test job to use the consolidated vitest config and remove redundant checks.

### Changes to `.github/workflows/ci.yml`

**Replace two test commands with one:**

Current:
```yaml
- run: cd web && npm run test:integration
- run: cd web && npm run test:media-integration
```

New:
```yaml
- run: cd web && npm run test:integration
```

This single command runs all 4 test suites via the `--project integration` vitest config.

**Remove inline FTS smoke test:**

Delete the `psql` step that tests `search_events()` directly. This is now covered by `media-lifecycle.test.ts` (Group 1: upload and search) and `tenant-isolation.test.ts` (Group 4: RPC scoping).

**Keep everything else unchanged:**
- Supabase start/stop
- Environment variable extraction from `supabase status`
- Environment variable verification step (still useful as a guard)
- Node setup, npm ci, etc.

### Verification

After these changes, the CI job should:
1. Start Supabase (applies migrations including new `schema_info` migration)
2. Extract and verify env vars
3. Run `npm run test:integration` (4 suites, all in `__tests__/integration/`)
4. Stop Supabase

## Section 10: Old File Cleanup and Migration

### Purpose

Delete old test files and configs after all new suites are green. This is the final step — do not delete until new tests pass.

### Deletion Order

1. **Old test files** (replaced by new suites):
   - `web/__tests__/rls-policies.test.ts` → replaced by `tenant-isolation.test.ts`
   - `web/__tests__/rpc-user-isolation.test.ts` → merged into `tenant-isolation.test.ts`
   - `web/__tests__/migration-integrity.test.ts` → replaced by `schema-contract.test.ts`
   - `web/__tests__/rls-audit.test.ts` → all `it.todo()` stubs absorbed into `tenant-isolation.test.ts` (append-only, anon blocking, cross-tenant UPDATE/DELETE) and `schema-contract.test.ts` (policy structure). The phone_number auth path tests (Finding 4) are obsolete — phone auth was removed in migration `20260315000001`.
   - `web/__tests__/integration/media-db.test.ts` → merged into `media-lifecycle.test.ts`
   - `web/__tests__/integration/media-pipeline.test.ts` → merged into `media-lifecycle.test.ts`
   - `web/__tests__/integration/media-s3.test.ts` → replaced by `media-storage.test.ts`

2. **Old vitest configs** (replaced by projects config):
   - `web/vitest.integration.config.ts`
   - `web/vitest.media-integration.config.ts`

3. **Update unit test exclusions** in the new vitest config. The current `vitest.config.ts` explicitly excludes `rls-policies.test.ts`, `rpc-user-isolation.test.ts`, and `migration-integrity.test.ts`. These exclusions can be removed since the files no longer exist (along with `rls-audit.test.ts`) and the `integration/` directory is handled by the integration project.

### Verification

After deletion:
- `npm test` (unit tests) should still pass — no integration tests included
- `npm run test:integration` should run all 4 new suites
- No import errors or missing file references
- CI workflow runs clean

## Execution Dependencies

```
Section 1 (schema_info migration)
    ↓
Section 2 (globalSetup) ─────────────────────┐
    ↓                                          │
Section 3 (setup.ts extensions) ──────────────┤
    ↓                                          │
Section 4 (schema-contract.test.ts) ←─────── 1,2,3
    ↓                                          │
Section 5 (tenant-isolation.test.ts) ←────── 2,3
    ↓                                          │
Section 6 (media-lifecycle.test.ts) ←──────── 2,3
    ↓                                          │
Section 7 (media-storage.test.ts) ←────────── 2
    ↓                                          │
Section 8 (vitest config) ←─────────────────── all test suites working
    ↓
Section 9 (CI workflow) ←── 8
    ↓
Section 10 (cleanup) ←── all green
```

Sections 4-7 can be parallelized once sections 1-3 are complete.
Sections 8-10 are sequential cleanup after all suites pass.
