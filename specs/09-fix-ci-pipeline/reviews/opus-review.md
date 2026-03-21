# Architecture Review: 06-fix-ci-pipeline

Reviewer: opus
Date: 2026-03-20

---

## 1. Correctness

### F3: E2E beforeAll Timeout

**Issue: `test.setTimeout` inside `beforeAll` is the wrong API.**

The plan proposes adding `test.setTimeout(60_000)` at the top of the `test.beforeAll` callback. However, `test.setTimeout()` is a **test-scoped** API in Playwright -- it sets the timeout for the currently running *test*, not for the currently running *hook*. When called inside `beforeAll`, behavior is ambiguous and may not apply to the hook itself.

The correct Playwright API for setting a hook-specific timeout is to pass it as the second argument (an options object) to `test.beforeAll`:

```typescript
test.beforeAll(async ({ browser }) => {
  // ... body ...
}, { timeout: 60_000 });
```

Alternatively, if `test.setTimeout` is used, Playwright documentation states it affects the timeout of the enclosing test or hook when called inside one. As of Playwright 1.40+, `test.setTimeout` inside a `beforeAll` does in fact set that hook's timeout. So the proposed approach **will work** in recent Playwright versions, but the options-object form is more explicit, more portable across Playwright versions, and more clearly communicates intent. The plan should note this nuance or prefer the options-object syntax.

**Verdict: Functionally correct on recent Playwright, but the alternative syntax is preferable.**

### F4: Dangling Handle -- `removeAllChannels()`

**The fix is directionally correct but may be insufficient.**

`removeAllChannels()` cleans up the Realtime module's channels and underlying WebSocket. This addresses one source of dangling handles. However, the research notes identify a second source: the **GoTrue auth layer**. Even with `autoRefreshToken: false`, the Supabase JS client's internal `fetch` adapter and HTTP keep-alive connections can hold Node.js handles open.

The `@supabase/supabase-js` v2 client does not expose a general `dispose()` or `close()` method. `removeAllChannels()` is the best available cleanup, but if the dangling handle warning persists after this change, additional measures may be needed:

- Calling `auth.signOut()` on authenticated clients (this tears down the GoTrue session and may release internal timers).
- Setting `global: { fetch }` with a custom agent that has `keepAlive: false` (heavyweight, probably not worth it for tests).

**Recommendation:** Add `auth.signOut()` calls for authenticated clients (`aliceClient`, `userClient`, Bob's client) alongside `removeAllChannels()`. This is low-risk and covers the GoTrue timer path. The plan should document this as a fallback if `removeAllChannels()` alone is insufficient.

### F1/F2: Already Fixed

The plan correctly identifies that F1 (search_events assertion) and F2 (event type assertion) were already fixed in PR #36. Cross-referencing with the current source of `tenant-isolation.test.ts` confirms:
- Line 201-204: Uses `data!.length > 0` and matches by `r.id` against `aliceSeed.eventIds` -- correct.
- Line 286: Uses `"create"` -- correct.

No action needed. The plan is accurate.

### Section 3: Stats RPC Guard Hardening

**Correct and necessary.** Lines 220-226 and 234-240 of `tenant-isolation.test.ts` still wrap assertions in `if (data && data.length > 0)` guards. If the RPC returns empty results (e.g., due to a broken migration or RLS misconfiguration), the test silently passes. Removing the guard and asserting `data!.length > 0` is the right fix.

---

## 2. Completeness

### Missed Clients: Bob's client and `createTestUser` internal admin clients

**Critical gap:** The `createTestUser` function in `setup.ts` (line 35) creates a **new admin client** on every invocation via `getAdminClient()`. These ephemeral admin clients are never cleaned up. In `tenant-isolation.test.ts`, `createTestUser` is called twice (for Alice and Bob), producing two throwaway admin clients. In `media-lifecycle.test.ts`, it is called twice more.

Each of these ephemeral admin clients is a Supabase client with its own internal connection state. They are a potential source of dangling handles.

**Additionally, Bob's authenticated client** is created inside `createTestUser("bob-iso@test.local")` in `tenant-isolation.test.ts` (line 32) and returned as `bob.client`, but the return value's `.client` property is **never stored** in a module-level variable. It therefore cannot be cleaned up in `afterAll`. The plan mentions this ("Bob's client is created via createTestUser but not stored separately") but does not propose a fix. This client is another dangling handle source.

**Recommendation:**
1. Store Bob's client: `const bobClient = bob.client;` and add `bobClient.removeAllChannels()` to afterAll.
2. Consider refactoring `createTestUser` to not create a new admin client per call, or accept an admin client parameter. This is a larger change and may be out of scope, but the ephemeral admin clients are a real leak vector.

### Other Integration Test Files

The plan covers all 4 integration test files. No other test files under `__tests__/integration/` were found. This is complete.

### `media-storage.test.ts` Cleanup Pattern

The plan says to add `admin.removeAllChannels()` in `afterAll` after bucket deletion. However, note that `media-storage.test.ts` creates a **new** admin client inside `afterAll` itself (line 33: `const admin = getAdminClient()`). This means the admin used for bucket creation in `beforeAll` (line 28) is a different instance from the one used in `afterAll`. The `beforeAll` admin goes out of scope without cleanup.

**Recommendation:** Either reuse the same admin client across `beforeAll`/`afterAll` by storing it at module level, or clean up both instances. The plan should note this.

### E2E Test: No afterAll Cleanup Needed

The E2E test (`agent.spec.ts`) uses Playwright's browser context, not Supabase JS clients directly. No client cleanup is needed there. The plan correctly limits E2E changes to the timeout fix only.

---

## 3. Risks

### Risk: `removeAllChannels()` on clients with no channels

All test clients are created with `autoRefreshToken: false` and `persistSession: false`. None subscribe to realtime channels. Calling `removeAllChannels()` on a client with zero channels should be a no-op (returns an empty resolved promise). This is safe -- no risk of breaking existing tests.

### Risk: Stats guard removal could expose flaky tests

Removing the `if` guard from `stats_by_content_type` and `stats_by_event_type` means that if these RPCs return empty data, the test will now **fail** instead of silently passing. This is the correct behavior. However, if there is a timing issue (e.g., data not yet committed when the RPC runs), this could surface as flakiness.

Looking at the test structure: the data is seeded in `beforeAll` using the admin client with direct inserts (not through the user client), and tests run with `fileParallelism: false`. The seed data should be fully committed before these tests execute. **Risk is low.**

### Risk: Timeout value (60s) may be too tight in CI

The plan sets 60s for the E2E `beforeAll` timeout. The worst-case Mailpit retry loop is ~50s. In CI environments with constrained resources (GitHub Actions runners), network and process scheduling delays could push the total past 60s. A more conservative value of 90s would cost nothing (the test still fails fast on real errors due to the `maxAttempts` limit in `getConfirmationLink`).

**Recommendation:** Consider 90s instead of 60s, or at minimum document that 60s assumes healthy CI infrastructure.

---

## 4. Omissions

### 4.1. No mention of `auth.signOut()` for authenticated clients

As noted above, `removeAllChannels()` addresses the Realtime module but not GoTrue internals. Adding `auth.signOut()` for authenticated clients (Alice, Bob, userClient, userB) is a low-cost addition that could prevent a second round of debugging if `removeAllChannels()` alone does not resolve the dangling handle.

### 4.2. `createTestUser` creates ephemeral admin clients that leak

Each call to `createTestUser` instantiates a fresh admin client via `getAdminClient()`. These are never cleaned up. The plan does not address this. While this may not be the primary dangling handle source, it contributes. A note in the plan acknowledging this as a known limitation (or a follow-up item) would be appropriate.

### 4.3. No verification step for "clean exit" specifically

The plan says to verify "clean exit (no dangling handle warning)" but does not describe how to detect the warning programmatically. Vitest exits with code 0 even when the dangling handle warning appears (it is a warning, not an error). The CI pipeline presumably treats this as a failure somehow (the spec says "dangling handle warning causes non-clean exit"). The plan should clarify the mechanism: does CI use `--forceExit` with a non-zero exit? Does it grep for the warning string? Understanding this is important for verification.

### 4.4. Vitest `--pool` and `--poolOptions` not considered

The research mentions Vitest configuration but does not explore whether the test pool (threads vs forks) affects handle behavior. With `threads` (the default), handles in worker threads may behave differently than in the main process. With `forks`, child processes are killed on completion, which would mask handle leaks. This is likely not relevant if the current config uses the default, but worth noting.

### 4.5. Missing: `media-lifecycle.test.ts` has a `userB` client that needs cleanup

In `media-lifecycle.test.ts`, line 43-44:
```typescript
const userB = await createTestUser();
userBId = userB.userId;
```
The `userB.client` is created but never stored at module level. The plan (Section 2b) says to add cleanup for `admin` and `userClient` but does not mention `userB`'s client. This is the same pattern as Bob's client in `tenant-isolation.test.ts` -- a leaked authenticated client.

**Recommendation:** Store `userB.client` and clean it up in `afterAll`.

---

## 5. Style

### Consistent with existing patterns

- The `afterAll` cleanup pattern (sequential awaits or `Promise.all`) matches existing code style.
- Adding `afterAll` to `schema-contract.test.ts` and updating the vitest import is straightforward and consistent.
- The plan correctly notes that `afterAll` must be added to the import list in `schema-contract.test.ts` (line 5 currently imports only `describe, it, expect, beforeAll`).

### Minor style note

The plan uses `60_000` (numeric separator) for the timeout value. The existing codebase uses plain numbers (e.g., `30000` in `media-lifecycle.test.ts` line 72, `10000` and `20000` in `agent.spec.ts`). For consistency, use `60000` without the separator, or adopt separators consistently across the file.

### Code snippet quality

The plan's code snippets are clear and minimal. The `Promise.all` pattern for parallel cleanup is appropriate.

---

## Summary

| Area | Assessment |
|------|-----------|
| F3 (timeout) | Correct but consider options-object syntax for clarity |
| F4 (dangling handle) | Partially correct -- `removeAllChannels()` is necessary but likely insufficient alone |
| Section 3 (stats guards) | Correct and needed |
| Completeness | **Gaps**: Bob's client, userB's client, and ephemeral admin clients from `createTestUser` are not cleaned up |
| Risks | Low overall; 60s timeout may be tight in CI |
| Style | Consistent with codebase conventions; minor numeric separator inconsistency |

### Recommended changes to the plan:

1. **Store and clean up Bob's client** in `tenant-isolation.test.ts` and **userB's client** in `media-lifecycle.test.ts`.
2. **Add `auth.signOut()`** calls for all authenticated clients alongside `removeAllChannels()`.
3. **Use the options-object form** for Playwright `beforeAll` timeout: `test.beforeAll(async ({ browser }) => { ... }, { timeout: 60_000 })`.
4. **Address `media-storage.test.ts`** admin client mismatch: the `beforeAll` admin and `afterAll` admin are different instances; hoist to module level.
5. **Consider 90s** instead of 60s for the E2E timeout to account for CI variability.
6. **Use `60000`** (no numeric separator) for consistency with existing code.
