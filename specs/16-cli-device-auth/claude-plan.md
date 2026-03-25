# Implementation Plan: CLI Device Code Auth

## Background

The smgr CLI currently authenticates via interactive email/password prompts. Users type credentials directly in the terminal, which is poor UX and a wider attack surface. Modern CLIs (GitHub CLI, Claude CLI) use a device code flow where the CLI opens a browser, the user authenticates in a familiar web UI, and the CLI receives credentials automatically.

This plan replaces the CLI's email/password login with a browser-based device code authorization flow inspired by RFC 8628. The CLI opens the user's browser to the sitemgr web app, the user approves the device, and the CLI receives valid Supabase Auth tokens via polling.

## Architecture Overview

Three components participate in the flow:

1. **CLI** (`smgr login`) — initiates the flow, opens browser, polls for approval, stores credentials
2. **Web API** (Next.js API routes) — generates device codes, mediates approval, serves tokens
3. **Web UI** (React page) — where the user approves the device code

The flow produces standard Supabase Auth tokens (access_token + refresh_token) via the `admin.generateLink()` API, so all existing RLS policies and CLI commands work unchanged.

## Database: `device_codes` Table

### Schema

A new `device_codes` table tracks pending and completed device authorization requests.

**Columns:**

| Column | Type | Purpose |
|--------|------|---------|
| `id` | `uuid` (PK) | Row identifier |
| `device_code` | `text` (unique, indexed) | 64-char hex string for CLI polling — high entropy, never shown to user |
| `user_code` | `text` (indexed where pending) | `XXXX-XXXX` format shown to user — 8 alphanumeric chars excluding ambiguous characters (0, O, 1, I, l) |
| `status` | `text` | State: `pending` → `approved` or `expired` or `denied` |
| `user_id` | `uuid` (FK auth.users) | Set when user approves |
| `device_name` | `text` | Hostname or user-provided device identifier |
| `email` | `text` | User's email, set on approval (avoids joining auth.users during poll) |
| `token_hash` | `text` | Magic link OTP hash from `admin.generateLink()`, set on approval, nulled after consumption |
| `client_ip` | `inet` | IP of the CLI that initiated the request |
| `expires_at` | `timestamptz` | 10 minutes from creation |
| `created_at` | `timestamptz` | Row creation time |
| `approved_at` | `timestamptz` | When user approved |
| `last_polled_at` | `timestamptz` | Last poll time (for future rate limiting) |

### Indexes

- Unique index on `device_code` (poll lookups)
- Partial index on `user_code` where `status = 'pending'` (approval lookups)
- Index on `expires_at` (cleanup queries)

### RLS and Data Access

Enable RLS. The `anon` role can insert (initiate flow). All reads go through a Postgres RPC function to avoid exposing the full table to anon.

- `anon` can INSERT (initiate flow — the CLI isn't authenticated)
- **No anon SELECT policy.** Instead, create an RPC function `get_device_code_status(p_device_code text)` that returns only `status`, `token_hash`, `email`, and `expires_at` for a matching row. This prevents anon from reading all rows (which would expose token_hash, user_id, client_ip of other users' codes). The function runs as `SECURITY DEFINER` with a restricted search path.
- Service role bypasses RLS for updates (approve endpoint)

After a successful poll that returns `approved`, the poll endpoint should update the row to null out `token_hash` and set `status = 'consumed'`. This prevents replay — the token can only be retrieved once.

### Cleanup

On-access cleanup: when inserting a new device code, delete rows where `expires_at < now() - interval '1 hour'`. This prevents table bloat without requiring a cron job.

### Migration File

Named following the existing pattern: `YYYYMMDDHHMMSS_device_codes.sql`. Placed in `supabase/migrations/`.

## API Routes

### `POST /api/auth/device` — Initiate

**File:** `web/app/api/auth/device/route.ts`

**Auth:** None required. The CLI isn't authenticated yet — that's the whole point.

**Request body:**
```typescript
{ device_name?: string }
```

**Response (201):**
```typescript
{
  device_code: string;      // 64-char hex
  user_code: string;        // "ABCD-1234"
  verification_url: string; // "{app_url}/auth/device?code=ABCD-1234"
  expires_at: string;       // ISO timestamp
  interval: number;         // 5 (seconds between polls)
}
```

**Logic:**
1. Generate `device_code` via `crypto.randomBytes(32).toString('hex')`
2. Generate `user_code`: pick 8 chars from safe charset (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), format as `XXXX-XXXX`. **Retry up to 3 times** if the partial unique index on `(user_code WHERE status = 'pending')` causes a conflict.
3. Build `verification_url` using `NEXT_PUBLIC_SITE_URL` or request origin
4. Insert row into `device_codes` via Supabase client with `status: 'pending'`, `expires_at: now + 10 min`
5. Delete expired rows older than 1 hour (cleanup)
6. Return response

**Supabase client:** Create a client using the anon key. The RLS policy allows anon inserts.

### `POST /api/auth/device/token` — Poll

**File:** `web/app/api/auth/device/token/route.ts`

**Auth:** None required.

**Request body:**
```typescript
{ device_code: string }
```

**Responses:**

| Status | HTTP | Body |
|--------|------|------|
| pending | 200 | `{ status: "pending" }` |
| approved | 200 | `{ status: "approved", token_hash: "...", email: "..." }` |
| expired | 200 | `{ status: "expired" }` |
| not found | 404 | `{ error: "Device code not found" }` |

**Logic:**
1. Call the `get_device_code_status(device_code)` RPC function (avoids exposing full table via anon SELECT)
2. If not found → 404
3. If `now() > expires_at` and status is still `pending` → update status to `expired`, return expired
4. If status is `approved` → return `token_hash` and `email`, then **null out `token_hash`** and set `status = 'consumed'` (one-time retrieval, prevents replay)
5. Update `last_polled_at = now()` (for future rate limiting)
6. Return current status

**Supabase client:** Anon key client — reads go through the RPC function, not direct table SELECT.

### `POST /api/auth/device/approve` — Approve

**File:** `web/app/api/auth/device/approve/route.ts`

**Auth:** Required — user must be logged in via Supabase cookie session.

**Request body:**
```typescript
{ user_code: string }
```

**Response (200):** `{ success: true }`
**Response (404):** `{ error: "Code not found or expired" }`
**Response (401):** `{ error: "Unauthorized" }`

**Logic:**
1. Create server-side Supabase client (cookie-based, via `createClient()` from `lib/supabase/server.ts`)
2. Verify user is authenticated: `auth.getUser()` — if no user, return 401
3. Look up row by `user_code` where `status = 'pending'` and `expires_at > now()`
4. If not found → 404
5. **Create admin client** using `SUPABASE_SERVICE_ROLE_KEY` (this is the narrow exception)
6. Call `admin.generateLink({ type: 'magiclink', email: user.email })` → extract `hashed_token` from `data.properties.hashed_token`
7. Update row: `status = 'approved'`, `user_id = user.id`, `email = user.email`, `token_hash = hashed_token`, `approved_at = now()`
8. Return success

**Important:** This is the only endpoint in the application that uses `SUPABASE_SERVICE_ROLE_KEY`. Document this exception with a comment in the code and a note in the env vars docs.

**Supabase clients:** Two clients in this endpoint:
- Cookie-based server client for user authentication (existing pattern from `lib/supabase/server.ts`)
- Service role client for `admin.generateLink()` (new, created inline with the key from env)

## Web UI: Device Approval Page

### `/auth/device` Page

**File:** `web/app/auth/device/page.tsx`

**Auth:** Protected by middleware — unauthenticated users are redirected to `/auth/login?redirect=%2Fauth%2Fdevice%3Fcode%3DXXXX-XXXX` (the redirect value must be URL-encoded to preserve the query parameter).

**Behavior:**
1. Read `code` query parameter from URL
2. If `code` is present, pre-fill the user code input and show it prominently
3. Display: "Approve device code: **ABCD-1234**"
4. "Approve" button submits `POST /api/auth/device/approve` with the `user_code`
5. On success: show "Device approved! You can close this tab and return to your terminal."
6. On error: show error message (invalid code, expired, already used)

**Design:** Simple centered card matching existing auth page style (same component patterns as `login-form.tsx`). Use shadcn/ui components consistent with the rest of the app.

**States:**
- Loading (while submitting)
- Success ("Device approved!")
- Error ("Invalid or expired code")
- No code provided (show input field for manual entry)

## CLI Changes

### `web/lib/auth/cli-auth.ts`

**Remove:**
- `prompt()` function — no more terminal text input
- `promptPassword()` function — no more password handling
- `login(emailArg?, passwordArg?)` function — replaced entirely

**Add:**

```typescript
function openBrowser(url: string): void
```
Cross-platform browser opening. Use `child_process.exec` with platform detection:
- macOS: `open <url>`
- Linux: `xdg-open <url>`
- Windows: `start <url>`
- Fallback: print URL to stderr if exec fails

```typescript
async function login(deviceName?: string): Promise<StoredCredentials>
```
New device code login flow:
1. Resolve API config (`SMGR_API_URL`, `SMGR_API_KEY`)
2. `POST {url}/api/auth/device` with `{ device_name: deviceName ?? os.hostname() }`
3. Open browser to `verification_url`
4. Print to stderr: `"Opening browser... Enter this code if prompted: ABCD-1234"`
5. Print to stderr: `"Waiting for browser approval. Press Ctrl+C to cancel."`
6. Poll `POST {url}/api/auth/device/token` every `interval` seconds with `{ device_code }`
7. **Client-side timeout:** Before each poll, check `Date.now() > new Date(expires_at).getTime()` — if expired, stop polling and tell user to retry
8. On `pending` → continue polling
9. On `expired` → throw error
10. On `denied` → throw error
11. On `approved` → call `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })` to get session. Note: `verifyOtp` works on an anon-key client with no prior session — same pattern as `web/app/auth/confirm/route.ts`
11. Save credentials via `saveCredentials()` (same format as today, plus optional `device_name`)
12. Return credentials

**Keep unchanged:**
- `StoredCredentials` interface (add optional `device_name?: string`)
- `loadCredentials()`, `saveCredentials()`, `clearCredentials()`
- `refreshSession()`, `resolveApiConfig()`, `whoami()`

### `web/bin/smgr.ts`

**Update `cmdLogin()`:** Remove email/password args. Just call `login()`.

```typescript
async function cmdLogin() {
  // No args needed
  const creds = await login();
  console.log(`Logged in as ${creds.email} (${creds.user_id})`);
}
```

**Update usage text:** Change `smgr login [email] [password]` to just `smgr login`.

**Update commands map:** `login: () => cmdLogin()` (no args passed through).

## Environment Variables

### New Runtime Requirement

`SUPABASE_SERVICE_ROLE_KEY` must be available in the Vercel production runtime for the approve endpoint. It's already used in:
- GitHub Actions for deployment (`SUPABASE_ACCESS_TOKEN`)
- Integration test setup (`getAdminClient()`)
- `.env.local` for local development

Add to Vercel production environment variables if not already there.

### No New Variables

The existing `SUPABASE_SERVICE_ROLE_KEY` is the only addition to Vercel runtime. No new variable names introduced.

### Local Development

`supabase start` outputs the service role key. Ensure `.env.local` includes it for local testing of the approve endpoint.

## Middleware

No changes needed. API routes already skip middleware auth (`/api/` prefix check). The `/auth/device` page route goes through normal `updateSession()` middleware, which handles redirecting unauthenticated users to login.

The redirect flow works naturally: middleware redirects to `/auth/login` with the return URL properly encoded via `encodeURIComponent()`, and after login the user returns to the original URL including query params (`/auth/device?code=ABCD-1234`).

## CLAUDE.md Policy Update

This spec introduces a narrow exception to the "app code never uses SUPABASE_SERVICE_ROLE_KEY" rule. Update the "Environment Variables & Secrets Strategy" section in CLAUDE.md to document:

- The `/api/auth/device/approve` endpoint uses the service role key for `admin.generateLink()` only
- This is the only app endpoint with this exception
- The endpoint is itself authenticated (user must be logged in)
- TODO: evaluate alternative approaches (service account, edge function) in a future spec

## Security Considerations

- **User code entropy:** 8 chars from ~30 char charset → ~39 bits. With 10-minute expiry, brute force is impractical.
- **Device code entropy:** 256 bits (64 hex chars). Used only for polling, never displayed. **Never log device_code values.**
- **OTP single-use:** `verifyOtp` consumes the magic link token — it can't be replayed. The poll endpoint nulls `token_hash` after first retrieval as a defense-in-depth measure.
- **Service role key isolation:** Only in one server-side endpoint, behind user authentication.
- **CSRF protection:** Approve endpoint requires cookie-based session. SameSite cookies prevent CSRF.
- **No rate limiting in v1:** TODO for future. Expiry and entropy provide baseline protection.
- **Token hash one-time retrieval:** The poll endpoint sets `status = 'consumed'` and nulls `token_hash` after the first successful retrieval, preventing replay even if the device_code is compromised after use.

## Testing Strategy

### Unit Tests

Test the pure logic without Supabase:
- User code generation: correct format, charset validation, no ambiguous chars
- Device code generation: correct length, hex format
- Browser opening: platform detection logic (mock `process.platform`)
- Polling loop: mock fetch, test pending/approved/expired transitions

### Integration Tests

Test the full flow against real local Supabase:
1. Call `POST /api/auth/device` → get device_code + user_code
2. Sign in as test user (via `createTestUser()`)
3. Call `POST /api/auth/device/approve` with authenticated session + user_code
4. Call `POST /api/auth/device/token` with device_code → get token_hash
5. Call `verifyOtp({ token_hash, type: 'magiclink' })` → verify we get a valid session

Also test:
- Expired code rejection (set short expiry in test)
- Invalid user_code returns 404
- Unauthenticated approve returns 401

### Existing Test Impact

Existing CLI integration tests are **unaffected** — they bypass `login()` entirely and write credentials files directly to a temp HOME directory. The `loadCredentials()` / `saveCredentials()` / `refreshSession()` functions are unchanged.

## Implementation Order

1. **Database migration** — Create `device_codes` table with RLS
2. **Server-side helpers** — Device code generation, user code generation utilities
3. **API route: initiate** — `POST /api/auth/device`
4. **API route: poll** — `POST /api/auth/device/token`
5. **API route: approve** — `POST /api/auth/device/approve`
6. **Web UI** — `/auth/device` approval page
7. **CLI refactor** — Replace `login()` in cli-auth.ts, update smgr.ts
8. **Integration tests** — Full flow test
9. **Cleanup** — Update usage text, remove dead code (prompt helpers)
