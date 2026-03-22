Now I have everything I need. Let me generate the section content.

# Section 2: Remove Service Role Key from Health Endpoint

## Overview

The health endpoint at `web/app/api/health/route.ts` currently uses `getAdminClient()` with `SUPABASE_SERVICE_ROLE_KEY` to check database connectivity. This is unnecessary privilege escalation -- the health check only needs to confirm the database is reachable, not bypass Row Level Security. Switch it to `getUserClient()` with the anon key.

## Dependencies

- None. This section can be implemented independently (Batch 1).
- Blocked by: nothing.
- Blocks: section-09-dev-server-setup (globalSetup polls this endpoint).

## Current State

The file `web/app/api/health/route.ts` currently:

1. Imports `getAdminClient` from `@/lib/media/db`
2. Creates an admin client with `SUPABASE_SERVICE_ROLE_KEY`
3. Runs a head-only count query on the `events` table
4. Returns 200 with `"ok"` if the query succeeds, 503 with `"degraded"` if it fails

The query is:
```typescript
.from("events").select("id", { count: "exact", head: true }).limit(0)
```

With the anon key and no authenticated user, RLS will return count=0 (since `auth.uid()` is null). That is fine -- a non-error response proves the database is reachable.

## Tests First

### Unit test file: `web/__tests__/health-route.test.ts`

Create this new unit test file. It mocks the `@/lib/media/db` module to verify the health route uses `getUserClient` and not `getAdminClient`.

**Test stubs:**

```
# Test: health endpoint creates a user client (getUserClient), not an admin client
# Test: health endpoint does not reference SUPABASE_SERVICE_ROLE_KEY env var
# Test: health endpoint returns 200 with status "ok" when DB is reachable
# Test: health endpoint returns 503 when DB query fails
```

**Approach:**

- Use `vi.mock("@/lib/media/db")` to mock both `getUserClient` and `getAdminClient`.
- Use `vi.stubEnv()` to set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to fixture values. Do NOT set `SUPABASE_SERVICE_ROLE_KEY`.
- Import the `GET` handler from `web/app/api/health/route.ts`.
- For the "200 ok" test: configure the mock `getUserClient` to return a client whose `.from().select().limit()` chain resolves with `{ error: null }`. Call `GET()` and assert the response has status 200 and body contains `status: "ok"`.
- For the "503 degraded" test: configure the mock chain to resolve with `{ error: { message: "connection refused" } }`. Assert status 503 and body contains `status: "degraded"`.
- For the "no admin client" test: after calling `GET()`, assert that `getAdminClient` was NOT called (use `expect(getAdminClient).not.toHaveBeenCalled()`).
- For the "no SUPABASE_SERVICE_ROLE_KEY" test: read the source file as a string and assert it does not contain `SUPABASE_SERVICE_ROLE_KEY`. Alternatively, verify that the mock `getUserClient` was called with `url` and `anonKey` arguments (not `serviceKey`).

### Integration test extension: `web/__tests__/integration/auth-smoke.test.ts`

Add one test to the existing auth smoke integration tests:

```
# Test: GET /api/health returns 200 without service role key in environment
```

This test hits the live health endpoint (requires a running Next.js dev server and Supabase) and confirms it works with only the anon key configured. This test may need section-09 (dev server setup in globalSetup) to run reliably, but can be written now.

## Implementation

### File to modify: `web/app/api/health/route.ts`

**Change 1: Replace the import.** Change `getAdminClient` to `getUserClient`:

```typescript
import { getUserClient } from "@/lib/media/db";
```

**Change 2: Replace the client creation.** Switch from admin client with service key to user client with anon key:

```typescript
const supabase = getUserClient({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
});
```

**Change 3: Keep everything else the same.** The query, error handling, and response format are unchanged. The `getUserClient` function signature takes `{ url: string, anonKey: string }` (defined as `SupabaseUserConfig` in `web/lib/media/db.ts`).

### Why this works

The `getUserClient` function (at `/home/user/sitemgr/web/lib/media/db.ts` line 68) creates a Supabase client with the anon/publishable key. When this client queries `events` without an authenticated session, RLS policies mean the query returns zero rows -- but it does NOT return an error. A successful zero-row response proves the database is reachable, which is all the health check needs.

The two environment variables used (`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) are already available in the Next.js runtime since they are `NEXT_PUBLIC_*` prefixed. No new environment variables are needed.

### What NOT to change

- The TODO comments about Anthropic and Twilio checks are unrelated -- leave them.
- The response shape (`status`, `service`, `timestamp`) is unchanged.
- The HTTP status codes (200 for ok, 503 for degraded) are unchanged.

## Verification

After implementation, confirm:

1. `grep -n "getAdminClient\|SERVICE_ROLE_KEY" web/app/api/health/route.ts` returns zero matches.
2. `grep -n "getUserClient" web/app/api/health/route.ts` returns the import and usage lines.
3. Unit tests pass: `cd /home/user/sitemgr/web && npx vitest run __tests__/health-route.test.ts`
4. If a local Supabase and dev server are running: `curl http://localhost:3000/api/health` returns `{"status":"ok",...}` with HTTP 200.