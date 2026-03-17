# 01-data-foundation — Implementation Plan

## 1. Context & Motivation

sitemgr is a cloud-based media management platform backed by Supabase Postgres. The data foundation layer — schema, encryption, auth, RLS, and migrations — is fully implemented across 8 migration files, a versioned AES-GCM encryption system, and Supabase Auth integration. However, this layer has never been systematically audited.

Three areas need attention:

1. **Security**: RLS policies use a dual auth model (phone_number OR user_id) that adds complexity and may contain bypass vectors. The encryption key rotation system has never been exercised. No tests verify that RLS actually blocks unauthorized access. The server-side database client uses the service role key, effectively bypassing RLS for all server operations. The encryption module has a concurrency bug.

2. **Quality**: Test coverage has gaps in RLS policy verification, migration testing, and event store edge cases. The event ID format (truncated UUIDs) lacks time-ordering benefits.

3. **Technical debt**: The phone_number auth path is transitional and should be unified to user_id-only. RLS policies don't follow Supabase performance best practices (missing SELECT wrapping, no client-side filter hints). RPC functions lack user_id filtering.

Expected data scale is 10K-100K events over the next 6-12 months — moderate, so partitioning and heavy optimization aren't needed, but correct indexing and query patterns matter.

### Deliverables Summary

| Section | Deliverable |
|---------|-------------|
| 2. RLS Audit | Security findings report, migration file with optimized policies |
| 3. Encryption Fix & Validation | Refactored encryption module, comprehensive test suite |
| 4. Test Coverage | RLS integration tests, migration tests, event store tests |
| 5. Phone→user_id | 3 migration files (backfill, RLS simplification, schema cleanup) |
| 6. Event ID | Updated `newEventId()` function, `ulid` dependency |
| 7. Documentation | Key rotation runbook, RLS policy docs, updated spec |

---

## 2. RLS Security Audit & Optimization

### 2.1 Audit Current Policies

**Deliverable:** Security findings document identifying all vulnerabilities with severity ratings.

Every table's RLS policies must be reviewed against these criteria:

- **Authorization completeness**: Does each policy correctly restrict all operations (SELECT, INSERT, UPDATE, DELETE) per user?
- **Auth bypass vectors**: Can an unauthenticated request or anon-role user access data?
- **Cross-tenant leakage**: Can user A see user B's data through any query path?
- **OR-condition risks**: The dual auth pattern (`auth.uid() = user_id OR phone_number = auth.jwt()->>'phone'`) creates wider access than either alone. Verify that NULL values in either column don't create unintended access.

Tables to audit: `events`, `enrichments`, `watched_keys`, `bucket_configs`, `conversations`, `user_profiles`.

**Critical finding from review: `getSupabaseClient()` service role key usage.** The `getSupabaseClient()` function in `lib/media/db.ts` prefers `SUPABASE_SECRET_KEY` (service role) over the publishable key. The service role key bypasses RLS completely. Every query function in `db.ts` — `queryEvents`, `showEvent`, `getStats`, `insertEvent`, `getPendingEnrichments`, `getWatchedKeys` — uses this client, meaning RLS is effectively not enforced for server-side operations.

**Action:** Audit every call site and create two client constructors:
- `getAdminClient()` — Service role key, for background jobs (enrichment pipeline, sync workers) that legitimately need full access
- `getUserClient(userId)` — Publishable key with auth context, for user-facing operations that must respect RLS

**Critical finding from review: `get_user_id_from_phone()` is SECURITY DEFINER.** This function runs as database owner and bypasses RLS. Any authenticated user can call it with any phone number and learn the associated user_id. This is an information disclosure vulnerability.

**Action:** Either restrict the function to the service role only (move to a private schema) or convert to SECURITY INVOKER and add authorization checks.

### 2.2 Apply Performance Best Practices

**Deliverable:** Migration file applying RLS optimizations (deferred to Phase 2 of phone→user_id migration to avoid duplicate work).

Research identified several Supabase-specific RLS optimizations that the current policies don't follow:

**SELECT wrapping for initPlan caching**: Replace bare `auth.uid()` calls with `(SELECT auth.uid())` in all policies. This causes Postgres to cache the result per-statement instead of evaluating per-row — reported 100x+ improvement on large tables.

Before: `auth.uid() = user_id`
After: `(SELECT auth.uid()) = user_id`

**TO clause restriction**: Add `TO authenticated` on all policies that use `auth.uid()` or `auth.jwt()`. This prevents the policy from executing at all for anon-role requests.

**Note:** These optimizations will be applied in the same migration as Phase 2 of the phone→user_id migration (Section 5), since both rewrite the same policies. This avoids doing the work twice.

**Index verification**: Confirm btree indexes exist on every column referenced in RLS policies:
- `events.user_id` — verify index exists
- `bucket_configs.user_id`, `bucket_configs.phone_number` — verify indexes
- `watched_keys.user_id` — verify index exists
- `enrichments` — verify user_id access path (joins through events.user_id)

### 2.3 RPC Functions & User Isolation

**Deliverable:** Migration file adding user_id parameters to all RPC functions.

All three RPC functions currently lack user_id filtering:

- `search_events()` — Returns results across ALL users. Must add a `p_user_id UUID` parameter and filter by it.
- `stats_by_content_type()` — Aggregates across ALL users. Must add user_id parameter.
- `stats_by_event_type()` — Same issue.

These functions use `LANGUAGE sql STABLE` with no explicit security context, meaning they default to `SECURITY INVOKER`. When called via the service role key (which `getSupabaseClient()` currently uses), RLS is bypassed and data from all users is returned.

**Action:** Add `p_user_id UUID` parameter to all three functions and filter results by it. This ensures user isolation regardless of which client key calls the function.

### 2.4 FTS + RLS Interaction

The `search_events()` RPC function performs full-text search across enrichments. Research identified a critical gotcha: non-LEAKPROOF functions in RLS policies can prevent the query planner from using GIN indexes, turning FTS queries into full table scans.

**Action**: After adding user_id filtering to `search_events()`, run `EXPLAIN ANALYZE` to verify the GIN index on `enrichments.fts` is being used. If the dual auth OR condition prevents index usage, this will be resolved when RLS policies are simplified in Phase 2 of the phone→user_id migration.

---

## 3. Encryption System Fix & Validation

### 3.0 Fix Process.env Race Condition (Critical)

**Deliverable:** Refactored `encryption.ts` that accepts key as parameter.

The versioned encryption module (`encryption-versioned.ts`) mutates `process.env.ENCRYPTION_KEY` as a side-channel to pass the key to the base `encryption.ts` module. In a concurrent environment (Vercel serverless functions, Next.js API routes), two concurrent encrypt/decrypt operations will stomp on each other's `process.env.ENCRYPTION_KEY` value. The try/finally block does not protect against interleaving in async code — between the `process.env.ENCRYPTION_KEY = key` assignment and the `await encryptSecret()` call, another async operation can overwrite it.

This is a data corruption bug: one request could encrypt with the wrong key, producing ciphertext labeled "current" but actually encrypted with another request's key.

**Action:** Refactor `encryption.ts` to accept the encryption key as a function parameter:

```typescript
// Before (reads from process.env internally):
export async function encryptSecret(plaintext: string): Promise<string>

// After (key passed explicitly):
export async function encryptSecret(plaintext: string, key: string): Promise<string>
```

Update `encryption-versioned.ts` to pass the resolved key directly instead of mutating `process.env`. Update all callers.

### 3.1 Key Rotation End-to-End Test

**Deliverable:** Test file `encryption-rotation.test.ts` covering full rotation lifecycle.

Create a comprehensive test that exercises the full lifecycle:

1. Encrypt data with key A (labeled "current")
2. Rotate: A becomes "previous", B becomes "current"
3. Decrypt old data — should use "previous" key (A)
4. Read triggers lazy migration — data should re-encrypt with "current" key (B)
5. Verify re-encrypted data decrypts correctly with B
6. Remove "previous" key (A)
7. Verify all data still accessible via "current" key (B)

This test should use `vi.stubEnv()` with fixture keys and simulate the rotation by swapping env vars between test phases.

### 3.2 Legacy Format Migration Test

Test that data encrypted without a label prefix (legacy format) is correctly handled:
1. Create ciphertext without label prefix (simulate pre-versioning data)
2. Decrypt — should try keys in priority order (current → previous → next)
3. Verify `needsMigration()` returns true
4. Re-encrypt and verify new format has `current:` prefix

### 3.3 Edge Cases

- **Missing ENCRYPTION_KEY_CURRENT**: Should fail with clear error, not silently fall back
- **Corrupted ciphertext**: Should throw actionable error with diagnostic info
- **Empty plaintext**: Should encrypt/decrypt correctly
- **Very long plaintext**: Should handle without truncation
- **Concurrent operations**: After the process.env fix, verify multiple concurrent encrypt/decrypt calls don't interfere

### 3.4 Reconcile encryption_key_version Column

The `bucket_configs` table has an `encryption_key_version` integer column (added in migration `20260312000000`), while the encryption system uses label prefixes in ciphertext ("current:", "previous:"). Document the relationship: the column serves as a database-level audit trail for querying which records need migration, while the label prefix is the runtime mechanism for key selection. Both mechanisms are kept.

### 3.5 IV/Nonce Safety Assessment

Current implementation uses random 12-byte IVs (correct for AES-GCM). At the expected volume (encrypting S3 secret keys, not bulk data), IV collision risk is negligible. Document this assessment but take no action — the current approach is appropriate.

---

## 4. Test Coverage Expansion

### 4.1 RLS Policy Test Suite

**Deliverable:** Integration test file `rls-policies.test.ts` running against local Supabase.

Create a dedicated test file that verifies RLS enforcement against a real Supabase instance (local via `supabase start`). These are integration tests, not unit tests.

**Approach**: Use the Supabase client with different auth contexts to verify access control:

For each table, test these scenarios:
- **Authenticated user sees own data**: Insert as user A, query as user A → data visible
- **Authenticated user blocked from other's data**: Insert as user A, query as user B → no results
- **Anon user blocked**: Query without auth → no results (or error)
- **Insert restricted to own user_id**: Attempt to insert with a different user_id → rejected
- **Phone-based access** (during dual-auth period): User with phone claim sees phone-matched data

**Auth context creation**: Use Supabase Admin API to create test users with known IDs, then authenticate as those users via the client.

### 4.2 Migration Test Framework

**Deliverable:** Test script verifying forward migration applies cleanly.

Test that migrations apply cleanly (forward-only for v1; down migrations are a future enhancement):

- **Forward test**: Apply all migrations to fresh database, verify schema matches expectations
- **Idempotency**: Applying migrations twice doesn't error
- **Data preservation**: Insert test data before migration N, verify it survives migration N+1

Use `supabase db reset` for clean-slate testing and `supabase migration up` for incremental testing.

### 4.3 Event Store & Schema Edge Case Tests

**Deliverable:** Test file `data-integrity.test.ts` covering event store and schema edge cases.

Test the events table's append-only semantics and related behaviors:

- **Duplicate content_hash handling**: Insert two events with same content_hash — should succeed (events are immutable, dedup is application-level via `findEventByHash()`)
- **Parent-child chains**: Insert event with parent_id → verify parent exists, query chain
- **Invalid event type**: Insert event with unknown type — should the schema reject it or is validation application-level?
- **Concurrent inserts**: Multiple simultaneous inserts don't conflict (no unique constraint on timestamps)
- **Event ordering**: Events should be retrievable in chronological order (verify index on timestamp)

**watched_keys collision bug:** The `watched_keys` table uses `s3_key TEXT` as its primary key. If two users have the same S3 key path in different buckets, only one record can exist. The primary key should be `(s3_key, bucket_config_id)` to allow per-bucket uniqueness. Add a test that demonstrates this collision, then create a migration to fix the primary key.

---

## 5. Phone→user_id Migration

### 5.1 Migration Strategy

**Deliverable:** Three separate migration files (one per phase).

The goal is to eliminate phone_number as an auth identifier, making user_id the sole tenant key. This is a multi-step process that must maintain backward compatibility during transition.

**Phase 1: Backfill user_id** (Migration file)

For records that have phone_number but NULL user_id:
1. Look up user_id from `user_profiles` where `phone_number` matches
2. Update `user_id` column on matched records
3. For unmatched phone numbers (no linked user), leave as-is and log for manual review

Tables to backfill: `bucket_configs`, `conversations`, `watched_keys`, `events`

**Phase 2: Simplify RLS policies** (Migration file)

Once all records have user_id populated:
1. Remove the OR phone_number clauses from all RLS policies
2. Simplify to `(SELECT auth.uid()) = user_id` only (with SELECT wrapping for performance)
3. Add `TO authenticated` restriction on all policies
4. This phase also applies the performance optimizations from Section 2.2

This creates a new migration file.

**Phase 3: Schema cleanup** (Migration file)

After confirming no phone-only records remain:
1. Make `user_id` NOT NULL on tables where it was nullable
2. Drop unique constraint on (phone_number, bucket_name) — keep only (user_id, bucket_name)
3. Keep phone_number in `user_profiles` (needed for WhatsApp display) and `conversations` (but see 5.4)
4. Drop phone_number from `bucket_configs`, `watched_keys`, `events` where it's no longer the auth path

This is a separate migration file.

### 5.2 Rollback Safety

Each phase should be a separate migration that can be rolled back independently:
- Phase 1 backfill: Reversible (just null out user_id on backfilled records)
- Phase 2 RLS: Reversible (restore old policy definitions)
- Phase 3 schema: **Not easily reversible** (NOT NULL + dropped columns) — require explicit confirmation before applying

### 5.3 Application Code Changes

**Deliverable:** Updated `db.ts`, `core.ts`, and all query call sites.

After Phase 2, update application code that constructs queries:
- Remove phone_number-based query paths in `lib/media/db.ts`
- Update agent code (`lib/agent/core.ts`) to resolve phone→user_id before any database operation
- Ensure all Supabase client queries include `.eq('user_id', userId)` alongside RLS

**Insert functions that need user_id added** (will break after Phase 3 NOT NULL):
- `insertEvent()` in `lib/media/db.ts` — does not currently set `user_id`
- `insertEnrichment()` in `lib/media/db.ts` — does not set `user_id`
- `upsertWatchedKey()` in `lib/media/db.ts` — does not set `user_id`
- Any insert paths in `lib/agent/core.ts` that go through `executeAction()`

All callers must be updated to pass `user_id` before Phase 3 is applied.

### 5.4 Conversations Primary Key Migration

The `conversations` table uses `phone_number TEXT` as its primary key. This cannot simply be dropped. Two options:

**Option A (Recommended):** Migrate the primary key to `user_id`:
1. Add `user_id` as a column (already exists from migration 20260306000003)
2. Backfill user_id from user_profiles
3. Create new primary key on `user_id`, drop old primary key on `phone_number`
4. Keep `phone_number` as a regular column for WhatsApp display

**Option B:** Leave primary key as `phone_number`, add unique constraint on `user_id`:
- Simpler but maintains phone_number as the identity anchor
- Contradicts the goal of user_id-only auth

This should be handled in the Phase 3 migration file.

---

## 6. Event ID Format Evaluation

### 6.1 Current State

Events use TEXT PRIMARY KEY with 26-character IDs generated by `newEventId()` in `web/lib/media/utils.ts`. This truncates a UUID (removes hyphens, takes first 26 chars).

### 6.2 ULID Benefits

**Deliverable:** Updated `newEventId()` function, `ulid` npm dependency.

ULIDs provide:
- **B-tree friendly**: Sequential inserts maintain index locality (primary benefit for database performance)
- **Time-encoded**: First 10 chars encode millisecond timestamp
- **Compact**: 26 chars in Crockford Base32 (same length as current IDs)
- **Unique**: 80 bits of randomness per millisecond

**Important clarification:** After migration, the events table will have mixed ID formats. Old events have random-ish truncated UUIDs; new events have time-sorted ULIDs. Sorting by `id` will NOT give chronological ordering across all events. Continue using the `timestamp` column for chronological queries. The ULID benefit is primarily B-tree insert locality for new events.

### 6.3 Migration Path

Since events are immutable and the current IDs are TEXT, migration is straightforward:
1. Add `ulid` npm package as dependency
2. Update `newEventId()` to generate ULIDs instead of truncated UUIDs
3. Existing events keep their old IDs (no backfill needed — they're already unique)
4. New events get ULID IDs

**No migration file needed** — this is an application-code-only change.

### 6.4 Impact Assessment

Downstream consumers (02-media-pipeline through 05-cli) use event IDs as opaque strings. Changing the generation algorithm doesn't affect them as long as:
- IDs remain TEXT type
- IDs remain unique
- No consumer assumes a specific ID format

Verify this by searching for ID format assumptions in the codebase.

---

## 7. Documentation & Runbook

### 7.1 Key Rotation Runbook

**Deliverable:** `docs/KEY_ROTATION.md` with tested procedure.

Document the tested key rotation procedure based on the validation results from Section 3:
- Step-by-step commands for Vercel env var management
- Monitoring checklist for lazy migration progress
- Rollback procedure if issues arise
- Verification queries to confirm all data migrated

### 7.2 RLS Policy Documentation

**Deliverable:** Updated `docs/RLS_POLICIES.md`.

For each table, document:
- What each policy enforces
- Which auth context (user_id vs phone) is supported and under what conditions
- Performance characteristics (index usage, query plan expectations)
- Which client key (anon vs service role) each code path uses

### 7.3 Schema Reference

**Deliverable:** Updated `01-data-foundation/spec.md`.

Update with any changes from this audit, maintaining it as the living schema reference.

---

## 8. Implementation Order

The sections above should be implemented in this order due to dependencies:

1. **Encryption Fix** (Section 3.0) — Critical concurrency bug, must fix first
2. **RLS Security Audit** (Section 2.1) — Must understand current state before changing anything
3. **Client Key Audit** (Section 2.1, getSupabaseClient) — Foundational to all RLS work
4. **RLS Policy Test Suite** (Section 4.1) — Tests verify current behavior before modifications
5. **RPC User Isolation** (Section 2.3) — Add user_id params to RPC functions
6. **Encryption Validation** (Section 3.1-3.5) — Tests for rotation, legacy, edge cases
7. **Migration & Event Store Tests** (Sections 4.2, 4.3) — Can parallelize with encryption
8. **Phone→user_id Migration** (Section 5) — Depends on RLS audit and test suite
9. **Event ID Format** (Section 6) — Independent, low risk, can be done anytime
10. **Documentation** (Section 7) — After all changes are implemented and validated
