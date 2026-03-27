I have enough context. Let me generate the section content.

# Section 05: API Route -- Approve (`POST /api/auth/device/approve`)

## Overview

This section implements the approve endpoint that an authenticated web user calls to authorize a pending device code. It is the bridge between the browser session and the CLI polling loop: it generates a magic link token via Supabase's `admin.generateLink()` and stores the hashed token on the device code row so the CLI can retrieve it.

**File to create:** `/home/user/sitemgr/web/app/api/auth/device/approve/route.ts`
**Test file to create:** `/home/user/sitemgr/web/__tests__/device-approve-route.test.ts`

## Dependencies

- **section-01-db-migration:** The `device_codes` table must exist with the schema described there (columns: `id`, `device_code`, `user_code`, `status`, `user_id`, `email`, `token_hash`, `approved_at`, `expires_at`, etc.). RLS must be enabled with service role bypassing it.
- **section-02-server-helpers:** No direct dependency on the helper functions (this endpoint does not generate codes), but shares the same `web/lib/auth/` directory.
- **Existing code:** `web/lib/supabase/server.ts` exports `createClient()` which returns a cookie-based server Supabase client. This is used to authenticate the calling user.

## Tests First

Write these tests in `/home/user/sitemgr/web/__tests__/device-approve-route.test.ts` before implementing the route. All tests are unit tests that mock Supabase clients.

The test file needs two mocks:

1. **`@/lib/supabase/server`** -- mock `createClient()` to return a fake cookie-based client that controls `auth.getUser()` responses.
2. **`@supabase/supabase-js`** -- mock `createClient` (the raw SDK import) to return a fake admin client that controls `auth.admin.generateLink()` responses.

### Test: returns 401 if user is not authenticated

Mock `auth.getUser()` to return `{ data: { user: null }, error: { message: "not authenticated" } }`. Call the `POST` handler with a request body containing a valid `user_code`. Assert response status is 401 and body contains `{ error: "Unauthorized" }`.

### Test: returns 404 if user_code does not exist or is expired

Mock `auth.getUser()` to return a valid user. Mock the Supabase query chain (`.from("device_codes").select(...).eq("user_code", ...).eq("status", "pending").gt("expires_at", ...).single()`) to return `{ data: null, error: { code: "PGRST116" } }`. Assert response status is 404 and body contains `{ error: "Code not found or expired" }`.

### Test: returns 200 with `{ success: true }` on valid approval

Mock `auth.getUser()` to return a user with `id: "user-uuid"` and `email: "alice@example.com"`. Mock the select query to return a valid pending row. Mock `auth.admin.generateLink({ type: "magiclink", email: "alice@example.com" })` to return `{ data: { properties: { hashed_token: "abc123hash" } }, error: null }`. Mock the update query to succeed. Assert response status is 200, body is `{ success: true }`.

### Test: updates device_code row with correct fields

Same setup as the success test. Verify the `.update()` call receives an object matching:
```typescript
{
  status: "approved",
  user_id: "user-uuid",
  email: "alice@example.com",
  token_hash: "abc123hash",
  approved_at: expect.any(String), // ISO timestamp
}
```
And that `.eq("id", row.id)` is chained.

### Test: calls `admin.generateLink()` with correct parameters

Verify the admin client's `auth.admin.generateLink` was called with `{ type: "magiclink", email: "alice@example.com" }`.

### Test setup pattern

Follow the existing pattern from `/home/user/sitemgr/web/__tests__/health-route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the cookie-based server client
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

// Mock the raw Supabase SDK (for admin/service-role client)
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));
```

Use `vi.stubEnv()` in `beforeEach` to set:
- `NEXT_PUBLIC_SUPABASE_URL` to `"http://localhost:54321"`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to `"test-anon-key"`
- `SUPABASE_SERVICE_ROLE_KEY` to `"test-service-role-key"`

Build mock clients as return values for each mocked `createClient`. The cookie-based client mock needs `auth.getUser()`. The admin client mock needs `auth.admin.generateLink()`. Both need query builder chains (`.from().select().eq()...`).

Import the route handler after the mocks:
```typescript
import { POST } from "@/app/api/auth/device/approve/route";
```

Create `NextRequest` objects with JSON bodies for each test.

## Implementation Details

### File: `web/app/api/auth/device/approve/route.ts`

This is a Next.js App Router API route exporting a `POST` handler.

**Two Supabase clients are used in this endpoint:**

1. **Cookie-based server client** -- from `createClient()` in `@/lib/supabase/server`. Used to call `auth.getUser()` to verify the calling user's session. This is the standard pattern used across all authenticated server routes.

2. **Service-role admin client** -- created inline using `createClient` from `@supabase/supabase-js` with `SUPABASE_SERVICE_ROLE_KEY`. Used for two purposes:
   - Calling `auth.admin.generateLink({ type: "magiclink", email })` to generate the OTP hash
   - Updating the `device_codes` row (service role bypasses RLS)

**This is the only endpoint in the application that uses `SUPABASE_SERVICE_ROLE_KEY` at runtime.** Add a comment in the code documenting this exception.

### Handler logic

```
POST /api/auth/device/approve
```

1. **Authenticate the user:** Call `createClient()` from `@/lib/supabase/server`, then `auth.getUser()`. If no user, return 401 `{ error: "Unauthorized" }`.

2. **Parse request body:** Extract `user_code` (string) from the JSON body.

3. **Look up the pending device code:** Using the admin client (service role), query `device_codes` for a row matching `user_code` where `status = 'pending'` and `expires_at > now()`. Use `.single()`. If no row found, return 404 `{ error: "Code not found or expired" }`.

4. **Generate magic link token:** Call `adminClient.auth.admin.generateLink({ type: "magiclink", email: user.email })`. Extract `hashed_token` from `data.properties.hashed_token`. If this call fails, return 500 with the error.

5. **Update the row:** Update the matched row with:
   - `status: "approved"`
   - `user_id: user.id`
   - `email: user.email`
   - `token_hash: hashed_token`
   - `approved_at: new Date().toISOString()`

6. **Return success:** `{ success: true }` with HTTP 200.

### Query for pending code lookup

The query filters on three conditions to find valid pending codes:

```typescript
adminClient
  .from("device_codes")
  .select("id, user_code")
  .eq("user_code", userCode)
  .eq("status", "pending")
  .gt("expires_at", new Date().toISOString())
  .single()
```

The partial unique index on `user_code WHERE status = 'pending'` (from section-01) ensures at most one row matches.

### Admin client creation

Create the admin client inline in the handler (not as a module-level singleton, consistent with the project pattern of creating fresh clients per request):

```typescript
import { createClient as createAdminClient } from "@supabase/supabase-js";

const adminClient = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
```

### Error handling

- If `auth.getUser()` returns an error or no user: 401
- If the device code lookup returns no row: 404
- If `generateLink()` fails: 500 with `{ error: "Failed to generate auth link" }`
- If the update fails: 500 with `{ error: "Failed to approve device code" }`

Preserve Supabase error shapes in server logs (`console.error`) but return only safe messages to the client.

### Request/Response types

**Request body:**
```typescript
{ user_code: string }
```

**Success response (200):**
```typescript
{ success: true }
```

**Error responses:**
- 401: `{ error: "Unauthorized" }`
- 404: `{ error: "Code not found or expired" }`
- 500: `{ error: "Failed to generate auth link" }` or `{ error: "Failed to approve device code" }`

## Security Notes

- The endpoint is protected by cookie-based session authentication. The user must be logged in via the web app.
- SameSite cookies prevent CSRF attacks against this endpoint.
- The service role key is used server-side only and never exposed to the client.
- The `generateLink` call produces a one-time-use magic link token. Even if intercepted, `verifyOtp` consumes it on first use.
- Add a code comment: `// EXCEPTION: This endpoint uses SUPABASE_SERVICE_ROLE_KEY for admin.generateLink(). See CLAUDE.md.`