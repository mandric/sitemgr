Now I have enough context. Let me write the section.

# Section 08: Integration Tests

## Overview

This section adds integration tests for the complete device code authentication flow. These tests run against a real local Supabase instance and the Next.js dev server (auto-spawned by the existing `globalSetup.ts`). They verify the full happy path, expired code handling, invalid code handling, and unauthenticated approval rejection.

## Dependencies

- **Section 01** (DB migration): `device_codes` table must exist
- **Section 02** (Server helpers): Code generation utilities
- **Section 03** (API initiate): `POST /api/auth/device` route
- **Section 04** (API poll): `POST /api/auth/device/token` route
- **Section 05** (API approve): `POST /api/auth/device/approve` route
- **Section 06** (Web UI): `/auth/device` page (not directly tested here, but the approve endpoint it calls is)
- **Section 07** (CLI refactor): CLI-side flow (not tested here; these tests exercise the API routes directly)

## File to Create

`/home/user/sitemgr/web/__tests__/integration/device-auth.test.ts`

## Test Infrastructure

The integration test infrastructure is already in place:

- **`globalSetup.ts`** validates environment variables (`SMGR_API_URL`, `SMGR_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`), checks Supabase connectivity, and auto-spawns a Next.js dev server on port 3000 if one is not already running.
- **`setup.ts`** provides `getSupabaseConfig()`, `getAdminClient()`, `createTestUser()`, and `cleanupUserData()`.
- Tests run with `testTimeout: 60000` and `hookTimeout: 30000`.
- The dev server base URL is derived from the port (default 3000): `http://localhost:3000`.

The device auth API routes are unauthenticated (initiate, poll) or cookie-authenticated (approve). Since integration tests cannot easily set cookie-based sessions for Next.js API routes, the approve endpoint must be tested by passing the user's access token via the Supabase cookie header or by directly manipulating the database for the approval step and testing the full initiate-poll cycle through HTTP.

The recommended approach: use the admin client to simulate the approval step (update the `device_codes` row directly with `status: 'approved'`, `token_hash`, and `email`) for the happy-path test, and call the approve API route with an `Authorization: Bearer <token>` header for the auth-related tests. Alternatively, if the approve endpoint reads cookies from the request, the test can set the `sb-*` cookie headers manually.

**Practical approach for approve endpoint testing:** The approve endpoint uses `createClient()` from `lib/supabase/server.ts` which reads cookies from the Next.js request. In integration tests, the simplest way to test the approve endpoint is to:

1. Use the admin client to call `admin.generateLink({ type: 'magiclink', email })` to get a `hashed_token`
2. Use the admin client to update the `device_codes` row directly (simulating what the approve endpoint does)
3. Then test the poll endpoint to verify the flow completes

For testing the 401 case (unauthenticated approve), just call the endpoint with no cookies -- this is straightforward with `fetch()`.

## Tests

The test file should contain four test cases within a single `describe` block.

### Test 1: Complete device code auth flow end-to-end

Steps:
1. `POST /api/auth/device` with `{ device_name: "integration-test" }` -- verify 201 response with `device_code`, `user_code`, `verification_url`, `expires_at`, `interval`
2. Create a test user via `createTestUser()`
3. Simulate approval: use the admin client to call `admin.auth.admin.generateLink({ type: 'magiclink', email: testUserEmail })`, extract `hashed_token` from `data.properties.hashed_token`
4. Use the admin client to update the `device_codes` row: set `status = 'approved'`, `token_hash = hashed_token`, `email = testUserEmail`, `user_id`, `approved_at = now()`
5. `POST /api/auth/device/token` with `{ device_code }` -- verify response has `status: "approved"`, `token_hash`, and `email`
6. Create an anon Supabase client. Call `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })` -- verify a valid session is returned
7. Verify the session user's email matches the test user's email
8. Poll again: `POST /api/auth/device/token` with same `device_code` -- verify `status: "consumed"` and no `token_hash`

Cleanup: delete the test user and the `device_codes` row via the admin client.

### Test 2: Expired code flow

Steps:
1. `POST /api/auth/device` to create a device code
2. Use the admin client to update the row's `expires_at` to a time in the past (e.g., `NOW() - interval '1 minute'`)
3. `POST /api/auth/device/token` with the `device_code` -- verify response has `status: "expired"`
4. Attempt to approve: use the admin client to look up the row by `user_code WHERE status = 'pending'` -- verify it finds nothing (because the poll endpoint should have set the status to `expired`)

### Test 3: Invalid user_code returns 404 on approve

Steps:
1. `POST /api/auth/device/approve` with `{ user_code: "ZZZZ-9999" }` and no authentication cookies
2. Verify the response is 401 (unauthenticated takes precedence) or 404

This test overlaps with test 4 but from a different angle -- an invalid code should fail regardless.

### Test 4: Unauthenticated approve returns 401

Steps:
1. `POST /api/auth/device` to create a valid device code (to ensure the user_code exists)
2. `POST /api/auth/device/approve` with `{ user_code }` but no cookies/auth headers
3. Verify the response status is 401
4. Verify the response body contains `{ error: "Unauthorized" }` or similar

## Test Structure (Stubs)

```typescript
/**
 * Integration tests for device code authentication flow.
 *
 * Tests the complete lifecycle: initiate → approve → poll → verifyOtp.
 * Runs against real local Supabase and the Next.js dev server.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getSupabaseConfig,
  getAdminClient,
  createTestUser,
} from "./setup";

const APP_URL = `http://localhost:${process.env.WEB_PORT ?? "3000"}`;

describe("device code auth flow", () => {
  let admin: SupabaseClient;
  const cleanupUserIds: string[] = [];
  const cleanupDeviceCodes: string[] = [];

  beforeAll(() => {
    admin = getAdminClient();
  });

  afterAll(async () => {
    // Clean up device_codes rows
    for (const dc of cleanupDeviceCodes) {
      await admin.from("device_codes").delete().eq("device_code", dc);
    }
    // Clean up test users
    for (const uid of cleanupUserIds) {
      await admin.auth.admin.deleteUser(uid);
    }
  });

  it("complete happy path: initiate → approve → poll → verifyOtp", async () => {
    // 1. Initiate device code flow
    // 2. Create test user, generate magic link token via admin API
    // 3. Simulate approval by updating device_codes row directly
    // 4. Poll for approved status, get token_hash
    // 5. verifyOtp with token_hash → valid session
    // 6. Verify session email matches
    // 7. Second poll returns consumed (no token_hash)
  });

  it("expired code returns expired status on poll", async () => {
    // 1. Initiate device code
    // 2. Set expires_at to past via admin client
    // 3. Poll → status: "expired"
  });

  it("poll with unknown device_code returns 404", async () => {
    // POST /api/auth/device/token with a random device_code
    // Expect 404
  });

  it("unauthenticated approve returns 401", async () => {
    // 1. Initiate to get a valid user_code
    // 2. POST /api/auth/device/approve with user_code, no auth
    // 3. Expect 401
  });
});
```

## Key Implementation Notes

**Calling API routes from tests:** Use `fetch()` against `APP_URL` (the Next.js dev server). All requests should include `Content-Type: application/json`. Example:

```typescript
const res = await fetch(`${APP_URL}/api/auth/device`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ device_name: "integration-test" }),
});
```

**Simulating approval without cookies:** The approve endpoint requires cookie-based auth which is difficult to replicate in a fetch-based integration test. Instead, simulate approval by directly updating the `device_codes` table via the admin client (which bypasses RLS). Use `admin.auth.admin.generateLink()` to get a real `hashed_token` that `verifyOtp` will accept.

**verifyOtp client:** Create a fresh anon-key Supabase client (no prior session) and call `auth.verifyOtp({ token_hash, type: 'magiclink' })`. This mirrors what the CLI does. The token_hash from `admin.generateLink()` is a real OTP that Supabase Auth will honor.

**Cleanup:** Always clean up `device_codes` rows and test users in `afterAll`. Track device codes and user IDs in arrays populated during each test, so cleanup runs even if assertions fail.

**Timeout considerations:** The happy path test involves multiple HTTP round-trips and a `verifyOtp` call. The default 60-second timeout should be sufficient, but if tests are slow, individual test timeouts can be increased.

**No `cleanupUserData` needed:** These tests do not seed events, enrichments, or other user data -- they only create auth users and `device_codes` rows. Direct deletion via the admin client is sufficient.