# Implementation Plan — Fix CI Pipeline

## Context

The CI pipeline has two failing jobs: **integration tests** (dangling handle warning causes non-clean exit) and **E2E tests** (beforeAll timeout). The original spec identified 5 fixes, but after research and interview, the scope narrowed:

- **F1 (search_events assertion) and F2 (event type assertion):** Already fixed in merged PR #36.
- **F3 (E2E beforeAll timeout):** Still needs fixing.
- **F4 (dangling handle):** Still needs fixing across all 4 integration test files.
- **F5 (.env.local heredoc):** Already fixed (uses `printf`).

Additionally, research uncovered that the `stats_by_content_type` and `stats_by_event_type` tests in `tenant-isolation.test.ts` still use `if (data && data.length > 0)` guards that silently pass when results are empty. These should be hardened with the same pattern.

### Decision: No New Migration

Research confirmed that Supabase auto-grants EXECUTE to authenticated/anon roles by default. The `search_events`, `stats_by_content_type`, and `stats_by_event_type` RPC functions work correctly without explicit GRANTs. No migration needed.

---

## Section 1: E2E beforeAll Timeout Fix

### Problem

`web/e2e/agent.spec.ts` — `test.beforeAll()` at line 69 performs user signup via form + email confirmation via Mailpit with exponential backoff. The `getConfirmationLink()` function retries up to 10 times with backoff capped at 5s per attempt, which can take up to ~50 seconds total. Playwright's default `beforeAll` timeout is 30 seconds.

### Solution

Add an explicit timeout via the options-object second argument to `test.beforeAll()`. This is more explicit and portable than `test.setTimeout()` inside the callback.

### Change

**File:** `web/e2e/agent.spec.ts`

Change the `test.beforeAll` call to include a timeout options object as the second argument:

```typescript
test.beforeAll(async ({ browser }) => {
  // ... existing body unchanged ...
}, { timeout: 60000 });
```

### Why 60 seconds

- `getConfirmationLink` retries 10 times with exponential backoff capped at 5s → worst case ~50s
- 60s provides 10s headroom without being wastefully long
- Per-test only (not global config) — other beforeAll hooks don't need extended timeouts
- Uses `60000` (no numeric separator) to match existing code style (`30000`, `10000`, `20000`)

---

## Section 2: Dangling Handle Cleanup

### Problem

After integration tests complete, Vitest reports: `"Tests closed successfully but something prevents the main process from exiting"`. The Supabase JS client maintains internal connections:

1. **GoTrue auth layer** — even with `autoRefreshToken: false`, the client's internal HTTP connection pool and session state can hold Node.js handles open
2. **Realtime WebSocket** — although no channels are subscribed, the client's realtime module initializes a connection manager

No test file currently calls any client cleanup method in `afterAll`.

### Solution

Two-pronged cleanup for each Supabase client:

1. **`removeAllChannels()`** — cleans up realtime WebSocket connections
2. **`auth.signOut()`** — tears down GoTrue session and releases any internal timers (for authenticated clients only; not needed for admin or anon clients)

### Files to Modify

Each file needs different cleanup based on which clients it creates:

#### 2a. `tenant-isolation.test.ts`

**Current clients:** `admin`, `aliceClient`, `anonClient` at module level. Bob's client is created via `createTestUser` but never stored — it's returned as `bob.client` and discarded.

**Changes:**
1. Add module-level variable `let bobClient: SupabaseClient;`
2. In `beforeAll`, store Bob's client: `bobClient = bob.client;`
3. In `afterAll` (line 43-46), after the existing `cleanupUserData` calls, add cleanup for all clients:

```typescript
// Sign out authenticated clients to release GoTrue timers
await aliceClient.auth.signOut();
await bobClient.auth.signOut();

// Clean up all client connections
await Promise.all([
  admin.removeAllChannels(),
  aliceClient.removeAllChannels(),
  bobClient.removeAllChannels(),
  anonClient.removeAllChannels(),
]);
```

#### 2b. `media-lifecycle.test.ts`

**Current clients:** `admin`, `userClient` at module level. `userB` is created via `createTestUser` but `userB.client` is never stored.

**Changes:**
1. Add module-level variable `let userBClient: SupabaseClient;`
2. In `beforeAll`, after `const userB = await createTestUser()`, store: `userBClient = userB.client;`
3. In `afterAll` (line 74), after the existing cleanup, add:

```typescript
await userClient.auth.signOut();
await userBClient.auth.signOut();
await Promise.all([
  admin.removeAllChannels(),
  userClient.removeAllChannels(),
  userBClient.removeAllChannels(),
]);
```

#### 2c. `media-storage.test.ts`

**Current state:** Admin is created locally inside both `beforeAll` (line 28) and `afterAll` (line 33) — two separate instances. The `beforeAll` instance is never cleaned up.

**Changes:**
1. Hoist admin to module level: `let admin: ReturnType<typeof getAdminClient>;`
2. In `beforeAll`, assign to the module-level variable instead of local `const`
3. In `afterAll`, use the same module-level admin (remove the local `const admin = getAdminClient()`)
4. After bucket deletion, add: `await admin.removeAllChannels();`

#### 2d. `schema-contract.test.ts`

**Current clients:** `admin` at module level. No `afterAll` exists.

**Changes:**
1. Add `afterAll` to the vitest import on line 5
2. Add afterAll block:

```typescript
afterAll(async () => {
  await admin.removeAllChannels();
});
```

### Why both `removeAllChannels()` and `auth.signOut()`

The Supabase JS client doesn't expose a general `dispose()` or `close()` method. `removeAllChannels()` cleans up the Realtime module. `auth.signOut()` tears down the GoTrue session, releasing any internal timers or session refresh mechanisms. Together, these cover both connection types. Admin and anon clients don't have active auth sessions, so `signOut()` is skipped for them.

### Known limitation: ephemeral admin clients in `createTestUser`

Each call to `createTestUser()` internally calls `getAdminClient()`, creating a new Supabase client that is used briefly and then abandoned. These ephemeral clients are a minor leak vector but fixing them requires refactoring `createTestUser` to accept an admin parameter, which is out of scope for this fix.

---

## Section 3: Stats RPC Guard Hardening

### Problem

In `tenant-isolation.test.ts`, the `stats_by_content_type` and `stats_by_event_type` tests (lines 220-241) use the same `if (data && data.length > 0)` guard pattern that was already fixed for `search_events`. If these RPCs return empty results, the tests silently pass.

### Solution

Remove the `if` guards and add explicit non-empty assertions, matching the pattern already applied to `search_events`:

For `stats_by_content_type` (lines 220-227):
- Remove `if (data && data.length > 0) {` wrapper
- Add `expect(data!.length).toBeGreaterThan(0);` before the reduce
- Remove closing `}`

For `stats_by_event_type` (lines 234-241):
- Same pattern

---

## Verification

After all changes:

1. **Local verification:** Run `npm run test:integration` with local Supabase — all tests pass with clean exit (no dangling handle warning)
2. **E2E verification:** Run `npm run test:e2e` — beforeAll completes within 60s timeout
3. **CI verification:** All 5 CI jobs pass (lint, build, unit tests, integration tests, E2E tests)

## Files Changed Summary

| File | Changes |
|------|---------|
| `web/e2e/agent.spec.ts` | Add 60s timeout to `test.beforeAll()` via options object |
| `web/__tests__/integration/tenant-isolation.test.ts` | Store Bob's client, add client cleanup + signOut in `afterAll`, harden stats RPC guards |
| `web/__tests__/integration/media-lifecycle.test.ts` | Store userB's client, add client cleanup + signOut in `afterAll` |
| `web/__tests__/integration/media-storage.test.ts` | Hoist admin to module level, add client cleanup in `afterAll` |
| `web/__tests__/integration/schema-contract.test.ts` | Add `afterAll` with client cleanup, update import |
