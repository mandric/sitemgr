Now I have all the context needed. Let me generate the section content.

# Section 08: Phone-to-user_id Migration

## Overview

This section implements the three-phase migration from phone_number-based authentication to user_id-only authentication across all database tables. It also updates application-layer insert and query functions to work with user_id, and migrates the `conversations` table primary key from `phone_number` to `user_id`.

**Dependencies:** This section requires completion of:
- **Section 02 (RLS Audit)** -- understanding of current RLS policy structure
- **Section 03 (Client Refactor)** -- `getAdminClient()` and `getUserClient()` must exist
- **Section 04 (RPC User Isolation)** -- RPC functions must already have `p_user_id` parameters
- **Section 06 (RLS Tests)** -- baseline RLS test suite must exist to verify before/after behavior

## Background

The current schema uses a dual authentication model: records can be identified by either `phone_number` (WhatsApp bot path) or `user_id` (web auth path). This creates complexity in RLS policies via OR conditions like:

```sql
auth.uid() = user_id OR
(user_id IS NULL AND phone_number = auth.jwt()->>'phone')
```

The goal is to make `user_id` the sole tenant identifier. Phone numbers remain in `user_profiles` for WhatsApp display and in `conversations` as a regular (non-auth) column.

### Current Schema State

Tables affected and their current columns:

- **`events`**: Has `user_id UUID` (nullable, added in migration `20260306000003`). RLS checks `auth.uid() = user_id` only.
- **`enrichments`**: Has `user_id UUID` (nullable, added in `20260306000003`). RLS checks `auth.uid() = user_id` only.
- **`watched_keys`**: Has `user_id UUID` (nullable, added in `20260306000003`). RLS checks `auth.uid() = user_id` only.
- **`bucket_configs`**: Has both `phone_number TEXT` (nullable) and `user_id UUID` (nullable, added in `20260306000002`). RLS uses the dual OR pattern. Has check constraint `bucket_configs_auth_method_check` requiring at least one of phone_number or user_id.
- **`conversations`**: Primary key is `phone_number TEXT`. Has `user_id UUID` (nullable, added in `20260306000003`). RLS checks `auth.uid() = user_id` only.
- **`user_profiles`**: Primary key is `id UUID` (references `auth.users`). Has `phone_number TEXT UNIQUE`. Not affected by this migration.

### Current Application Code State

In `/home/user/sitemgr/web/lib/media/db.ts`:
- `insertEvent()` does not set `user_id`
- `insertEnrichment()` does not set `user_id`
- `upsertWatchedKey()` does not set `user_id`
- `getWatchedKeys()` has no user filtering
- `queryEvents()` has no user_id filter on direct queries
- `listBuckets()` in `/home/user/sitemgr/web/lib/agent/core.ts` queries by `phone_number`
- `addBucket()` inserts with `phone_number` only, no `user_id`
- `removeBucket()` deletes by `phone_number`
- `getBucketConfig()` queries by `phone_number`
- `getConversationHistory()` queries by `phone_number`
- `saveConversationHistory()` upserts with `phone_number`

---

## Tests

All tests use Vitest. Migration tests run against local Supabase (`supabase start`). Application code tests use mocked Supabase clients.

### File: `/home/user/sitemgr/web/__tests__/phone-migration-phase1.test.ts`

Phase 1 backfill migration tests (integration, run against local Supabase):

```
# Test: records with phone_number and NULL user_id get user_id backfilled
# Test: records with existing user_id are not modified
# Test: unmatched phone numbers (no user_profile) are left as-is
# Test: backfill migration applies without error on empty database
# Test: backfill migration applies without error on database with existing data
```

### File: `/home/user/sitemgr/web/__tests__/phone-migration-phase2.test.ts`

Phase 2 simplified RLS tests (integration, run against local Supabase):

```
# Test: simplified RLS policies use (SELECT auth.uid()) = user_id pattern
# Test: policies include TO authenticated restriction
# Test: phone_number-only records are no longer accessible (expected after backfill)
# Test: user_id-based access works correctly
```

### File: `/home/user/sitemgr/web/__tests__/phone-migration-phase3.test.ts`

Phase 3 schema cleanup tests (integration, run against local Supabase):

```
# Test: user_id is NOT NULL on events, bucket_configs, watched_keys
# Test: insert without user_id is rejected
# Test: conversations primary key is user_id (after migration)
# Test: phone_number columns dropped from tables that don't need them
```

### File: `/home/user/sitemgr/web/__tests__/phone-migration-app.test.ts`

Application code change tests (unit tests with mocked Supabase):

```
# Test: insertEvent() includes user_id parameter
# Test: insertEnrichment() includes user_id parameter
# Test: upsertWatchedKey() includes user_id parameter
# Test: agent executeAction() resolves phone to user_id before DB operations
# Test: all query functions include .eq('user_id', userId) filter
```

---

## Implementation

### Phase 1: Backfill user_id

**Create migration file:** `/home/user/sitemgr/supabase/migrations/20260315000000_backfill_user_id.sql`

This migration backfills `user_id` on all records that have a `phone_number` but NULL `user_id`, by looking up the user_id from the `user_profiles` table.

The migration should:

1. Update `events` -- set `user_id` from `user_profiles` where `events.user_id IS NULL` and the event can be traced to a phone number. Since `events` does not have a direct `phone_number` column, the join path is through `bucket_configs` (via `bucket_config_id`) or through the `device_id` column (which uses the pattern `whatsapp:{phone_number}` as seen in `core.ts` line 642). Use both paths:
   - Join `events.bucket_config_id` to `bucket_configs.id` to get `phone_number`, then look up `user_profiles`
   - Parse `device_id` pattern `whatsapp:+NNNNN` to extract phone_number, then look up `user_profiles`

2. Update `enrichments` -- set `user_id` by joining through `events` (enrichments reference events via `event_id`)

3. Update `watched_keys` -- set `user_id` by joining through `bucket_configs` (via `bucket_config_id`)

4. Update `bucket_configs` -- set `user_id` from `user_profiles` where `phone_number` matches and `user_id IS NULL`

5. Update `conversations` -- set `user_id` from `user_profiles` where `conversations.phone_number` matches and `user_id IS NULL`

For unmatched phone numbers (no corresponding `user_profiles` row), leave `user_id` as NULL. These represent orphaned records that need manual review. Add a comment in the migration noting this.

The migration must be safe to run on an empty database (no-op if no rows match).

### Phase 2: Simplify RLS Policies

**Create migration file:** `/home/user/sitemgr/supabase/migrations/20260315000001_simplify_rls.sql`

This migration drops all existing RLS policies and recreates them with the simplified user_id-only pattern. It also applies the performance optimizations from Section 02 (SELECT wrapping, TO authenticated).

For each table (`events`, `enrichments`, `watched_keys`, `bucket_configs`, `conversations`):

1. Drop all existing policies (use `DROP POLICY IF EXISTS`)
2. Create new policies using the pattern:
   ```sql
   CREATE POLICY "policy_name"
   ON table_name FOR operation
   TO authenticated
   USING ((SELECT auth.uid()) = user_id);
   ```
3. For INSERT policies, use `WITH CHECK` instead of `USING`:
   ```sql
   CREATE POLICY "policy_name"
   ON table_name FOR INSERT
   TO authenticated
   WITH CHECK ((SELECT auth.uid()) = user_id);
   ```

Key details:
- The `(SELECT auth.uid())` wrapping (note the parentheses) causes Postgres to evaluate `auth.uid()` once per statement via initPlan caching, rather than once per row. This is a documented Supabase performance optimization.
- The `TO authenticated` clause prevents the policy from executing at all for anon-role connections.
- The `user_profiles` table policies remain unchanged (they already use `auth.uid() = id` which is correct).

### Phase 3: Schema Cleanup

**Create migration file:** `/home/user/sitemgr/supabase/migrations/20260315000002_schema_cleanup.sql`

This migration enforces NOT NULL on user_id columns and drops unnecessary phone_number columns. It is **not easily reversible** because it drops columns.

Steps:

1. **Make user_id NOT NULL** on `events`, `enrichments`, `watched_keys`, `bucket_configs`:
   ```sql
   ALTER TABLE events ALTER COLUMN user_id SET NOT NULL;
   ```
   This will fail if any NULL user_id rows remain from Phase 1 (unmatched phones). The implementer must verify backfill completeness before applying.

2. **Migrate conversations primary key** (Option A from the plan):
   - Drop old primary key on `phone_number`
   - Make `user_id` NOT NULL
   - Add new primary key on `user_id`
   - Keep `phone_number` as a regular column (needed for WhatsApp display)

3. **Drop phone_number columns** from tables that no longer need them:
   - `bucket_configs.phone_number` -- drop column (also drop the check constraint `bucket_configs_auth_method_check`, the partial unique index `idx_bucket_configs_phone_bucket`, and the index `idx_bucket_configs_phone`)
   - `events` does not have a `phone_number` column (it uses `device_id`), so no drop needed
   - `watched_keys` does not have a `phone_number` column, so no drop needed
   - `enrichments` does not have a `phone_number` column, so no drop needed
   - Keep `phone_number` on `conversations` (used for WhatsApp display) and `user_profiles` (canonical phone storage)

4. **Update unique constraints on bucket_configs**:
   - Drop the partial unique index `idx_bucket_configs_user_bucket` (WHERE user_id IS NOT NULL)
   - Create a regular unique constraint on `(user_id, bucket_name)` since user_id is now NOT NULL

### Application Code Changes

**Modify:** `/home/user/sitemgr/web/lib/media/db.ts`

1. **`insertEvent()`** -- Add required `user_id` parameter to the function signature and include it in the insert payload. The `EventRow` interface already has `user_id?: string | null` but it should become required in the insert type.

2. **`insertEnrichment()`** -- Add `user_id` parameter and include it in the insert payload.

3. **`upsertWatchedKey()`** -- Add `user_id` parameter and include it in the upsert payload.

4. **`getWatchedKeys()`** -- Add `userId` parameter and filter with `.eq('user_id', userId)`.

5. **`queryEvents()`** -- Add `userId` to `QueryOptions` and apply `.eq('user_id', userId)` filter on direct queries. For the RPC `search_events()` path, pass `p_user_id` (already added in Section 04).

6. **`getStats()`** -- Add `userId` parameter. Pass it to the RPC calls `stats_by_content_type` and `stats_by_event_type` as `p_user_id` (already added in Section 04). Add `.eq('user_id', userId)` to the count queries.

7. **`getPendingEnrichments()`** -- Add `userId` parameter and filter both queries.

8. **`findEventByHash()`** -- Add `userId` parameter and filter.

9. **`showEvent()`** -- Add `userId` parameter and filter (defense in depth alongside RLS).

10. **`getEnrichStatus()`** -- Add `userId` parameter and filter.

**Modify:** `/home/user/sitemgr/web/lib/agent/core.ts`

1. **`executeAction()`** -- Currently receives `phoneNumber: string`. After this migration, it must resolve phone to user_id before any DB operations:
   - At the top of `executeAction()`, call `get_user_id_from_phone()` RPC (or query `user_profiles` directly via admin client) to resolve `phoneNumber` to `userId`
   - Pass `userId` to all DB functions instead of (or in addition to) `phoneNumber`
   - The function signature should accept both `phoneNumber` and optionally `userId` to support the transition

2. **`addBucket()`** -- Change from inserting with `phone_number` to inserting with `user_id`. Resolve phone to user_id first.

3. **`listBuckets()`** -- Change `.eq('phone_number', phoneNumber)` to `.eq('user_id', userId)`.

4. **`removeBucket()`** -- Change `.eq('phone_number', phoneNumber)` to `.eq('user_id', userId)`.

5. **`getBucketConfig()`** -- Change `.eq('phone_number', phoneNumber)` to `.eq('user_id', userId)`.

6. **`getConversationHistory()`** -- After conversations PK migration, query by `user_id` instead of `phone_number`. Keep phone_number as a display field.

7. **`saveConversationHistory()`** -- Upsert using `user_id` as the key instead of `phone_number`. Include `phone_number` as a data field for display purposes.

8. **`indexBucket()`** -- Pass `userId` to `insertEvent()`, `upsertWatchedKey()`, and `insertEnrichment()` calls. The `device_id` field can keep the `whatsapp:{phone}` pattern for provenance tracking.

### Rollback Safety

Each migration phase is a separate file that can be rolled back independently:

- **Phase 1 (backfill)**: Reversible by setting backfilled user_id values back to NULL. Low risk.
- **Phase 2 (RLS simplification)**: Reversible by restoring old policy definitions. Medium risk -- phone-only records become inaccessible.
- **Phase 3 (schema cleanup)**: **Not easily reversible** because it drops columns and changes primary keys. Require explicit confirmation and backup before applying. High risk.

The implementer should apply Phase 1, verify completeness (query for remaining NULL user_id rows), then apply Phase 2, run the RLS test suite from Section 06 to confirm correct behavior, and only then apply Phase 3.