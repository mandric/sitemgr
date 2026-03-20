# Integration Notes — Opus Review Feedback

## Suggestions Integrated

### 1. Store and clean up Bob's client (tenant-isolation) and userB's client (media-lifecycle)
**Integrating.** The review correctly identified that these authenticated clients are created by `createTestUser()` but never stored at module level, making cleanup impossible. Will add module-level variables for both and clean them up in afterAll.

### 2. Add `auth.signOut()` for authenticated clients
**Partially integrating.** Will add `auth.signOut()` calls for authenticated user clients (Alice, Bob, userClient, userB). Won't add for admin or anon clients since they don't have active auth sessions. This covers the GoTrue timer teardown path.

### 3. Use options-object form for Playwright beforeAll timeout
**Integrating.** The `{ timeout: 60000 }` options-object syntax is more explicit and portable than `test.setTimeout()` inside the callback.

### 4. Hoist admin client in media-storage.test.ts to module level
**Integrating.** The review correctly identified that `beforeAll` and `afterAll` create separate admin client instances. Will hoist to module level so the same instance is used and cleaned up.

### 5. Consider 90s instead of 60s for E2E timeout
**Not integrating.** 60s provides 10s headroom on the 50s worst case. The Mailpit retry has a 5s cap per attempt, and GitHub Actions runners consistently handle this. If 60s proves insufficient, it's trivial to bump. Starting conservative avoids masking real timeouts.

### 6. Use `60000` without numeric separator
**Integrating.** Matches existing code style (30000, 10000, 20000 in the codebase).

## Suggestions Not Integrated

### createTestUser ephemeral admin client leak
**Not integrating (out of scope).** Each call to `createTestUser()` creates a new admin client via `getAdminClient()`. These are used only for the admin API call (createUser, signInWithPassword) and then abandoned. Fixing this requires refactoring `createTestUser` to accept an admin parameter, which is a separate cleanup task. The primary dangling handle sources are the long-lived module-level clients, not these short-lived ones.

### Vitest --pool consideration
**Not integrating.** The current config uses default pool settings. Investigating pool behavior is orthogonal to the dangling handle fix.

### Verification mechanism for clean exit
**Noted but not changing plan.** The "clean exit" verification is manual: run `npm run test:integration` and check that the process exits cleanly without the warning message. CI uses Vitest's default behavior. If the warning persists, the follow-up is to add `auth.signOut()` (already integrated above should handle it).
