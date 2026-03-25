Now I have all the context I need. Let me produce the section content.

# Section 04: API Route -- Poll (`POST /api/auth/device/token`)

## Overview

This section implements the poll endpoint that the CLI calls repeatedly to check whether a device code has been approved. The endpoint looks up a device code via the `get_device_code_status()` RPC function (created in section-01), returns the current status, and on approval returns `token_hash` + `email` exactly once (nulling the hash afterward to prevent replay).

**File to create:** `/home/user/sitemgr/web/app/api/auth/device/token/route.ts`
**Test file to create:** `/home/user/sitemgr/web/__tests__/device-token-route.test.ts`

## Dependencies

- **section-01-db-migration**: The `device_codes` table and `get_device_code_status(p_device_code text)` RPC function must exist. The RPC returns columns: `status`, `token_hash`, `email`, `expires_at`.
- **section-02-server-helpers**: Not directly used by this route, but the helper utilities are shared context.

## Tests First

Create `/home/user/sitemgr/web/__tests__/device-token-route.test.ts`. The test file mocks the Supabase client module and tests the route handler function directly (same pattern as `health-route.test.ts`).

### Test Structure

Mock `@/lib/supabase/server` (or whichever client factory the route uses). Since the poll endpoint uses an anon-key client and calls the RPC function, the mock should simulate `supabase.rpc('get_device_code_status', { p_device_code })` returning various shapes.

For the one-time consumption update, the route also needs to call an update on the `device_codes` table. Since anon cannot UPDATE directly (RLS), the route uses a service-role or SECURITY DEFINER function. The implementation detail here is that the status transition to `consumed` and nulling of `token_hash` happens via an update call. Mock this as well.

### Test Cases

```typescript
// File: /home/user/sitemgr/web/__tests__/device-token-route.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Supabase client creation
// The route creates an anon client to call the RPC, and needs a way to
// perform the consumption update. Mock accordingly.

describe("POST /api/auth/device/token", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
    vi.clearAllMocks();
  });

  // Test: returns { status: "pending" } for a pending device code
  // - Mock RPC to return { status: "pending", token_hash: null, email: null, expires_at: future }
  // - Assert response is 200 with body { status: "pending" }

  // Test: returns { status: "approved", token_hash, email } for an approved code
  // - Mock RPC to return { status: "approved", token_hash: "abc123", email: "user@example.com", expires_at: future }
  // - Assert response is 200 with body containing all three fields
  // - Assert that the update call was made to null token_hash and set status to "consumed"

  // Test: returns { status: "expired" } when code has expired
  // - Mock RPC to return { status: "pending", token_hash: null, email: null, expires_at: past }
  // - Assert response is 200 with body { status: "expired" }
  // - Assert that an update was issued to set status = "expired" in the DB

  // Test: returns 404 for unknown device code
  // - Mock RPC to return null/empty data
  // - Assert response is 404 with body { error: "Device code not found" }

  // Test: after returning approved, token_hash is nulled (consumed)
  // - This is verified by checking the mock update call sets token_hash to null
  //   and status to "consumed"

  // Test: subsequent poll after consumption returns { status: "consumed" } without token_hash
  // - Mock RPC to return { status: "consumed", token_hash: null, email: "user@example.com", expires_at: future }
  // - Assert response is 200 with body { status: "consumed" } and no token_hash field

  // Test: returns 400 if device_code is missing from request body
  // - Send empty body or body without device_code
  // - Assert 400 response
});
```

Each test should construct a `Request` object and call the `POST` handler directly, then inspect the `NextResponse`. Follow the pattern from `health-route.test.ts` where the route handler is imported and invoked.

## Implementation Details

### Route File: `/home/user/sitemgr/web/app/api/auth/device/token/route.ts`

**Auth:** None required. The CLI is not yet authenticated; that is the purpose of this flow.

**Request body:**
```typescript
{ device_code: string }
```

**HTTP method:** `POST` (export an async `POST` function following Next.js App Router convention).

### Logic

1. Parse the JSON request body. If `device_code` is missing or not a string, return 400.

2. Create a Supabase client using the anon key. Use the same pattern as `health/route.ts` -- create a client via `getUserClient()` from `@/lib/media/db` with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

3. Call the RPC function:
   ```typescript
   const { data, error } = await supabase.rpc("get_device_code_status", {
     p_device_code: device_code,
   });
   ```

4. If `data` is null or empty, return `NextResponse.json({ error: "Device code not found" }, { status: 404 })`.

5. Check expiry: if `status === "pending"` and `new Date(data.expires_at) < new Date()`, update the row to `status: 'expired'` and return `{ status: "expired" }`.

6. If `status === "approved"` and `data.token_hash` is present:
   - Capture `token_hash` and `email` from the RPC result.
   - Update the row: set `token_hash = null` and `status = 'consumed'`. This update needs to bypass RLS. Two options:
     - (a) Use a second SECURITY DEFINER function like `consume_device_code(p_device_code text)`.
     - (b) Use the service role client for this single update.
   - The preferred approach is option (a) -- add a small SECURITY DEFINER function in the migration (section-01) that performs the consumption update. If section-01 did not include this, a follow-up migration or an inline service-role client can be used. Document the choice.
   - Return `{ status: "approved", token_hash, email }`.

7. Update `last_polled_at = now()` on the row (best-effort, do not fail the request if this update fails). This also requires write access -- same mechanism as step 6.

8. For any other status (`pending`, `consumed`, `expired`, `denied`), return `{ status: data.status }` with HTTP 200.

### Response Summary

| Scenario | HTTP Status | Body |
|----------|-------------|------|
| Pending, not expired | 200 | `{ status: "pending" }` |
| Approved (first retrieval) | 200 | `{ status: "approved", token_hash: "...", email: "..." }` |
| Expired (detected on poll) | 200 | `{ status: "expired" }` |
| Already consumed | 200 | `{ status: "consumed" }` |
| Not found | 404 | `{ error: "Device code not found" }` |
| Missing device_code | 400 | `{ error: "device_code is required" }` |

### Consumption Update Detail

The one-time retrieval pattern is critical for security. After the route reads `token_hash` from the RPC result, it must null it out before returning. The update should be atomic or at minimum happen before the response is sent. The pattern:

```typescript
// After capturing token_hash and email from data:
await supabase.rpc("consume_device_code", { p_device_code: device_code });
// Then return the response with token_hash and email
```

If `consume_device_code` is not available from the migration, use an alternative approach:
- Create an admin/service-role client inline (importing `SUPABASE_SERVICE_ROLE_KEY` from env) to perform the update directly on the table. This mirrors the approach used in `approve/route.ts` (section-05).
- However, per CLAUDE.md policy, minimize service role key usage. Prefer the SECURITY DEFINER RPC.

### Supabase Client

Use the anon-key client pattern from the health route:

```typescript
import { getUserClient } from "@/lib/media/db";

const supabase = getUserClient({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
});
```

The RPC function `get_device_code_status` runs as SECURITY DEFINER, so it can read the table despite anon having no SELECT policy. Similarly, a `consume_device_code` RPC function can update the row despite anon having no UPDATE policy.

### Error Handling

Follow the codebase principle: pass through Supabase `{ data, error }` shapes. If the RPC returns an error, log it and return a 500 with a generic message. Do not reshape the error object unnecessarily.

```typescript
if (error) {
  console.error("[device-token] RPC error:", error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
```

### Security Notes

- **Never log the `device_code` value.** Use a prefix or hash if logging is needed for debugging.
- **Never log `token_hash`.** It is a secret that grants authentication.
- The endpoint is unauthenticated by design -- the device_code's 256-bit entropy prevents guessing.
- The one-time retrieval (null-after-read) prevents replay attacks if a device_code is somehow compromised after use.