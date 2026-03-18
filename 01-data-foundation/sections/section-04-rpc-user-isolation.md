I have all the context needed. Let me produce the section content.

# Section 04: RPC User Isolation

## Overview

All three RPC functions in the database (`search_events()`, `stats_by_content_type()`, `stats_by_event_type()`) currently return data across ALL users with no tenant filtering. Additionally, the `get_user_id_from_phone()` function is `SECURITY DEFINER`, allowing any authenticated user to look up any phone number's user_id. This section creates a migration to fix both issues.

## Dependencies

- **section-02-rls-audit**: The audit identifies these RPC functions as vulnerable. Its findings inform what restrictions are needed.
- **section-03-client-refactor**: The split into `getAdminClient()` / `getUserClient()` determines which client calls these functions, which affects whether RLS would help. Since `getUserClient()` uses the publishable key, RLS applies -- but explicit `p_user_id` filtering is still required as defense-in-depth (the service-role admin client bypasses RLS).

## Current State

The three RPC functions are defined in two migration files:
- `/home/user/sitemgr/supabase/migrations/20260305000001_rpc_functions.sql` (original)
- `/home/user/sitemgr/supabase/migrations/20260306000000_fix_enrichments_fts.sql` (re-created with quoted reserved words)

All three use `LANGUAGE sql STABLE` with no explicit security context (defaults to `SECURITY INVOKER`). None accept a user_id parameter or filter by user.

**`search_events()`** joins `enrichments` with `events` and performs full-text search. It accepts `query_text`, `content_type_filter`, `since_filter`, `until_filter`, and `result_limit` -- but no user filter.

**`stats_by_content_type()`** and **`stats_by_event_type()`** aggregate across all rows in `events` with no parameters at all.

**`get_user_id_from_phone()`** is defined in `/home/user/sitemgr/supabase/migrations/20260306000003_migrate_to_user_id.sql` as `SECURITY DEFINER`. Any authenticated user can call it with any phone number and discover the associated user_id -- an information disclosure vulnerability.

The application calls these RPC functions from `/home/user/sitemgr/web/lib/media/db.ts`:
- `queryEvents()` calls `supabase.rpc("search_events", {...})` without a user_id param
- `getStats()` calls `supabase.rpc("stats_by_content_type")` and `supabase.rpc("stats_by_event_type")` with no params

---

## Tests

Create test file: `/home/user/sitemgr/web/__tests__/rpc-user-isolation.test.ts`

These are integration tests that run against local Supabase (`supabase start`). They verify that the modified RPC functions enforce user isolation.

```
# Test: search_events() with p_user_id param returns only that user's results
# Test: search_events() called without p_user_id param is rejected (function signature requires it)
# Test: stats_by_content_type() with p_user_id returns only that user's stats
# Test: stats_by_event_type() with p_user_id returns only that user's stats
# Test: FTS query uses GIN index (EXPLAIN ANALYZE shows Bitmap Index Scan)
# Test: get_user_id_from_phone() is not callable by anon role
# Test: get_user_id_from_phone() restricted to authorized callers only
```

**Test setup requirements:**
- Two authenticated test users (user A and user B) created via Supabase Admin API
- Events and enrichments inserted for each user with distinct content
- Enrichments should include searchable text so FTS queries return results

**Test structure (stubs):**

```typescript
// /home/user/sitemgr/web/__tests__/rpc-user-isolation.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Integration tests for RPC function user isolation.
 * Requires local Supabase running (`supabase start`).
 *
 * Setup: Create two test users, insert events+enrichments for each.
 * Verify each RPC function returns only the calling user's data.
 */

describe("RPC User Isolation", () => {
  // beforeAll: create test users, insert test data with distinct user_ids

  describe("search_events", () => {
    it("returns only results for the specified p_user_id", async () => {
      /** Call search_events with user A's ID, verify no user B results */
    });

    it("requires p_user_id parameter", async () => {
      /** Calling without p_user_id should fail (missing required param) */
    });
  });

  describe("stats_by_content_type", () => {
    it("returns only stats for the specified p_user_id", async () => {
      /** Call with user A's ID, verify counts match user A's data only */
    });
  });

  describe("stats_by_event_type", () => {
    it("returns only stats for the specified p_user_id", async () => {
      /** Call with user A's ID, verify counts match user A's data only */
    });
  });

  describe("get_user_id_from_phone", () => {
    it("is not callable by anon role", async () => {
      /** Connect as anon, call function, expect permission denied */
    });

    it("is restricted to service role only", async () => {
      /** Connect as authenticated user, call function, expect permission denied */
    });
  });

  describe("FTS index usage", () => {
    it("search_events uses GIN index on enrichments.fts", async () => {
      /**
       * Run EXPLAIN ANALYZE on search_events query via admin client.
       * Verify plan includes "Bitmap Index Scan" on idx_enrichments_fts.
       */
    });
  });

  // afterAll: clean up test users and data
});
```

---

## Implementation

### Step 1: Create Migration File

Create a new migration file at:
`/home/user/sitemgr/supabase/migrations/20260313000000_rpc_user_isolation.sql`

The migration timestamp must sort after `20260312000000` (the latest existing migration).

This migration does four things:

#### 1a. Add `p_user_id UUID` to `search_events()`

Replace the function with a new version that has `p_user_id UUID` as the first parameter (required, no default). Add `AND e.user_id = p_user_id` to the WHERE clause.

The full parameter list becomes:
```
p_user_id UUID,
query_text TEXT,
content_type_filter TEXT DEFAULT NULL,
since_filter TEXT DEFAULT NULL,
until_filter TEXT DEFAULT NULL,
result_limit INT DEFAULT 20
```

The WHERE clause adds: `AND e.user_id = p_user_id`

The RETURNS TABLE stays the same. Use `CREATE OR REPLACE FUNCTION`.

#### 1b. Add `p_user_id UUID` to `stats_by_content_type()`

Add `p_user_id UUID` as a required parameter. Add `AND user_id = p_user_id` to the WHERE clause (the existing `WHERE type = 'create'` becomes `WHERE type = 'create' AND user_id = p_user_id`).

#### 1c. Add `p_user_id UUID` to `stats_by_event_type()`

Add `p_user_id UUID` as a required parameter. Add `WHERE user_id = p_user_id` (currently has no WHERE clause).

#### 1d. Restrict `get_user_id_from_phone()`

Move the function to be callable only by the service role. The approach: revoke execute from `public`, `anon`, and `authenticated` roles, then grant execute only to `service_role`.

```sql
REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) TO service_role;
```

This keeps the function as `SECURITY DEFINER` (it needs to read `user_profiles` which has RLS), but restricts who can call it to the service role only, which is used by admin/background operations.

### Step 2: Update Application Call Sites

Modify `/home/user/sitemgr/web/lib/media/db.ts` to pass `p_user_id` to all three RPC calls.

**`queryEvents()`** -- the function needs a `userId` parameter (or it must be added to `QueryOptions`). Pass it to the RPC call:

```typescript
// Before:
supabase.rpc("search_events", {
  query_text: opts.search,
  content_type_filter: opts.type ?? null,
  ...
});

// After:
supabase.rpc("search_events", {
  p_user_id: opts.userId,  // new required field
  query_text: opts.search,
  content_type_filter: opts.type ?? null,
  ...
});
```

**`getStats()`** -- this function needs a `userId` parameter added to its signature. Pass it to both RPC calls:

```typescript
// Before:
export async function getStats() { ... }

// After:
export async function getStats(userId: string) { ... }
// Then:
supabase.rpc("stats_by_content_type", { p_user_id: userId })
supabase.rpc("stats_by_event_type", { p_user_id: userId })
```

All callers of `getStats()` must be updated to pass a userId. Search the codebase for `getStats(` to find all call sites.

### Step 3: Verify FTS Index Usage

After the migration is applied, run the following against local Supabase to verify the GIN index is still used with the added user_id filter:

```sql
EXPLAIN ANALYZE SELECT * FROM search_events(
  '<test-user-uuid>'::uuid,
  'test query',
  NULL, NULL, NULL, 20
);
```

The plan should show a "Bitmap Index Scan" on `idx_enrichments_fts`. If the user_id filter on the `events` table prevents the planner from using the GIN index on `enrichments`, consider adding the user_id filter after the FTS filter in the query or restructuring the join order. This is documented as a known consideration in the implementation plan's FTS + RLS interaction notes (Section 2.4 of the plan).

---

## Files to Create or Modify

| File | Action |
|------|--------|
| `supabase/migrations/20260313000000_rpc_user_isolation.sql` | **Create** -- migration with all four changes |
| `web/lib/media/db.ts` | **Modify** -- add `p_user_id` to all RPC calls, add `userId` params to `queryEvents` options and `getStats` |
| `web/__tests__/rpc-user-isolation.test.ts` | **Create** -- integration tests for user isolation |

---

## Verification Checklist

1. Migration applies cleanly on local Supabase (`supabase db reset`)
2. `search_events()` requires `p_user_id` and filters results by it
3. `stats_by_content_type()` requires `p_user_id` and filters results by it
4. `stats_by_event_type()` requires `p_user_id` and filters results by it
5. `get_user_id_from_phone()` is not callable by `anon` or `authenticated` roles
6. `get_user_id_from_phone()` is callable by `service_role`
7. FTS queries still use the GIN index on `enrichments.fts`
8. All TypeScript call sites in `db.ts` pass the user ID to RPC calls
9. All callers of `getStats()` updated to pass userId

---

## Implementation Notes (Post-Implementation)

### Files Created
- `supabase/migrations/20260313000000_rpc_user_isolation.sql` — Migration adding p_user_id to 3 RPC functions and restricting get_user_id_from_phone
- `web/__tests__/rpc-user-isolation.test.ts` — Integration tests (skipped without local Supabase)

### Files Modified
- `web/lib/media/db.ts` — Added userId to QueryOptions, getStats; pass p_user_id to RPC calls
- `web/lib/agent/core.ts` — Added TODO(section-08) comment at getStats() call site
- `web/bin/smgr.ts` — Added TODO(section-08) comment at getStats() call site

### Deviations from Plan
- `userId` parameter is optional (not required) in TypeScript — callers in core.ts and smgr.ts don't have user_id resolution yet (section-08). Passing undefined results in NULL p_user_id which returns empty RPC results. TODO comments added.
- Migration reordered: DROP old search_events overload BEFORE CREATE new one (reviewer recommendation to avoid window with insecure function)
- FTS index usage test is a smoke test (checks query succeeds) rather than EXPLAIN ANALYZE verification

### Code Review Findings Addressed
- Migration DROP order fixed (auto-fix)
- TODO comments added at callers without userId (user decision: keep optional)
- Deferred: authenticated-role test for get_user_id_from_phone, EXPLAIN ANALYZE FTS test

### Test Results
- 6 new integration tests in rpc-user-isolation.test.ts (skipped without local Supabase)
- 97 total tests passing, 6 skipped (integration), 51 todo