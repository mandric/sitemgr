Now I have enough context. Let me generate the section content.

# Section 02: RLS Security Audit

## Overview

This section produces a security audit of all Row Level Security (RLS) policies across 6 tables in the Supabase Postgres database. The audit identifies authorization gaps, bypass vectors, NULL-condition risks, SECURITY DEFINER vulnerabilities, and client key misuse. The deliverable is a findings document with severity ratings and recommended actions that downstream sections (03, 04, 06, 08) will implement.

This section does **not** create migration files or change application code. It identifies what needs to change and where.

## Dependencies

- None. This section can be executed first.

## What This Section Blocks

- **section-03-client-refactor** -- needs audit findings to know which call sites need admin vs user client
- **section-04-rpc-user-isolation** -- needs audit findings on RPC functions
- **section-06-rls-tests** -- needs audit findings to know what to test
- **section-08-phone-migration** -- needs audit findings to know which policies to rewrite

---

## Tests First

The audit itself is a document deliverable, but it must produce structured findings that later sections can verify. Create a test file that validates the audit document exists and covers all required tables and categories.

**File:** `/home/user/sitemgr/web/__tests__/rls-audit.test.ts`

```
# Test: anon user cannot SELECT from events table
# Test: anon user cannot SELECT from bucket_configs table
# Test: anon user cannot SELECT from enrichments table
# Test: anon user cannot SELECT from watched_keys table
# Test: anon user cannot SELECT from conversations table
# Test: anon user cannot SELECT from user_profiles table
# Test: user A cannot SELECT user B's events
# Test: user A cannot SELECT user B's bucket_configs
# Test: user A cannot INSERT event with user B's user_id
# Test: NULL user_id + NULL phone_number does not grant universal access
# Test: phone_number auth path grants access to matching records only
```

These tests are stubs for now. The actual integration test infrastructure and implementation is handled in **section-06-rls-tests**. The purpose of listing them here is to define the acceptance criteria the audit must address: every finding in the audit must correspond to a test that either passes (no vulnerability) or fails (vulnerability confirmed, fix needed).

Additionally, the audit must evaluate client key usage and SECURITY DEFINER functions:

```
# Test: getAdminClient() uses service role key
# Test: getUserClient() uses publishable key with auth context
# Test: queryEvents called via getUserClient returns only user's events
# Test: queryEvents called via getAdminClient returns all events (for background jobs)
# Test: get_user_id_from_phone() is not callable by anon role
# Test: get_user_id_from_phone() restricted to authorized callers only
```

These tests will be implemented in sections 03 and 06 respectively. The audit in this section defines what they must verify.

---

## Audit Scope

### Tables to Audit

All 6 tables with RLS enabled:

| Table | RLS Policies Defined In | Auth Model |
|-------|------------------------|------------|
| `events` | `20260306000005_add_rls_policies.sql` | `user_id` only |
| `enrichments` | `20260306000005_add_rls_policies.sql` | `user_id` only |
| `watched_keys` | `20260306000005_add_rls_policies.sql` | `user_id` only |
| `bucket_configs` | `20260306000005_add_rls_policies.sql` | Dual: `user_id` OR `phone_number` |
| `conversations` | `20260306000005_add_rls_policies.sql` | `user_id` only |
| `user_profiles` | `20260306000003_migrate_to_user_id.sql` | `id = auth.uid()` |

### Audit Criteria

For each table, evaluate:

1. **Authorization completeness** -- Does each policy correctly restrict all operations (SELECT, INSERT, UPDATE, DELETE) per user?
2. **Auth bypass vectors** -- Can an unauthenticated request or anon-role user access data?
3. **Cross-tenant leakage** -- Can user A see user B's data through any query path?
4. **OR-condition risks** -- The dual auth pattern on `bucket_configs` (`auth.uid() = user_id OR phone_number = auth.jwt()->>'phone'`) creates wider access than either alone. Verify NULL values in either column do not create unintended access.
5. **TO clause absence** -- None of the current policies use `TO authenticated`, meaning the policy expressions evaluate even for anon-role requests.
6. **SELECT wrapping** -- All current policies use bare `auth.uid()` calls instead of `(SELECT auth.uid())`, missing the initPlan caching optimization.

---

## Audit Procedure

### Step 1: Review Each Table's RLS Policies

Read the migration files that define RLS policies. The primary file is `/home/user/sitemgr/supabase/migrations/20260306000005_add_rls_policies.sql`. The `user_profiles` table policies are in `/home/user/sitemgr/supabase/migrations/20260306000003_migrate_to_user_id.sql`.

For each table, document:
- Which operations have policies (SELECT, INSERT, UPDATE, DELETE, ALL)
- The USING and WITH CHECK expressions
- Whether the policy restricts to `TO authenticated`
- Whether `auth.uid()` calls are wrapped in `(SELECT ...)`

### Step 2: Identify the `getSupabaseClient()` Bypass

The function at `/home/user/sitemgr/web/lib/media/db.ts` (line 7-19) prefers `SUPABASE_SECRET_KEY` (service role) over the publishable key. The service role key bypasses RLS completely. Every query function in `db.ts` uses this client:

- `queryEvents()` -- bypasses RLS
- `showEvent()` -- bypasses RLS
- `getStats()` -- bypasses RLS (calls `stats_by_content_type` and `stats_by_event_type` RPCs)
- `insertEvent()` -- bypasses RLS
- `insertEnrichment()` -- bypasses RLS
- `upsertWatchedKey()` -- bypasses RLS
- `getWatchedKeys()` -- bypasses RLS
- `findEventByHash()` -- bypasses RLS
- `getPendingEnrichments()` -- bypasses RLS
- `getEnrichStatus()` -- bypasses RLS

This means RLS is effectively not enforced for any server-side operation. The audit must classify each call site as either:
- **Legitimate admin use** (background jobs, enrichment pipeline) -- should use admin client
- **User-facing operation** (query, insert on behalf of user) -- should use user client with RLS enforcement

### Step 3: Evaluate `get_user_id_from_phone()` Function

Defined in `/home/user/sitemgr/supabase/migrations/20260306000003_migrate_to_user_id.sql` (lines 44-58). This function:
- Is `SECURITY DEFINER` -- runs as database owner, bypasses RLS
- Takes any phone number as input and returns the associated user_id
- Has no authorization check -- any authenticated user can call it with any phone number
- This is an **information disclosure vulnerability**: a user can discover other users' UUIDs by probing phone numbers

### Step 4: Evaluate RPC Functions

All three RPC functions in `/home/user/sitemgr/supabase/migrations/20260305000001_rpc_functions.sql` lack user_id filtering:

- `search_events(query_text, ...)` -- returns results across ALL users
- `stats_by_content_type()` -- aggregates across ALL users
- `stats_by_event_type()` -- aggregates across ALL users

These functions use `LANGUAGE sql STABLE` with no explicit security context (default `SECURITY INVOKER`). When called via the service role key (as `getSupabaseClient()` currently does), RLS is bypassed and data from all users is returned. Even with the publishable key, these functions do not filter by user_id in their SQL, so they rely entirely on RLS to filter rows -- which works for `search_events` (joins through `events` which has RLS) but may not work for the stats functions which aggregate.

### Step 5: Check Index Coverage for RLS Columns

Verify btree indexes exist on every column referenced in RLS policy expressions:

- `events.user_id` -- index exists (`idx_events_user_id`, added in migration `20260306000003`)
- `bucket_configs.user_id` -- needs verification (added in migration `20260306000002_add_user_id_to_bucket_configs.sql`)
- `bucket_configs.phone_number` -- index exists (`idx_bucket_configs_phone`, added in migration `20260306000001`)
- `watched_keys.user_id` -- index exists (`idx_watched_keys_user_id`, added in migration `20260306000003`)
- `enrichments.user_id` -- index exists (`idx_enrichments_user_id`, added in migration `20260306000003`)
- `conversations.user_id` -- index exists (`idx_conversations_user_id`, added in migration `20260306000003`)

Read `/home/user/sitemgr/supabase/migrations/20260306000002_add_user_id_to_bucket_configs.sql` to confirm whether `bucket_configs.user_id` has an index.

### Step 6: Evaluate FTS + RLS Interaction

The `search_events()` function performs full-text search on `enrichments.fts`. Non-LEAKPROOF functions in RLS policies can prevent the query planner from using GIN indexes, turning FTS queries into full table scans. After user_id filtering is added (section-04), run `EXPLAIN ANALYZE` to verify the GIN index on `enrichments.fts` is still used.

---

## Deliverable: Security Findings Document

**File to create:** `/home/user/sitemgr/01-data-foundation/rls-audit-findings.md`

This document must contain structured findings in the following format for each issue discovered:

```markdown
### Finding [N]: [Title]

**Severity:** Critical | High | Medium | Low
**Table(s):** [affected tables]
**Category:** Authorization | Bypass | Leakage | Performance | Information Disclosure
**Description:** [what the vulnerability is]
**Current behavior:** [what happens now]
**Expected behavior:** [what should happen]
**Remediation:** [which section implements the fix]
```

### Expected Findings

Based on the code review above, the audit should produce findings covering at least:

1. **Critical: Service role key bypasses RLS for all server operations** -- `getSupabaseClient()` in `db.ts` prefers `SUPABASE_SECRET_KEY`. Every query and mutation in the application bypasses RLS. Remediation: section-03 (client refactor).

2. **High: `get_user_id_from_phone()` information disclosure** -- SECURITY DEFINER function callable by any authenticated user, leaks user_id for arbitrary phone numbers. Remediation: section-04 (restrict to service role or private schema).

3. **High: RPC functions lack user_id filtering** -- `search_events()`, `stats_by_content_type()`, `stats_by_event_type()` return cross-tenant data when called with service role key. Remediation: section-04 (add `p_user_id` parameter).

4. **Medium: `bucket_configs` dual auth OR-condition** -- The pattern `auth.uid() = user_id OR (user_id IS NULL AND phone_number = auth.jwt()->>'phone')` means if a record has NULL user_id, any user whose JWT phone claim matches gets access. If a record somehow has both NULL user_id AND NULL phone_number, the second branch evaluates to `NULL AND NULL` which is falsy, so no universal access -- but the dual path adds attack surface. Remediation: section-08 (phone migration eliminates the OR path).

5. **Medium: No `TO authenticated` clause on any policy** -- All policies evaluate their expressions even for anon-role requests. While `auth.uid()` returns NULL for anon (so the equality check fails), adding `TO authenticated` prevents execution entirely and is a defense-in-depth measure. Remediation: section-08 (Phase 2 RLS rewrite).

6. **Low: Missing `(SELECT auth.uid())` wrapping** -- All policies use bare `auth.uid()` which evaluates per-row instead of being cached per-statement. At current data scale (10K-100K events) this is not a performance issue, but should be applied as a best practice. Remediation: section-08 (Phase 2 RLS rewrite).

7. **Low: `watched_keys` duplicate SELECT+ALL policies** -- The `watched_keys` table has both a `FOR SELECT` policy and a `FOR ALL` policy. The `FOR ALL` policy already covers SELECT, making the dedicated SELECT policy redundant. Same issue on `enrichments` and `conversations`. Not a security bug but creates maintenance confusion.

8. **Info: `bucket_configs.user_id` index coverage** -- Verify index exists. If missing, recommend adding in section-08 migration.

---

## How to Execute This Audit

1. Read all migration files listed above and the `db.ts` file
2. For each table, fill in the findings template comparing actual policy definitions against the audit criteria
3. For `getSupabaseClient()`, trace every call site in `db.ts` and classify as admin-appropriate or user-facing
4. For `get_user_id_from_phone()`, confirm the SECURITY DEFINER declaration and lack of authorization checks
5. For RPC functions, confirm they have no WHERE clause filtering by user_id or `auth.uid()`
6. Write the findings document to `/home/user/sitemgr/01-data-foundation/rls-audit-findings.md`
7. Verify completeness: every finding must map to a remediation section (03, 04, 06, or 08)

## Files Involved

| File | Action |
|------|--------|
| `/home/user/sitemgr/supabase/migrations/20260306000005_add_rls_policies.sql` | Read (audit input) |
| `/home/user/sitemgr/supabase/migrations/20260306000003_migrate_to_user_id.sql` | Read (audit input) |
| `/home/user/sitemgr/supabase/migrations/20260305000001_rpc_functions.sql` | Read (audit input) |
| `/home/user/sitemgr/supabase/migrations/20260306000001_bucket_configs.sql` | Read (audit input) |
| `/home/user/sitemgr/supabase/migrations/20260306000002_add_user_id_to_bucket_configs.sql` | Read (audit input) |
| `/home/user/sitemgr/supabase/migrations/20260305000000_initial_schema.sql` | Read (audit input) |
| `/home/user/sitemgr/web/lib/media/db.ts` | Read (audit input -- client key usage) |
| `/home/user/sitemgr/01-data-foundation/rls-audit-findings.md` | Create (deliverable) |
| `/home/user/sitemgr/web/__tests__/rls-audit.test.ts` | Create (stub test file defining acceptance criteria) |

## What Was Built

**Implemented as planned.** Audit document and stub test file created.

### Files Created
- `01-data-foundation/rls-audit-findings.md` — Structured security findings document with 10 findings covering all expected categories: service role bypass (Critical), get_user_id_from_phone disclosure (High), RPC functions lacking user_id filtering (High), dual-auth OR-condition (Medium), missing TO authenticated (Medium), missing SELECT wrapping (Low), redundant policies (Low), bucket_configs.user_id index (Info), and additional findings discovered during audit.
- `web/__tests__/rls-audit.test.ts` — 39 todo test stubs defining acceptance criteria across anon blocking, cross-tenant isolation, NULL condition safety, phone auth path, client key usage, and RPC function security.

### Deviations from Plan
- Additional findings beyond the 8 expected were identified during audit
- Tests written as `it.todo()` stubs per plan (implementation in section-06)