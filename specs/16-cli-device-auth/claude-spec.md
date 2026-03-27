# Synthesized Spec: CLI Device Code Auth

## Overview

Replace the smgr CLI's email/password login (`smgr login`) with a browser-based device code authorization flow (RFC 8628-inspired). The CLI opens the user's browser, the user authenticates on the sitemgr web app and approves the device, and the CLI receives valid Supabase Auth tokens via polling. This is the only login method — no password fallback.

## Architecture

### Flow

```
CLI                            Server API                     Browser
 │                                │                              │
 ├─ POST /api/auth/device ───────►│                              │
 │◄── {device_code, user_code,    │                              │
 │     verification_url,          │                              │
 │     expires_at, interval}      │                              │
 │                                │                              │
 ├─ open browser to               │                              │
 │  /auth/device?code=ABCD-1234 ─┼─────────────────────────────►│
 │  print "Waiting for approval.  │                              │
 │  Press Ctrl+C to cancel."      │                              │
 │                                │  User logs in (if needed)    │
 │                                │  Sees pre-filled code        │
 │                                │  Clicks "Approve"            │
 │                                │◄── POST /api/auth/device/    │
 │                                │         approve              │
 │                                │                              │
 │                                │  Server (service role key):  │
 │                                │  admin.generateLink({        │
 │                                │    type: 'magiclink',        │
 │                                │    email: user.email         │
 │                                │  })                          │
 │                                │  Store hashed_token on row   │
 │                                │  Status → approved           │
 │                                │                              │
 ├─ POST /api/auth/device/token ─►│                              │
 │   (polling every 5s)           │                              │
 │◄── {status: "approved",        │                              │
 │     token_hash, email}         │                              │
 │                                │                              │
 │  verifyOtp({token_hash,        │                              │
 │    type: 'magiclink'})         │                              │
 │  → access_token + refresh_token│                              │
 │                                │                              │
 │  Save to ~/.sitemgr/           │                              │
 │    credentials.json            │                              │
 │  Print "Logged in as X"        │                              │
```

### Key Decisions

1. **Service role key exception:** The `/api/auth/device/approve` endpoint uses `SUPABASE_SERVICE_ROLE_KEY` to call `auth.admin.generateLink()`. This is the only app endpoint that uses the service role key. It's justified because: the endpoint is authenticated (user must be logged in), it runs server-side only, and it produces standard Supabase tokens. TODO: revisit this approach later.

2. **No password fallback.** Device code flow is the only CLI login method. No `--email`/`--password` flags. Headless/CI uses pre-provisioned credentials files (the existing test pattern).

3. **User code format:** `ABCD-1234` — 8 alphanumeric characters (excluding ambiguous chars), split into two groups of 4 with a hyphen.

4. **Pre-fill code in URL:** CLI opens `/auth/device?code=ABCD-1234` so the user just clicks "Approve" instead of typing the code.

5. **Auth redirect:** If user isn't logged in, redirect to `/auth/login?redirect=/auth/device?code=ABCD-1234`, then back after login.

6. **No rate limiting for v1.** The 10-minute expiry and code entropy provide baseline protection. TODO for future.

7. **Simple CLI UX:** Static message during polling: "Waiting for browser approval. Press Ctrl+C to cancel." No spinner or countdown.

## Database

### New table: `device_codes`

```sql
CREATE TABLE device_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code text NOT NULL UNIQUE,        -- 64-char hex, high entropy, for CLI polling
  user_code text NOT NULL,                  -- ABCD-1234 format, for user to verify
  status text NOT NULL DEFAULT 'pending',   -- pending | approved | expired | denied
  user_id uuid REFERENCES auth.users(id),  -- set on approval
  device_name text,                         -- hostname or user-provided
  token_hash text,                          -- magic link OTP hash, set on approval
  client_ip inet,                           -- IP that initiated the request
  expires_at timestamptz NOT NULL,          -- 10 min from creation
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  last_polled_at timestamptz               -- for future rate limiting
);

CREATE INDEX idx_device_codes_device_code ON device_codes (device_code);
CREATE INDEX idx_device_codes_user_code ON device_codes (user_code) WHERE status = 'pending';
CREATE INDEX idx_device_codes_expires_at ON device_codes (expires_at);
```

### RLS Policies

- **No direct user access.** API routes mediate all access using the service role key (for the approve endpoint) or querying without RLS (the initiate/poll endpoints don't need user context).
- **Cleanup:** On-access cleanup — when creating a new device code, delete expired rows older than 1 hour.

Since the initiate and poll endpoints are unauthenticated, and the approve endpoint uses the service role key, RLS on this table should either be disabled or have a permissive policy for the service role. The simplest approach: **disable RLS** on `device_codes` since all access is mediated through API routes that use either the service role key or no auth.

Wait — actually, the initiate and poll endpoints don't use the service role key. They use the anon key. So we need RLS policies that allow:
- Anon (unauthenticated) inserts for initiation
- Anon reads for polling (by device_code)
- Service role updates for approval

Simplest: enable RLS, add policies for `anon` role for insert/select, and service role bypasses RLS by default.

```sql
ALTER TABLE device_codes ENABLE ROW LEVEL SECURITY;

-- Anon can insert (initiate flow)
CREATE POLICY "anon_insert_device_codes" ON device_codes
  FOR INSERT TO anon
  WITH CHECK (true);

-- Anon can select by device_code (poll flow)
CREATE POLICY "anon_select_device_codes" ON device_codes
  FOR SELECT TO anon
  USING (true);

-- Service role bypasses RLS by default (no policy needed for approve)
```

## API Endpoints

### `POST /api/auth/device` — Initiate

**Auth:** None (anon)
**Body:** `{ device_name?: string }`
**Response:**
```json
{
  "device_code": "a1b2c3...64chars",
  "user_code": "ABCD-1234",
  "verification_url": "https://app.sitemgr.com/auth/device?code=ABCD-1234",
  "expires_at": "2025-01-01T00:10:00Z",
  "interval": 5
}
```

**Logic:**
1. Generate `device_code` (64-char hex via `crypto.randomBytes(32).toString('hex')`)
2. Generate `user_code` (8 alphanumeric chars, formatted as `XXXX-XXXX`, excluding ambiguous chars)
3. Insert into `device_codes` with `status: 'pending'`, `expires_at: now + 10 min`
4. Clean up expired rows older than 1 hour
5. Return response

**Supabase client:** Use anon key client (no auth needed). Actually — the insert needs to work for unauthenticated requests. Use the service role key client here too, or use the anon key with appropriate RLS.

### `POST /api/auth/device/token` — Poll

**Auth:** None (anon)
**Body:** `{ device_code: string }`
**Response (pending):** `{ status: "pending" }`
**Response (approved):** `{ status: "approved", token_hash: "...", email: "user@example.com" }`
**Response (expired):** `{ status: "expired" }`
**Response (denied):** `{ status: "denied" }`

**Logic:**
1. Look up `device_code` in table
2. If not found → 404
3. If expired (now > expires_at) → update status to `expired`, return `{ status: "expired" }`
4. Return current status (with token_hash if approved)
5. Update `last_polled_at`

### `POST /api/auth/device/approve` — Approve

**Auth:** Required (user must be logged in via Supabase cookie session)
**Body:** `{ user_code: string }`
**Response:** `{ success: true }` or `{ error: "..." }`

**Logic:**
1. Verify user is authenticated via `createClient()` + `auth.getUser()`
2. Look up `user_code` in `device_codes` where `status = 'pending'` and not expired
3. If not found → 404
4. Create admin client with `SUPABASE_SERVICE_ROLE_KEY`
5. Call `admin.generateLink({ type: 'magiclink', email: user.email })`
6. Update row: `status = 'approved'`, `user_id = user.id`, `token_hash = hashed_token`, `approved_at = now()`
7. Return success

## Web UI

### `/auth/device` page

- **Protected route** — middleware redirects to login if not authenticated
- Read `code` query parameter, pre-fill the user code input
- Show the code prominently: "Approve device code: **ABCD-1234**"
- "Approve" button calls `POST /api/auth/device/approve` with the user_code
- Success state: "Device approved! You can close this tab."
- Error state: "Invalid or expired code. Please try again."
- Design: simple centered card matching existing auth pages (login-form.tsx pattern)

## CLI Changes

### `web/lib/auth/cli-auth.ts`

**Remove:**
- `prompt()` helper
- `promptPassword()` helper
- `login(emailArg?, passwordArg?)` function

**Add:**
- `login()` — new device code flow (no args)
  1. Call `POST {apiUrl}/api/auth/device` with optional `device_name` (hostname)
  2. Open browser to `verification_url` via `open` package (or `child_process.exec` with platform detection)
  3. Print to stderr: "Opening browser... Enter this code if prompted: ABCD-1234"
  4. Print to stderr: "Waiting for browser approval. Press Ctrl+C to cancel."
  5. Poll `POST {apiUrl}/api/auth/device/token` every `interval` seconds
  6. On `approved`: call `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })`
  7. Save credentials via existing `saveCredentials()`
  8. Print: "Logged in as user@example.com"

**Keep unchanged:**
- `loadCredentials()`, `saveCredentials()`, `clearCredentials()`, `whoami()`
- `refreshSession()`, `resolveApiConfig()`
- `StoredCredentials` interface (add optional `device_name` field)

### `web/bin/smgr.ts`

- Update `cmdLogin()` — no more args, just calls `login()`
- Update usage text — `smgr login` (no `[email] [password]`)

## Environment Variables

**New (Vercel production):**
- `SUPABASE_SERVICE_ROLE_KEY` — already exists in GitHub secrets for deployment, now also needed as a Vercel runtime secret for the approve endpoint only

**No new env vars needed.** The service role key is already a known secret — it just needs to be added to Vercel production environment (if not already there).

**For local dev / E2E:** The local Supabase instance service role key is output by `supabase start` and would need to be in `.env.local`.

## Security

- **User code:** 8 chars from charset of ~30 chars (alphanumeric minus ambiguous) → ~39 bits of entropy. Combined with 10-minute expiry, brute force impractical even without rate limiting.
- **Device code:** 256 bits (64 hex chars). Never shown to users.
- **OTP one-time use:** Once `verifyOtp` is called, the magic link token is consumed by Supabase.
- **CSRF:** Approve endpoint requires authenticated cookie session. SameSite cookies protect against CSRF.
- **No secrets on client machines:** CLI never handles passwords. Device code is bearer-like but short-lived.
- **Service role key:** Only in server-side approve endpoint, never sent to client.

## Testing Strategy

**Unit tests:**
- Device code generation (format, entropy)
- User code generation (format, charset, no ambiguous chars)
- Status transitions
- CLI polling loop (mocked HTTP)

**Integration tests:**
- Full flow: initiate → approve → poll → verifyOtp → session
- Expired code rejection
- Invalid user_code rejection
- Requires: local Supabase, service role key in test env

**Existing CLI tests:** Unaffected — they bypass `login()` entirely and write credentials files directly.

## Out of Scope

- Device management UI (list/revoke)
- OAuth/SSO providers
- Rate limiting (TODO for future)
- WebSocket push instead of polling
- QR code in terminal
