# Section 05: Tenant Isolation Test Suite

## Overview

Create `web/__tests__/integration/tenant-isolation.test.ts` — merges `rls-policies.test.ts`, `rpc-user-isolation.test.ts`, and the relevant test cases from `rls-audit.test.ts` into a single behavior-oriented suite. Tests the core business guarantee: multi-tenant data isolation.

## Context

The project uses Supabase RLS (Row Level Security) to isolate tenant data. After migration `20260315000001_simplify_rls.sql`, all RLS policies use `user_id`-only authentication (phone_number auth path removed). Policies use `(SELECT auth.uid())` for initPlan caching and `TO authenticated` to block anon access.

**Current test files being replaced:**
- `web/__tests__/rls-policies.test.ts` (302 lines) — cross-tenant isolation, anon blocking, NULL user_id, SECURITY DEFINER restrictions
- `web/__tests__/rpc-user-isolation.test.ts` (192 lines) — RPC function p_user_id enforcement, FTS verification
- `web/__tests__/rls-audit.test.ts` (102 lines) — all `it.todo()` stubs including append-only enforcement, anon blocking per table, cross-tenant UPDATE/DELETE

**Prerequisites from earlier sections:**
- Section 02: `globalSetup.ts` validates Supabase connectivity
- Section 03: `seedUserData()`, `assertInsert()`, `cleanupUserData()`, `createTestUser()` from setup.ts

## What to Build

### File: `web/__tests__/integration/tenant-isolation.test.ts`

### Setup

**`beforeAll`:**
1. Get admin client via `getAdminClient()`
2. Create Alice via `createTestUser('alice@test.local')` → `{ userId: aliceId, client: aliceClient }`
3. Create Bob via `createTestUser('bob@test.local')` → `{ userId: bobId, client: bobClient }`
4. Seed Alice's data: `seedUserData(admin, aliceId, { eventCount: 2 })` → `aliceSeed`
5. Seed Bob's data: `seedUserData(admin, bobId, { eventCount: 1 })` → `bobSeed`
6. If any step fails, `assertInsert()` throws immediately — entire suite aborts with clear error
7. Create anonymous client: `createClient(url, anonKey)` (no sign-in)

Store all IDs in module-scope variables (NOT `globalThis` — that anti-pattern from `rpc-user-isolation.test.ts` is eliminated). Use `SeedResult` return values directly.

**`afterAll`:**
1. `cleanupUserData(admin, aliceId)`
2. `cleanupUserData(admin, bobId)`
3. `admin.auth.admin.deleteUser(aliceId)`
4. `admin.auth.admin.deleteUser(bobId)`

### Test Group 1: Read isolation

```
describe('when querying own data', () => {
  it('should only return Alice\'s events when Alice queries events')
    // aliceClient.from('events').select('*')
    // Assert: length === 2, all user_id === aliceId, none === bobId
  it('should only return Alice\'s enrichments when Alice queries enrichments')
  it('should only return Alice\'s watched_keys when Alice queries watched_keys')
  it('should only return Alice\'s bucket_configs when Alice queries bucket_configs')
  it('should only return Alice\'s conversations when Alice queries conversations')
  it('should only return Alice\'s user_profiles when Alice queries user_profiles')
})
```

### Test Group 2: Write isolation

```
describe('when attempting cross-tenant writes', () => {
  it('should reject INSERT of event with another user\'s user_id')
    // aliceClient.from('events').insert({ ...validEvent, user_id: bobId })
    // Assert error (RLS policy blocks)
  it('should reject INSERT of bucket_config with another user\'s user_id')
  it('should reject INSERT of enrichment with another user\'s user_id')
  it('should not affect Bob\'s events when Alice attempts UPDATE')
    // aliceClient.from('events').update({ type: 'hacked' }).eq('user_id', bobId)
    // Assert: 0 rows affected (verify Bob's data unchanged via admin)
  it('should not affect Bob\'s bucket_configs when Alice attempts DELETE')
    // aliceClient.from('bucket_configs').delete().eq('user_id', bobId)
    // Assert: 0 rows affected
})
```

### Test Group 3: Anonymous access

```
describe('when accessing as anonymous user', () => {
  it('should return empty results when anon queries events')
    // anonClient.from('events').select('*')
    // Assert: data is empty array or error
  it('should return empty results when anon queries enrichments')
  it('should return empty results when anon queries watched_keys')
  it('should return empty results when anon queries bucket_configs')
  it('should return empty results when anon queries conversations')
  it('should return empty results when anon queries user_profiles')

  it('should reject when anon tries to INSERT into events')
    // anonClient.from('events').insert({ ... })
    // Assert error
  it('should reject when anon tries to INSERT into enrichments')
  it('should reject when anon tries to INSERT into watched_keys')
  it('should reject when anon tries to INSERT into bucket_configs')
  it('should reject when anon tries to INSERT into conversations')
  it('should reject when anon tries to INSERT into user_profiles')
})
```

### Test Group 4: RPC scoping

```
describe('when calling RPC functions', () => {
  it('should return only Alice\'s events when Alice calls search_events')
    // aliceClient.rpc('search_events', { p_user_id: aliceId, p_query: '...' })
    // Assert: all results belong to Alice
  it('should return empty when Alice calls search_events with Bob\'s user_id')
    // aliceClient.rpc('search_events', { p_user_id: bobId, p_query: '...' })
    // Assert: empty results (RLS blocks underlying data)
  it('should return only Alice\'s stats when Alice calls stats_by_content_type')
    // aliceClient.rpc('stats_by_content_type', { p_user_id: aliceId })
    // Assert: counts match Alice's seeded data
  it('should return only Alice\'s stats when Alice calls stats_by_event_type')
})
```

Note: For search_events to return results, Alice's enrichments need FTS content. `seedUserData()` should create enrichments with a known description (e.g., "test enrichment for user {userId.slice(0,8)}"). The search query should match this description.

### Test Group 5: Service-role restrictions

```
describe('when calling admin-only functions', () => {
  it('should deny Alice access to get_user_id_from_phone')
    // aliceClient.rpc('get_user_id_from_phone', { p_phone: '+1234567890' })
    // Assert error contains "permission denied"
  it('should deny anonymous access to get_user_id_from_phone')
    // anonClient.rpc('get_user_id_from_phone', { p_phone: '+1234567890' })
    // Assert error contains "permission denied"
  it('should allow service_role access to get_user_id_from_phone')
    // admin.rpc('get_user_id_from_phone', { p_phone: '+1234567890' })
    // Assert: no "permission denied" error (result may be null if phone not found, that's fine)
})
```

### Test Group 6: Append-only enforcement

```
describe('when attempting to modify own events', () => {
  it('should reject UPDATE of own events')
    // aliceClient.from('events').update({ type: 'modified' }).eq('id', aliceSeed.eventIds[0])
    // Assert: error or 0 rows affected (no UPDATE policy exists)
  it('should reject DELETE of own events')
    // aliceClient.from('events').delete().eq('id', aliceSeed.eventIds[0])
    // Assert: error or 0 rows affected (no DELETE policy exists)
    // Verify via admin that the event still exists
})
```

### BDD Naming

All test names use `it('should [behavior] when [condition]')`. Groups use `describe('when [context]')`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `web/__tests__/integration/tenant-isolation.test.ts` | CREATE |

## Acceptance Criteria

1. All 6 test groups pass against a fresh `supabase start` with seeded data
2. Read isolation verified for all 6 tables
3. Write isolation covers INSERT, UPDATE, and DELETE operations
4. Anonymous access blocked on all 6 tables (both SELECT and INSERT)
5. RPC functions scoped correctly (cross-user search returns empty)
6. Append-only enforcement prevents UPDATE and DELETE on events
7. No `describe.skipIf` — relies on globalSetup
8. No `globalThis` hack — user IDs from SeedResult
9. `beforeAll` uses `assertInsert()` for clear failure messages
10. `afterAll` cleans up all test data
