Good - `events.bucket_config_id` exists. Now I have everything I need.

# Section 2: Duplicate Detection RPC

## Overview

This section creates a Supabase RPC function `find_duplicate_groups` and a corresponding TypeScript wrapper `findDuplicateGroups()` in `db.ts`. The RPC groups events by `content_hash` to find files that appear more than once. It is tenant-isolated via both an explicit `p_user_id` parameter and RLS on the `events` table.

**No dependencies on other sections.** This section can be implemented in parallel with section-01 (hash normalization). Sections 03 (API route) and 04 (CLI) depend on this section's output.

## Files to Create/Modify

| File | Action |
|------|--------|
| `supabase/migrations/20260401000000_dedup_rpc.sql` | Create |
| `web/lib/media/db.ts` | Modify (add interface + function) |
| `web/__tests__/integration/dedup-rpc.test.ts` | Create |

## Tests First

Create `web/__tests__/integration/dedup-rpc.test.ts`. These are integration tests against real local Supabase (started via `supabase start`). Follow the patterns from `web/__tests__/integration/tenant-isolation.test.ts` for setup/teardown.

The test file uses the shared helpers from `web/__tests__/integration/setup.ts`: `getAdminClient`, `createTestUser`, `cleanupUserData`, `assertInsert`.

### Test: RPC returns 1 group when 3 events share a content_hash

```
Insert 3 events for the same user with identical content_hash "etag:duplicate-abc".
Call find_duplicate_groups via supabase.rpc().
Expect 1 group returned with copies=3, 3 event_ids, 3 paths.
```

### Test: RPC returns empty array when all content_hashes are unique

```
Insert 3 events for the same user, each with a different content_hash.
Call find_duplicate_groups.
Expect empty array (no groups).
```

### Test: tenant isolation — each user only sees their own duplicates

```
Create two users (alice, bob).
Insert 2 events for alice with content_hash "etag:shared-hash".
Insert 2 events for bob with the same content_hash "etag:shared-hash".
Call find_duplicate_groups for alice — expect 1 group with copies=2 (only alice's).
Call find_duplicate_groups for bob — expect 1 group with copies=2 (only bob's).
```

### Test: bucket_config_id filter narrows results

```
Create a user with two bucket configs.
Insert 2 events with same hash in bucket A, 2 events with same hash in bucket B.
Call find_duplicate_groups with p_bucket_config_id = bucket A's ID.
Expect only the group from bucket A.
```

### Test: events with NULL content_hash are excluded

```
Insert 2 events with content_hash = NULL and 2 events with content_hash = "etag:dup".
Call find_duplicate_groups.
Expect 1 group (the "etag:dup" pair). NULL events do not form a group.
```

### Test: events with type != 'create' are excluded

```
Insert 2 events with type='create' and content_hash "etag:dup".
Insert 1 event with type='delete' and content_hash "etag:dup".
Call find_duplicate_groups.
Expect 1 group with copies=2 (only the 'create' events).
```

### Test: findDuplicateGroups wrapper returns { data, error } shape

```
Call findDuplicateGroups() from db.ts with valid arguments.
Expect result to have { data, error } keys.
Expect data to be an array (possibly empty).
Expect error to be null on success.
```

### Test: findDuplicateGroups with no duplicates returns empty array

```
Call findDuplicateGroups() with a user that has no duplicate events.
Expect data to be an empty array (not null).
```

### Test setup/teardown pattern

Each test suite should:
- In `beforeAll`: create test users via `createTestUser()`, get admin client, seed events directly via admin client with controlled `content_hash` values
- In `afterAll`: clean up via `cleanupUserData()`, sign out clients, remove channels

When seeding events for these tests, do NOT use the generic `seedUserData()` helper (it assigns unique hashes per event). Instead, insert events directly via the admin client with explicit `content_hash` values to control duplicates. Use the `assertInsert` helper to verify inserts succeed.

Event insert shape (minimum required fields):

```typescript
{
  id: `${prefix}-evt-${i}`,          // unique string
  timestamp: new Date().toISOString(),
  device_id: `device-${prefix}`,
  type: "create",                     // or "delete" for exclusion test
  content_type: "image/jpeg",
  content_hash: "etag:duplicate-abc", // controlled value
  user_id: userId,
  remote_path: `s3://bucket/${prefix}/file-${i}.jpg`,
  bucket_config_id: bucketConfigId,   // optional, for filter tests
}
```

## Implementation: SQL Migration

Create `supabase/migrations/20260401000000_dedup_rpc.sql`.

The function follows the established pattern from `supabase/migrations/20260313000000_rpc_user_isolation.sql` where `stats_by_content_type` and `search_events` take `p_user_id UUID` as their first parameter, use `LANGUAGE sql STABLE`, and run as SECURITY INVOKER (the default — do NOT specify SECURITY DEFINER).

The function signature:

```sql
CREATE OR REPLACE FUNCTION find_duplicate_groups(
    p_user_id UUID,
    p_bucket_config_id UUID DEFAULT NULL
)
RETURNS TABLE(
    content_hash TEXT,
    copies BIGINT,
    event_ids TEXT[],
    paths TEXT[]
)
LANGUAGE sql STABLE
```

Query logic:
1. Select from `events` where `type = 'create'` AND `content_hash IS NOT NULL` AND `user_id = p_user_id`
2. Optionally filter by `bucket_config_id = p_bucket_config_id` when the parameter is not NULL
3. Group by `content_hash`
4. Use `HAVING count(*) > 1` to keep only duplicate groups
5. Return `content_hash`, `count(*) AS copies`, `array_agg(id) AS event_ids`, `array_agg(remote_path) AS paths`
6. Order by `copies DESC`

The optional bucket filter uses the pattern: `AND (p_bucket_config_id IS NULL OR bucket_config_id = p_bucket_config_id)`.

No new indexes needed. The existing `idx_events_content_hash` index exists. At expected scale (under 10K events), a sequential scan with RLS filtering is fast.

## Implementation: TypeScript Wrapper in db.ts

Modify `web/lib/media/db.ts` to add:

1. A `DuplicateGroup` interface (exported):

```typescript
export interface DuplicateGroup {
  content_hash: string;
  copies: number;
  event_ids: string[];
  paths: string[];
}
```

2. A `findDuplicateGroups` function (exported) placed after the existing `findEventByHash` function (around line 405, in the "Check Duplicate by Hash" section — thematically related):

```typescript
export async function findDuplicateGroups(
  client: SupabaseClient,
  userId: string,
  bucketConfigId?: string,
): Promise<{ data: DuplicateGroup[] | null; error: unknown }>
```

The function body calls `client.rpc('find_duplicate_groups', { p_user_id: userId, p_bucket_config_id: bucketConfigId ?? null })` and returns the result directly (no transformation, per CLAUDE.md coding principles — "pass through `{ data, error }` as-is").

When `bucketConfigId` is undefined, pass `null` explicitly for the RPC parameter so Supabase sends it as a SQL NULL (triggering the `DEFAULT NULL` in the function signature).