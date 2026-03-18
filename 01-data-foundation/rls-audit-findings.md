# RLS Security Audit Findings

**Audit date:** 2026-03-17
**Auditor:** Automated (section-02-rls-audit)
**Scope:** All 6 tables with RLS enabled across 6 migration files + `web/lib/media/db.ts` client code

## Summary

| Severity | Count |
|----------|-------|
| Critical | 1     |
| High     | 2     |
| Medium   | 2     |
| Low      | 2     |
| Info     | 1     |

---

### Finding 1: Service role key bypasses RLS for all server operations

**Severity:** Critical
**Table(s):** events, enrichments, watched_keys, bucket_configs, conversations, user_profiles
**Category:** Bypass
**Description:** `getSupabaseClient()` in `web/lib/media/db.ts` (lines 7-18) prefers `SUPABASE_SECRET_KEY` (service role key) over the publishable key. The service role key bypasses RLS entirely. Every query and mutation function in `db.ts` uses this single client, meaning RLS is never enforced for any server-side operation.

**Current behavior:** All 10 exported functions in `db.ts` call `getSupabaseClient()` which returns a service-role client. This means:
- `queryEvents()` (line 48) -- returns events from ALL users
- `showEvent()` (line 98) -- can show any user's event by ID
- `getStats()` (line 126) -- aggregates across all users
- `insertEvent()` (line 198) -- can insert events for any user_id
- `insertEnrichment()` (line 209) -- can insert enrichments for any event
- `upsertWatchedKey()` (line 226) -- can upsert watched keys for any user
- `getWatchedKeys()` (line 248) -- returns all watched keys across all users
- `findEventByHash()` (line 259) -- searches events across all users
- `getPendingEnrichments()` (line 273) -- returns pending enrichments across all users
- `getEnrichStatus()` (line 172) -- counts across all users

The key selection logic at lines 10-12 is:
```typescript
const key = (
  process.env.SUPABASE_SECRET_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
)?.replace(/\s+/g, "");
```
This prioritizes the service role key, so if both are set (as they would be in production), the service role key is always used.

**Expected behavior:** Two separate clients should exist:
- `getAdminClient()` -- uses service role key, for background jobs and enrichment pipeline
- `getUserClient(token)` -- uses publishable key with user auth context, for user-facing operations

Call sites should be classified:
- **Admin-appropriate** (keep service role): `insertEnrichment()`, `upsertWatchedKey()`, `getWatchedKeys()`, `getPendingEnrichments()`, `getEnrichStatus()` (background enrichment pipeline)
- **User-facing** (must use user client): `queryEvents()`, `showEvent()`, `getStats()`, `insertEvent()`, `findEventByHash()`

**Remediation:** section-03-client-refactor

---

### Finding 2: `get_user_id_from_phone()` information disclosure

**Severity:** High
**Table(s):** user_profiles
**Category:** Information Disclosure
**Description:** The `get_user_id_from_phone()` function defined in `20260306000003_migrate_to_user_id.sql` (lines 44-58) is declared as `SECURITY DEFINER`, which means it executes with the database owner's privileges, bypassing RLS on `user_profiles`. It accepts any phone number as input and returns the corresponding `user_id` UUID. There is no authorization check -- any authenticated user (or even anon, since there is no `TO` restriction) can call this function with arbitrary phone numbers to discover other users' UUIDs.

**Current behavior:** Any caller can execute:
```sql
SELECT get_user_id_from_phone('+15551234567');
```
and receive the UUID of the user with that phone number. This leaks user identity information.

**Expected behavior:** This function should either:
1. Be restricted to the `service_role` only (not callable by `authenticated` or `anon` roles), or
2. Be moved to a private schema not exposed via PostgREST, or
3. Include an authorization check that only allows querying one's own phone number

**Remediation:** section-04-rpc-user-isolation

---

### Finding 3: RPC functions lack user_id filtering (cross-tenant data leakage)

**Severity:** High
**Table(s):** events, enrichments
**Category:** Leakage
**Description:** All three RPC functions in `20260305000001_rpc_functions.sql` lack any `user_id` or `auth.uid()` filtering in their SQL:

1. `stats_by_content_type()` (lines 4-13) -- `SELECT content_type, count(*) FROM events WHERE type = 'create' GROUP BY content_type` -- aggregates across ALL users
2. `stats_by_event_type()` (lines 16-24) -- `SELECT type, count(*) FROM events GROUP BY type` -- aggregates across ALL users
3. `search_events()` (lines 27-65) -- Joins `enrichments` and `events` with no user_id filter -- returns results across ALL users

These functions use `LANGUAGE sql STABLE` with implicit `SECURITY INVOKER` (the default). When called via the service role key (as `getSupabaseClient()` currently does), RLS is fully bypassed and cross-tenant data is returned.

Even when called with a publishable key + user JWT, the behavior depends on RLS:
- `search_events()`: Joins through `events` (which has RLS on `user_id`), so RLS would filter rows. However, the `enrichments` table is also accessed, and its RLS also checks `user_id`. This should work correctly with SECURITY INVOKER.
- `stats_by_content_type()` and `stats_by_event_type()`: Query `events` directly. With RLS active, results would be filtered. But this is fragile -- the functions should explicitly filter by user_id as defense in depth.

**Current behavior:** All stats and search results include data from every user in the system.
**Expected behavior:** Each function should accept a `p_user_id UUID DEFAULT auth.uid()` parameter and include `WHERE user_id = p_user_id` in the query. This provides defense in depth beyond RLS.
**Remediation:** section-04-rpc-user-isolation

---

### Finding 4: `bucket_configs` dual auth OR-condition widens access surface

**Severity:** Medium
**Table(s):** bucket_configs
**Category:** Authorization
**Description:** All four policies on `bucket_configs` (SELECT, INSERT, UPDATE, DELETE) in `20260306000005_add_rls_policies.sql` (lines 8-37) use the pattern:
```sql
auth.uid() = user_id OR (user_id IS NULL AND phone_number = auth.jwt()->>'phone')
```

This dual-auth pattern creates the following risk scenarios:

1. **NULL user_id records accessible via phone claim:** If a `bucket_configs` row has `user_id IS NULL` but has a `phone_number`, any authenticated user whose JWT `phone` claim matches that phone number gets access. This is intentional for the WhatsApp bot migration path, but it means the phone claim in the JWT becomes a secondary authorization vector.

2. **Both NULL analysis:** If a record has both `user_id IS NULL` AND `phone_number IS NULL`, the second branch evaluates to `NULL AND (NULL = <phone_claim>)` which is `NULL`, which is falsy. Combined with the first branch (`auth.uid() = NULL` which is also `NULL`/falsy), no access is granted. So a double-NULL record is effectively orphaned -- not a security hole, but a data integrity concern.

3. **Phone claim spoofing:** If Supabase auth allows setting arbitrary phone claims in JWTs (e.g., through custom claims or a compromised auth flow), an attacker could access any bucket_config by spoofing the phone number. The security of this path depends entirely on the integrity of the JWT `phone` claim.

The `CHECK` constraint in `20260306000002_add_user_id_to_bucket_configs.sql` (line 25-26) prevents the double-NULL case at the data level:
```sql
CHECK (phone_number IS NOT NULL OR user_id IS NOT NULL)
```

**Current behavior:** Two separate authorization paths exist for `bucket_configs`, creating a wider attack surface than necessary.
**Expected behavior:** After phone-to-user_id migration completes, eliminate the phone_number branch entirely so all access is via `auth.uid() = user_id`.
**Remediation:** section-08-phone-migration

---

### Finding 5: No `TO authenticated` clause on any policy

**Severity:** Medium
**Table(s):** events, enrichments, watched_keys, bucket_configs, conversations, user_profiles
**Category:** Authorization
**Description:** None of the 15 RLS policies across all 6 tables include a `TO authenticated` (or `TO anon`) role specification. Without a `TO` clause, policies apply to all roles, meaning the policy USING/WITH CHECK expressions are evaluated even for anonymous (unauthenticated) requests.

For the current policies, `auth.uid()` returns NULL for anonymous users, so `auth.uid() = user_id` evaluates to NULL (falsy), and no rows are returned. This means anonymous users are effectively blocked. However, this is relying on the behavior of `auth.uid()` returning NULL rather than explicitly restricting the policy scope.

Adding `TO authenticated` provides defense in depth: the policy is never evaluated for anon users, making authorization behavior explicit and not dependent on NULL-comparison semantics.

Affected policies (all in `20260306000005_add_rls_policies.sql`):
- Lines 8-13: `bucket_configs` SELECT
- Lines 16-21: `bucket_configs` INSERT
- Lines 24-29: `bucket_configs` UPDATE
- Lines 33-37: `bucket_configs` DELETE
- Lines 43-45: `events` SELECT
- Lines 48-50: `events` INSERT
- Lines 56-58: `watched_keys` SELECT
- Lines 61-64: `watched_keys` ALL
- Lines 70-72: `enrichments` SELECT
- Lines 75-78: `enrichments` ALL
- Lines 84-86: `conversations` SELECT
- Lines 89-92: `conversations` ALL

And in `20260306000003_migrate_to_user_id.sql`:
- Lines 15-17: `user_profiles` SELECT
- Lines 19-21: `user_profiles` UPDATE
- Lines 23-25: `user_profiles` INSERT

**Current behavior:** Policy expressions evaluate for anon role but return no rows due to NULL comparison.
**Expected behavior:** Policies should include `TO authenticated` to explicitly prevent evaluation for anon role.
**Remediation:** section-08-phone-migration (Phase 2 RLS rewrite)

---

### Finding 6: Missing `(SELECT auth.uid())` wrapping (per-row evaluation)

**Severity:** Low
**Table(s):** events, enrichments, watched_keys, bucket_configs, conversations, user_profiles
**Category:** Performance
**Description:** All RLS policies use bare `auth.uid()` calls (e.g., `USING (auth.uid() = user_id)`) instead of the recommended `(SELECT auth.uid())` pattern. The bare call is evaluated per-row by the Postgres query planner. Wrapping in `(SELECT ...)` converts it to an initPlan, which is evaluated once per statement and cached.

At current data scale (likely 10K-100K rows), the performance impact is negligible. However, as tables grow, this becomes a linear performance tax on every RLS-filtered query. This is a well-documented Supabase/Postgres best practice.

All 15 policies across all 6 tables are affected. For example, `20260306000005_add_rls_policies.sql` line 45:
```sql
USING (auth.uid() = user_id)
```
Should be:
```sql
USING ((SELECT auth.uid()) = user_id)
```

Similarly, the `bucket_configs` policies use `auth.jwt()->>'phone'` (e.g., line 12) which should also be wrapped:
```sql
USING ((SELECT auth.uid()) = user_id OR (user_id IS NULL AND phone_number = (SELECT auth.jwt()->>'phone')))
```

**Current behavior:** `auth.uid()` evaluated per-row in all policies.
**Expected behavior:** `(SELECT auth.uid())` used in all policies for initPlan caching.
**Remediation:** section-08-phone-migration (Phase 2 RLS rewrite)

---

### Finding 7: Duplicate SELECT + ALL policies on three tables

**Severity:** Low
**Table(s):** watched_keys, enrichments, conversations
**Category:** Authorization
**Description:** Three tables have both a dedicated `FOR SELECT` policy and a `FOR ALL` policy with the same USING expression. In `20260306000005_add_rls_policies.sql`:

- `watched_keys`: "Users can view own watched keys" (FOR SELECT, lines 56-58) + "Users can manage own watched keys" (FOR ALL, lines 61-64)
- `enrichments`: "Users can view own enrichments" (FOR SELECT, lines 70-72) + "Users can manage own enrichments" (FOR ALL, lines 75-78)
- `conversations`: "Users can view own conversations" (FOR SELECT, lines 84-86) + "Users can manage own conversations" (FOR ALL, lines 89-92)

A `FOR ALL` policy covers SELECT, INSERT, UPDATE, and DELETE. The dedicated `FOR SELECT` policy is therefore redundant. In Postgres, when multiple policies exist for the same operation, they are combined with OR logic. Since both policies have the same USING expression (`auth.uid() = user_id`), the OR produces the same result. This is not a security vulnerability, but it creates maintenance confusion -- if someone updates one policy but not the other, the behavior would change unexpectedly.

**Current behavior:** Redundant SELECT policies exist alongside ALL policies. Functionally equivalent but confusing.
**Expected behavior:** Either remove the dedicated SELECT policies (since ALL covers SELECT), or replace the ALL policies with specific INSERT, UPDATE, DELETE policies for explicitness.
**Remediation:** section-08-phone-migration (Phase 2 RLS cleanup)

---

### Finding 8: `bucket_configs.user_id` index coverage -- confirmed present

**Severity:** Info
**Table(s):** bucket_configs
**Category:** Performance
**Description:** The `bucket_configs.user_id` column is used in RLS policy expressions (`auth.uid() = user_id`). An index on this column is necessary for RLS-filtered queries to use an index scan rather than a sequential scan.

Verified in `20260306000002_add_user_id_to_bucket_configs.sql` (line 8):
```sql
CREATE INDEX idx_bucket_configs_user_id ON bucket_configs(user_id);
```

The index exists. All other RLS-referenced columns also have indexes:
- `events.user_id` -- `idx_events_user_id` (migration `20260306000003`, line 29)
- `watched_keys.user_id` -- `idx_watched_keys_user_id` (migration `20260306000003`, line 33)
- `enrichments.user_id` -- `idx_enrichments_user_id` (migration `20260306000003`, line 37)
- `conversations.user_id` -- `idx_conversations_user_id` (migration `20260306000003`, line 41)
- `bucket_configs.phone_number` -- `idx_bucket_configs_phone` (migration `20260306000001`, line 20)
- `user_profiles.id` -- primary key (implicit index)

**Current behavior:** All columns referenced in RLS policies have btree indexes.
**Expected behavior:** No action required.
**Remediation:** None needed.

---

## Additional Finding

### Finding 9: `events` table missing UPDATE and DELETE policies

**Severity:** Medium
**Table(s):** events
**Category:** Authorization
**Description:** The `events` table in `20260306000005_add_rls_policies.sql` only defines SELECT (line 43-45) and INSERT (line 48-50) policies. There are no UPDATE or DELETE policies. With RLS enabled and no policy for a given operation, that operation is denied by default. This is intentional for an append-only event log (events should not be updated or deleted), but there is no explicit documentation of this design decision in the migration.

By contrast, `bucket_configs` has explicit SELECT, INSERT, UPDATE, and DELETE policies. And `watched_keys`, `enrichments`, and `conversations` use `FOR ALL` which covers all operations.

This is not a vulnerability -- the deny-by-default behavior is correct for an immutable event log. However, it is worth noting as an intentional design choice.

**Current behavior:** UPDATE and DELETE on `events` are denied by default (no policy = deny).
**Expected behavior:** This is correct for an append-only event log. Consider adding a comment in the migration to make this intentional.
**Remediation:** No code change needed. Informational only.

---

### Finding 10: `user_profiles` missing DELETE policy

**Severity:** Low
**Table(s):** user_profiles
**Category:** Authorization
**Description:** The `user_profiles` table in `20260306000003_migrate_to_user_id.sql` defines SELECT (line 15-17), UPDATE (line 19-21), and INSERT (line 23-25) policies, but no DELETE policy. With RLS enabled, DELETE is denied by default. This means users cannot delete their own profile via RLS-filtered queries.

Since `user_profiles.id` has `REFERENCES auth.users(id) ON DELETE CASCADE` (line 6), profile deletion is handled at the auth level when a user account is deleted. A user-facing DELETE policy may or may not be desired depending on requirements.

**Current behavior:** Users cannot delete their profile row directly. Profile deletion only happens via CASCADE when the auth user is deleted.
**Expected behavior:** Likely intentional. If self-service profile deletion is needed, add a `FOR DELETE` policy.
**Remediation:** No immediate action needed. Evaluate during section-08 if user-facing profile deletion is required.

---

## Remediation Map

| Finding | Severity | Remediation Section |
|---------|----------|-------------------|
| 1: Service role key bypasses RLS | Critical | section-03 |
| 2: `get_user_id_from_phone()` info disclosure | High | section-04 |
| 3: RPC functions lack user_id filtering | High | section-04 |
| 4: `bucket_configs` dual auth OR-condition | Medium | section-08 |
| 5: No `TO authenticated` clause | Medium | section-08 |
| 6: Missing `(SELECT auth.uid())` wrapping | Low | section-08 |
| 7: Duplicate SELECT + ALL policies | Low | section-08 |
| 8: Index coverage (confirmed OK) | Info | None |
| 9: `events` missing UPDATE/DELETE policies | Medium | None (intentional) |
| 10: `user_profiles` missing DELETE policy | Low | section-08 (evaluate) |
