Now I have all the context I need. Let me generate the section content.

# Section 07: Migration Tests

## Overview

This section creates a forward migration test framework that verifies all 8 existing Supabase migrations apply cleanly, validates the resulting schema matches expectations, and tests data preservation across migrations. It also covers event store edge cases and the `watched_keys` primary key collision bug.

This section has **no dependencies** on other sections and can be implemented in parallel with sections 01, 02, and 09.

## Background

The project has 8 migration files in `/home/user/sitemgr/supabase/migrations/` applied in this order:

1. `20260305000000_initial_schema.sql` -- Creates `events`, `enrichments`, `watched_keys`, `conversations` tables, indexes, and the `immutable_array_to_string` helper function. Also creates the `media` storage bucket.
2. `20260305000001_rpc_functions.sql` -- Creates `stats_by_content_type()`, `stats_by_event_type()`, and `search_events()` RPC functions.
3. `20260306000000_fix_enrichments_fts.sql` -- Idempotent re-creation of tables with `IF NOT EXISTS` and re-creation of RPC functions with quoted reserved words.
4. `20260306000001_bucket_configs.sql` -- Creates `bucket_configs` table, adds `bucket_config_id` to `watched_keys` and `events`.
5. `20260306000002_add_user_id_to_bucket_configs.sql` -- Adds `user_id` column to `bucket_configs`, makes `phone_number` nullable, creates partial unique indexes.
6. `20260306000003_migrate_to_user_id.sql` -- Creates `user_profiles` table, adds `user_id` to `events`, `watched_keys`, `enrichments`, `conversations`. Creates `get_user_id_from_phone()` function.
7. `20260306000005_add_rls_policies.sql` -- Enables RLS on all tables, creates SELECT/INSERT/UPDATE/DELETE policies.
8. `20260312000000_add_encryption_key_version.sql` -- Adds `encryption_key_version` column to `bucket_configs`, creates update timestamp trigger.

These tests run against a local Supabase instance started with `supabase start`. They are integration tests, not unit tests.

## Tests

All tests go in a single file at `/home/user/sitemgr/web/__tests__/migration-integrity.test.ts`.

The test file uses Vitest (matching existing test patterns in the project) and connects to the local Supabase instance using the service role key (needed to bypass RLS for test setup/teardown and schema introspection).

### Test Infrastructure

The test file needs a Supabase admin client created using `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` from the local Supabase instance. These are set in CI via `supabase start` output (not via `vi.stubEnv`, because the tests connect to a real local service).

A helper function should query the `information_schema` to introspect tables, columns, indexes, and policies. Another helper queries `pg_proc` / `pg_catalog` to verify RPC functions exist.

### 4.2 Migration Test Framework

These tests verify that `supabase db reset` (which applies all migrations from scratch) produces the expected schema.

```
# Test: supabase db reset applies all 8 migrations without error
```

This test may be implemented as a `beforeAll` that runs `supabase db reset` via child process, or it may assume the local Supabase is already running with migrations applied. The simpler approach is to assume the local instance is running (started by the developer or CI) and verify the resulting schema.

```
# Test: all expected tables exist after migration
#   Tables: events, enrichments, watched_keys, bucket_configs, conversations, user_profiles
```

Query `information_schema.tables` where `table_schema = 'public'` and verify all 6 tables exist.

```
# Test: all expected indexes exist after migration
```

Query `pg_indexes` for the public schema. Verify at minimum these indexes exist:
- `idx_events_type`, `idx_events_content_type`, `idx_events_content_hash`, `idx_events_timestamp`, `idx_events_device_id`, `idx_events_remote_path`, `idx_events_parent_id`, `idx_events_user_id`, `idx_events_bucket`
- `idx_enrichments_fts` (GIN index), `idx_enrichments_user_id`
- `idx_watched_keys_bucket`, `idx_watched_keys_user_id`
- `idx_bucket_configs_phone`, `idx_bucket_configs_user_id`, `idx_bucket_configs_phone_bucket`, `idx_bucket_configs_user_bucket`, `idx_bucket_configs_key_version`
- `idx_conversations_user_id`

```
# Test: all expected RLS policies exist after migration
```

Query `pg_policies` for the public schema. Verify policies exist on `bucket_configs`, `events`, `watched_keys`, `enrichments`, `conversations`, and `user_profiles`.

```
# Test: all expected RPC functions exist after migration
```

Query `pg_proc` joined with `pg_namespace` where namespace is `public`. Verify these functions exist: `search_events`, `stats_by_content_type`, `stats_by_event_type`, `get_user_id_from_phone`, `immutable_array_to_string`, `update_bucket_config_timestamp`.

```
# Test: insert test data, apply next migration, verify data preserved
```

This test verifies data preservation by inserting rows into existing tables and confirming they survive. Since all migrations are already applied in the local instance, this test inserts data and verifies it can be read back. If testing incremental migration (inserting data before a specific migration, then applying it), this requires a more complex setup with `supabase migration up` targeting specific versions. For v1, the simpler approach of verifying data round-trips after all migrations are applied is sufficient.

### 4.3 Event Store and Schema Edge Cases

```
# Test: two events with same content_hash can both be inserted
```

Insert two events with identical `content_hash` but different `id` values. Both should succeed because there is no unique constraint on `content_hash` (deduplication is application-level via `findEventByHash()`).

```
# Test: event with valid parent_id references existing event
```

Insert a parent event, then insert a child event with `parent_id` pointing to the parent. Verify the child is inserted successfully and both events are queryable.

```
# Test: event with invalid parent_id is rejected by foreign key
```

Attempt to insert an event with a `parent_id` that does not exist in the `events` table. Verify the insert fails with a foreign key violation error.

```
# Test: events are retrievable sorted by timestamp
```

Insert multiple events with different timestamps. Query with `ORDER BY timestamp` and verify the results come back in chronological order. This implicitly verifies the `idx_events_timestamp` index is usable.

```
# Test: concurrent event inserts don't conflict
```

Use `Promise.all` to insert multiple events simultaneously. All inserts should succeed because there are no unique constraints on timestamps or other fields that would cause conflicts between different events.

### watched_keys Collision Tests

```
# Test: current schema rejects duplicate s3_key (demonstrating the bug)
```

Insert a `watched_key` with `s3_key = 'photos/test.jpg'` and one `bucket_config_id`. Attempt to insert another `watched_key` with the same `s3_key` but a different `bucket_config_id`. The second insert should fail because `s3_key` is the primary key -- this demonstrates the collision bug where two users with the same S3 key path in different buckets cannot both have records.

```
# Test: two watched_keys with same s3_key but different bucket_config_id can coexist (after fix)
```

This test documents the expected behavior after the primary key is changed from `s3_key` alone to `(s3_key, bucket_config_id)`. Initially this test should be written as a skipped/todo test that describes the desired behavior. A migration to fix the primary key will be created as part of this section (or a follow-up), and the test will be unskipped once the migration exists.

## Implementation Details

### Test File Structure

The test file at `/home/user/sitemgr/web/__tests__/migration-integrity.test.ts` should follow this structure:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";

// Use local Supabase instance
// These come from `supabase status` output
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const supabaseServiceKey = process.env.SUPABASE_SECRET_KEY ?? "...local service role key...";

describe("Migration Integrity", () => { /* ... */ });
describe("Event Store Edge Cases", () => { /* ... */ });
describe("watched_keys Collision", () => { /* ... */ });
```

Use the Supabase client's `.rpc()` method to execute raw SQL for schema introspection queries. Alternatively, use the `postgres` or `pg` npm package to connect directly to the local Postgres instance for introspection queries that are awkward through the Supabase client.

The local Supabase Postgres instance is typically available at `postgresql://postgres:postgres@127.0.0.1:54322/postgres` (port 54322 for direct access, not the API port 54321).

### Schema Introspection Queries

For verifying tables exist:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
```

For verifying indexes exist:
```sql
SELECT indexname FROM pg_indexes WHERE schemaname = 'public';
```

For verifying RLS policies exist:
```sql
SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public';
```

For verifying RPC functions exist:
```sql
SELECT p.proname FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public';
```

### Test Data Setup and Teardown

For event store edge case tests, the `beforeAll` block should create prerequisite data (such as a `bucket_config` record needed for `bucket_config_id` foreign keys on `watched_keys`). The `afterAll` block should clean up all inserted test data to avoid polluting the local database.

Use unique, identifiable test IDs (e.g., prefixed with `test-migration-`) so cleanup can target only test-created rows.

### watched_keys Fix Migration

If implementing the fix within this section, create a new migration file at `/home/user/sitemgr/supabase/migrations/` (with an appropriate timestamp) that:

1. Drops the existing primary key on `watched_keys.s3_key`
2. Creates a new composite primary key on `(s3_key, bucket_config_id)`
3. Handles existing rows where `bucket_config_id` may be NULL (the column was added as nullable in migration `20260306000001`)

The migration must handle the NULL `bucket_config_id` case carefully. Options:
- Make `bucket_config_id` NOT NULL (requires backfilling or deleting orphaned rows)
- Use a unique index instead of a primary key (allows NULLs in Postgres unique indexes)

The exact approach should be decided during implementation based on whether any `watched_keys` rows exist without a `bucket_config_id`.

### Running the Tests

These tests require a running local Supabase instance. The test command is:

```bash
cd /home/user/sitemgr/web && npm test -- migration-integrity
```

In CI, the workflow must run `supabase start` before executing these tests and export the URL/key environment variables from `supabase status`.