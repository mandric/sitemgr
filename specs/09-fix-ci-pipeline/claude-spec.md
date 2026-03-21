# Combined Specification — Fix CI Pipeline

## Problem Statement

The CI pipeline for PR #36 (branch `claude/deep-plan-integration-tests-6CXn9`) is failing in two jobs: integration tests and E2E tests. There are 4 distinct bugs plus 1 warning that need resolution in a single PR.

## Failures

### F1: search_events Assertion Uses Non-existent Column (tenant-isolation.test.ts:200)

The test asserts `data.every(r => r.user_id === aliceId)`, but `search_events` RETURNS TABLE does not include `user_id`. The result is `undefined` for every row. Additionally, the assertion is wrapped in an `if (data && data.length > 0)` guard, so if data is empty, the test silently passes.

**Required fix:** Remove the `if` guard. Assert `data!.length > 0`. Change assertion to match by event ID (same pattern used in media-lifecycle.test.ts).

### F2: Event Type Assertion Uses Wrong Expected Value (tenant-isolation.test.ts:284)

The test asserts `original!.type` equals `"photo"`, but `seedUserData` creates events with `type: "create"`.

**Required fix:** Change `"photo"` to `"create"`.

### F3: E2E beforeAll Timeout (agent.spec.ts)

The `beforeAll` hook performs user signup + email confirmation via Mailpit with exponential backoff (up to ~50s). Playwright's default beforeAll timeout is 30s.

**Required fix:** Add explicit timeout parameter to `test.beforeAll()` — set to 60s. Do NOT change playwright.config.ts (per-test only).

### F4: Dangling Handle Warning (integration test runner)

After integration tests complete, Vitest reports that something prevents clean process exit. Root cause: Supabase JS clients maintain internal connections (GoTrue timers, potential WebSocket handles) that aren't cleaned up.

**Required fix:** Add client cleanup (`removeAllChannels()` or equivalent) in `afterAll` of ALL 4 integration test files:
- tenant-isolation.test.ts
- media-lifecycle.test.ts
- media-storage.test.ts
- schema-contract.test.ts

### F5: .env.local Heredoc Whitespace (ci.yml) — ALREADY FIXED

The `.env.local` generation in CI was converted from a broken heredoc to `printf`. No change needed.

## Decisions from Interview

1. **All 5 fixes ship in one PR** (single atomic commit)
2. **No new migration needed** for RPC function grants — Supabase auto-grants EXECUTE to authenticated role by default
3. **Dangling handle cleanup** applies to all 4 integration test files, not just tenant-isolation
4. **E2E timeout** — per-test only, no global playwright config change
5. **search_events assertion** — match by event ID (same pattern as media-lifecycle.test.ts)

## Files to Modify

| File | Change |
|------|--------|
| `web/__tests__/integration/tenant-isolation.test.ts` | Fix assertions (F1, F2), add client cleanup (F4) |
| `web/__tests__/integration/media-lifecycle.test.ts` | Add client cleanup (F4) |
| `web/__tests__/integration/media-storage.test.ts` | Add client cleanup (F4) |
| `web/__tests__/integration/schema-contract.test.ts` | Add client cleanup (F4) |
| `web/e2e/agent.spec.ts` | Add beforeAll timeout (F3) |

## Verification

All CI jobs must pass: lint, build, unit tests, integration tests (clean exit, no dangling handle), E2E tests.
