# TDD Plan — Fix CI Pipeline

This document mirrors `claude-plan.md` and defines what tests to verify BEFORE and AFTER implementing each section.

## Testing Context

- **Framework:** Vitest (integration tests), Playwright (E2E tests)
- **Conventions:** Tests in `web/__tests__/integration/` for Vitest, `web/e2e/` for Playwright
- **Run commands:** `npm run test:integration` (Vitest), `npm run test:e2e` (Playwright)
- **Existing patterns:** `beforeAll`/`afterAll` lifecycle hooks, `cleanupUserData()` helper, `createTestUser()` factory

---

## Section 1: E2E beforeAll Timeout Fix

### Pre-implementation verification
- Test: Confirm current `test.beforeAll` in `agent.spec.ts` has no timeout parameter (baseline)
- Test: Run `npm run test:e2e` locally and observe whether beforeAll exceeds 30s (reproduces the CI failure if Mailpit is slow)

### Post-implementation verification
- Test: `test.beforeAll` accepts `{ timeout: 60000 }` options object without Playwright type errors
- Test: Run `npm run test:e2e` — beforeAll completes successfully
- Test: If Mailpit is unavailable, beforeAll fails with "No confirmation email found" error within 60s (not a hang)

---

## Section 2: Dangling Handle Cleanup

### Pre-implementation verification
- Test: Run `npm run test:integration` and observe "something prevents the main process from exiting" warning in output
- Test: Confirm no `removeAllChannels()` or `auth.signOut()` calls exist in any integration test `afterAll`

### Post-implementation verification — per file

#### 2a. tenant-isolation.test.ts
- Test: `bobClient` variable exists at module level and is assigned in `beforeAll`
- Test: `afterAll` calls `auth.signOut()` on `aliceClient` and `bobClient`
- Test: `afterAll` calls `removeAllChannels()` on all 4 clients (admin, aliceClient, bobClient, anonClient)
- Test: All existing assertions still pass (no regression from storing bobClient)

#### 2b. media-lifecycle.test.ts
- Test: `userBClient` variable exists at module level and is assigned in `beforeAll`
- Test: `afterAll` calls `auth.signOut()` on `userClient` and `userBClient`
- Test: `afterAll` calls `removeAllChannels()` on all 3 clients (admin, userClient, userBClient)
- Test: All existing assertions still pass

#### 2c. media-storage.test.ts
- Test: `admin` is a module-level variable (not redeclared in `beforeAll` or `afterAll`)
- Test: `afterAll` uses the same `admin` instance as `beforeAll`
- Test: `afterAll` calls `removeAllChannels()` on admin after bucket cleanup
- Test: All existing assertions still pass

#### 2d. schema-contract.test.ts
- Test: `afterAll` import added to vitest import line
- Test: `afterAll` block exists and calls `removeAllChannels()` on admin
- Test: All existing schema assertions still pass

### Integration verification
- Test: Run `npm run test:integration` — all tests pass AND process exits cleanly (no dangling handle warning)

---

## Section 3: Stats RPC Guard Hardening

### Pre-implementation verification
- Test: Confirm `stats_by_content_type` test has `if (data && data.length > 0)` guard (silently passes on empty)
- Test: Confirm `stats_by_event_type` test has same guard pattern

### Post-implementation verification
- Test: `stats_by_content_type` asserts `data!.length > 0` (will fail if RPC returns empty)
- Test: `stats_by_event_type` asserts `data!.length > 0` (will fail if RPC returns empty)
- Test: Both tests still verify total count equals 2 (Alice has 2 seeded events)
- Test: No `if` guard wrapping the assertions in either test
