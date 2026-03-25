I now have enough context. Let me generate the section content.

# Section 03: API Route -- Initiate (`POST /api/auth/device`)

## Overview

This section implements the `POST /api/auth/device` API route. This is the first endpoint the CLI calls when a user runs `smgr login`. It generates a device code and user code, inserts a pending row into the `device_codes` table, cleans up expired rows, and returns the codes plus a verification URL to the caller.

**File to create:** `/home/user/sitemgr/web/app/api/auth/device/route.ts`
**Test file to create:** `/home/user/sitemgr/web/__tests__/device-initiate-route.test.ts`

## Dependencies

- **section-01-db-migration:** The `device_codes` table must exist with its RLS policy allowing anon INSERT.
- **section-02-server-helpers:** The `generateDeviceCode()` and `generateUserCode()` functions in `web/lib/auth/device-codes.ts` must be implemented.

## Tests (Write First)

Create `/home/user/sitemgr/web/__tests__/device-initiate-route.test.ts`.

The test file mocks two modules:
1. `@/lib/auth/device-codes` -- mock `generateDeviceCode()` and `generateUserCode()` to return deterministic values.
2. `@supabase/supabase-js` -- mock `createClient` to return a fake Supabase client with controllable `.from().insert()` and `.from().delete()` behavior.

Use `vi.stubEnv()` in `beforeEach` for:
- `NEXT_PUBLIC_SUPABASE_URL` = `"http://localhost:54321"`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = `"test-anon-key"`
- `NEXT_PUBLIC_SITE_URL` = `"http://localhost:3000"`

### Test Cases

1. **Returns 201 with correct response shape.** Call `POST` with `new Request(url, { method: "POST", body: JSON.stringify({}) })`. Assert response status is 201, body contains `device_code` (64-char hex), `user_code` (matches `/^[A-Z0-9]{4}-[A-Z0-9]{4}$/`), `verification_url` (string containing the user_code as a query param), `expires_at` (ISO string ~10 minutes in the future), and `interval` (equal to 5).

2. **`device_code` is 64-char hex.** Verify the mocked `generateDeviceCode()` return value is passed through to the response unchanged.

3. **`user_code` matches `XXXX-XXXX` format.** Verify the mocked `generateUserCode()` return value is passed through.

4. **`verification_url` contains the user_code as query parameter.** Parse the URL from the response and check `searchParams.get("code")` equals the user_code.

5. **`expires_at` is approximately 10 minutes in the future.** Parse the timestamp and assert it is between 9 and 11 minutes from `Date.now()`.

6. **`interval` is 5.** Straightforward assertion.

7. **Accepts optional `device_name` in body.** Send `{ device_name: "my-laptop" }`. Verify the insert call includes `device_name: "my-laptop"`.

8. **Retries user_code generation on unique constraint collision.** Mock the insert to fail once with Postgres error code `23505` (unique_violation), then succeed on retry. Assert `generateUserCode()` was called twice and the response is still 201.

9. **Returns 500 after max retries exhausted.** Mock insert to fail with `23505` three times (max retries). Assert response status is 500 with an error message.

10. **Calls delete for expired rows (cleanup).** Assert that `supabase.from("device_codes").delete()` is called with a filter for `expires_at` less than 1 hour ago.

### Test Structure

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock device-codes helpers
vi.mock("@/lib/auth/device-codes", () => ({
  generateDeviceCode: vi.fn(),
  generateUserCode: vi.fn(),
}));

// Mock createClient from supabase-js (the route creates an anon client directly)
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

describe("POST /api/auth/device", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    vi.clearAllMocks();
  });

  // ... test cases as described above
});
```

Each test should import `{ POST }` from `@/app/api/auth/device/route` (dynamic import after mocks are set up), construct a `Request` object, and call `POST(request)` directly -- the same pattern used in `health-route.test.ts`.

## Implementation Details

### File: `web/app/api/auth/device/route.ts`

This is a Next.js App Router API route exporting a single `POST` handler.

**Supabase client creation:** Create an anon-key client using `createClient` from `@supabase/supabase-js` (not the server cookie-based client from `lib/supabase/server.ts` -- there are no cookies in this unauthenticated request). Use `process.env.NEXT_PUBLIC_SUPABASE_URL` and `process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

**Handler logic:**

1. Parse request body. Extract optional `device_name` (string). Default to `"unknown"` if not provided.

2. Generate codes by calling `generateDeviceCode()` and `generateUserCode()` from `@/lib/auth/device-codes`.

3. Compute `expires_at` as `new Date(Date.now() + 10 * 60 * 1000).toISOString()`.

4. Build `verification_url`: use `process.env.NEXT_PUBLIC_SITE_URL` (falling back to the request's `Origin` header) appended with `/auth/device?code=${user_code}`.

5. **Insert with retry loop (up to 3 attempts):** Insert into `device_codes` table:
   ```typescript
   {
     device_code,
     user_code,
     status: "pending",
     device_name,
     expires_at,
     client_ip: request.headers.get("x-forwarded-for") ?? "unknown",
   }
   ```
   If the insert fails with Postgres error code `23505` (unique_violation on the `user_code` partial index), regenerate `user_code` and retry. After 3 failures, return `NextResponse.json({ error: "Failed to generate unique code" }, { status: 500 })`.

6. **Cleanup expired rows:** After successful insert, fire-and-forget a delete:
   ```typescript
   supabase
     .from("device_codes")
     .delete()
     .lt("expires_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
   ```
   This runs without awaiting in production (or awaited -- either is acceptable since it is a lightweight query). The cleanup is best-effort; failures should be logged but not block the response.

7. Return `NextResponse.json(...)` with status 201:
   ```typescript
   {
     device_code,
     user_code,
     verification_url,
     expires_at,
     interval: 5,
   }
   ```

**Error handling:** If the insert fails for a reason other than `23505`, return the Supabase error shape in a 500 response. Do not reshape or strip fields from the error (per the project's "don't reshape data" principle).

### Key Design Decisions

- The route uses the **anon key client** (not the server cookie client, not the service role client). The CLI is unauthenticated at this point. The RLS INSERT policy on `device_codes` allows anon inserts.
- The `client_ip` is extracted from `x-forwarded-for` for informational/audit purposes. It is not used for any security decisions in v1.
- The cleanup delete uses a 1-hour buffer past `expires_at` to avoid deleting rows that are expired but still being polled (the 10-minute expiry window is much shorter than the 1-hour cleanup threshold).
- The retry loop for user_code collisions is capped at 3 attempts. Given the ~39-bit entropy of user codes and the expected low volume of concurrent pending codes, collisions should be extremely rare.

### Import Summary

```typescript
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { generateDeviceCode, generateUserCode } from "@/lib/auth/device-codes";
```