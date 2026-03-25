# 16: CLI Device Code Auth — Browser-Based Login

## Problem

The smgr CLI currently authenticates via interactive email/password prompt (`smgr login`). This has several issues:

- **Poor UX**: Users must type credentials in the terminal, including a hidden password prompt
- **No SSO/OAuth support**: Email/password is the only auth method, blocking future social login or enterprise SSO
- **Password handling in CLI**: The CLI directly handles password input and sends it to Supabase Auth — this is a wider attack surface than browser-based auth
- **No device management**: Users have no visibility into which devices are authenticated or ability to revoke individual devices

Modern CLIs (GitHub CLI, Claude CLI, ChatGPT CLI) use a **device code flow** where the CLI opens a browser, the user authenticates in familiar web UI, and the CLI receives credentials automatically.

## Goal

Replace the CLI's email/password login with a device code authorization flow (RFC 8628-inspired). The CLI opens the user's browser, the user authenticates on the web app, and the CLI receives valid Supabase Auth tokens via polling.

## How It Works

### Flow Overview

```
CLI                          Server API                    Browser
 │                              │                            │
 ├─ POST /api/auth/device ─────►│                            │
 │◄── {device_code,             │                            │
 │     user_code,               │                            │
 │     verification_url,        │                            │
 │     expires_at, interval}    │                            │
 │                              │                            │
 ├─ open browser ───────────────┼───────────────────────────►│
 │   "Go to URL, enter code"    │                            │
 │                              │                            │
 │                              │    User visits /auth/device│
 │                              │    Logs in (if needed)     │
 │                              │    Enters user_code        │
 │                              │◄── POST /api/auth/device/  │
 │                              │         approve            │
 │                              │                            │
 │                              │  Server: validate code,    │
 │                              │  generate magic link OTP   │
 │                              │  via admin API, store with │
 │                              │  device_code               │
 │                              │                            │
 ├─ POST /api/auth/device/token►│                            │
 │   (polling with device_code) │                            │
 │◄── {status: "approved",      │                            │
 │     token_hash, email}       │                            │
 │                              │                            │
 │  CLI: verifyOtp(token_hash)  │                            │
 │  → gets access_token +       │                            │
 │    refresh_token              │                            │
 │                              │                            │
 │  Store in ~/.sitemgr/        │                            │
 │    credentials.json          │                            │
 └──────────────────────────────┴────────────────────────────┘
```

### Step-by-Step

1. **CLI initiates**: `smgr login` calls `POST /api/auth/device` → server generates a `device_code` (random, high-entropy, for CLI polling) and a `user_code` (short, human-readable, e.g. `ABCD-1234`) with an expiry (10 minutes)
2. **CLI opens browser**: Opens `{app_url}/auth/device` and displays: `"Enter code: ABCD-1234"` in the terminal
3. **User authenticates in browser**: Visits the device auth page, logs in if not already authenticated, enters the `user_code`
4. **Server approves**: Validates the `user_code`, associates it with the authenticated user. Uses Supabase Admin API `auth.admin.generateLink({type: 'magiclink', email})` to generate a `hashed_token` OTP. Stores the OTP with the device_code record.
5. **CLI polls**: CLI polls `POST /api/auth/device/token` every `interval` seconds with the `device_code`. Server responds with one of:
   - `{status: "pending"}` — user hasn't approved yet
   - `{status: "approved", token_hash, email}` — ready to exchange
   - `{status: "expired"}` — device code expired
   - `{status: "denied"}` — user explicitly denied
6. **CLI exchanges OTP for session**: CLI calls `supabase.auth.verifyOtp({token_hash, type: 'magiclink'})` to get a full Supabase session (access_token + refresh_token)
7. **CLI stores credentials**: Same `~/.sitemgr/credentials.json` format as today, plus a new `device_name` field

### Why Supabase Magic Link OTP?

The device code flow needs to produce standard Supabase Auth tokens (access_token + refresh_token) so the CLI works with RLS policies unchanged. Supabase doesn't have a native device code grant, but the admin `generateLink` API creates a verifiable OTP that produces real Supabase sessions. This keeps everything within Supabase Auth — no custom JWT signing, no service role key on user machines.

## What Changes

### Database

**New table: `device_codes`**

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` | Primary key |
| `device_code` | `text` | High-entropy random string, CLI uses this to poll (indexed, unique) |
| `user_code` | `text` | Short human-readable code, e.g. `ABCD-1234` (indexed, unique while active) |
| `status` | `text` | `pending`, `approved`, `expired`, `denied` |
| `user_id` | `uuid` | Set when user approves (FK to auth.users) |
| `device_name` | `text` | User-agent or CLI-provided device name |
| `token_hash` | `text` | Magic link OTP hash, set on approval |
| `client_ip` | `inet` | IP of the CLI that initiated the request |
| `expires_at` | `timestamptz` | When the device code expires (10 min from creation) |
| `created_at` | `timestamptz` | Row creation time |
| `approved_at` | `timestamptz` | When the user approved |

**RLS policies:**
- Service role only for insert/update (API routes handle all access)
- No direct user access — the API routes mediate everything
- Alternatively: authenticated users can read their own approved device codes (for future device management UI)

**Cleanup:** A scheduled job or on-access cleanup deletes expired rows older than 1 hour.

### Web API Routes

**`POST /api/auth/device`** — Initiate device code flow
- No auth required (the whole point is the CLI isn't authenticated yet)
- Rate limited by IP (max 10 requests per minute)
- Returns: `{device_code, user_code, verification_url, expires_at, interval}`
- `interval` defaults to 5 seconds

**`POST /api/auth/device/token`** — Poll for approval
- No auth required
- Body: `{device_code}`
- Rate limited: enforce `interval` (return 428 Too Early if polling too fast)
- Returns status-dependent response (see flow above)
- On `approved`: includes `token_hash` and `email` for the CLI to call `verifyOtp`

**`POST /api/auth/device/approve`** — User approves a device code
- **Requires authentication** (user must be logged in on the web)
- Body: `{user_code}`
- Server validates code exists, is pending, not expired
- Server calls `supabase.auth.admin.generateLink({type: 'magiclink', email: user.email})`
- Stores the resulting `hashed_token` on the device_code row
- Updates status to `approved`

### Web UI

**New page: `/auth/device`**
- Shows a form to enter the `user_code`
- If not logged in, redirects to `/auth/login?redirect=/auth/device`
- On submit, calls `POST /api/auth/device/approve`
- Shows success/error state
- Design: simple, centered card matching existing auth page style

### CLI (`web/lib/auth/cli-auth.ts` + `web/bin/smgr.ts`)

**New `login()` flow:**
1. Call `POST /api/auth/device` to get device_code + user_code
2. Try to open browser via `open` (macOS) / `xdg-open` (Linux) / `start` (Windows)
3. Display: `"Opening browser... Enter this code: ABCD-1234"` and fallback URL if browser doesn't open
4. Poll `POST /api/auth/device/token` with device_code every `interval` seconds
5. On approval, call `supabase.auth.verifyOtp({token_hash, type: 'magiclink'})`
6. Store credentials as today

**Updated `StoredCredentials`:**
```typescript
export interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email: string;
  expires_at: number;
  device_name?: string;  // new: human-readable device identifier
}
```

**Fallback:** Keep `smgr login --email <email> --password <password>` as a non-interactive fallback for CI/scripts. The device code flow is the default when running interactively (TTY detected).

### Env Vars

No new production env vars required. The API routes use the existing Supabase server client (which already has admin access via `SUPABASE_SERVICE_ROLE_KEY` in the server context... actually wait — per CLAUDE.md, app code never uses the service role key).

**Important constraint:** Application code never uses `SUPABASE_SERVICE_ROLE_KEY`. The `auth.admin.generateLink()` call requires admin/service role access. Options:

1. **Create a dedicated internal API endpoint** that runs with elevated privileges (similar to how the webhook handler uses a service account)
2. **Use a device-auth service account** — a dedicated Supabase user with a special role, similar to `webhook@sitemgr.internal`
3. **Re-evaluate the constraint for this specific use case** — `generateLink` is a controlled server-side operation, not a general admin bypass

**Recommended: Option 3 with narrow scope.** The `/api/auth/device/approve` route is the only place that needs admin access, and it's authenticated (the user must be logged in). Create a `getDeviceAuthAdminClient()` helper that uses the service role key, scoped to this single use case. Document the exception in CLAUDE.md.

Alternatively, if we want to strictly avoid the service role key: use Supabase's built-in magic link flow — have the server call `signInWithOtp({email})` which sends the user an email, and the user clicks the link. But this adds friction (extra email step) and doesn't match the smooth device code UX.

## Security Considerations

- **User code entropy**: 8 alphanumeric characters (excluding ambiguous chars like 0/O, 1/I/l) → ~30 bits of entropy. Combined with 10-minute expiry and rate limiting, brute force is impractical.
- **Device code entropy**: 64-character hex string → 256 bits. Never displayed to users.
- **Rate limiting**: IP-based rate limiting on `/api/auth/device` (initiation) and `/api/auth/device/token` (polling). Return 429 on excess.
- **Polling interval enforcement**: Server tracks last poll time per device_code. Returns 428 if polled too quickly (prevents hammering).
- **CSRF on approval**: The approve endpoint requires an authenticated session (Supabase cookie). Standard CSRF protections apply via SameSite cookies.
- **One-time use**: Once a device_code is approved and the OTP is consumed, the row is marked `used` — the OTP cannot be replayed.
- **Expiry**: Device codes expire after 10 minutes. Expired codes are rejected immediately.
- **No secrets on client**: The CLI never receives or handles passwords. The `device_code` is a bearer token but is short-lived and single-use.

## Migration Path

1. **Phase 1**: Add device code flow as the new default for `smgr login` (this spec)
2. **Phase 2**: Keep email/password as `smgr login --password` fallback for CI/headless
3. **Phase 3** (future): Add device management UI on the web (list devices, revoke)
4. **Phase 4** (future): Remove email/password CLI login entirely

## Files to Change

| File | Change |
|------|--------|
| `supabase/migrations/xxx_device_codes.sql` | New `device_codes` table + RLS policies |
| `web/app/api/auth/device/route.ts` | Initiate endpoint |
| `web/app/api/auth/device/token/route.ts` | Poll/exchange endpoint |
| `web/app/api/auth/device/approve/route.ts` | Approval endpoint (authenticated) |
| `web/app/auth/device/page.tsx` | Device code entry UI |
| `web/lib/auth/cli-auth.ts` | New device code login flow, keep password fallback |
| `web/lib/auth/device-codes.ts` | Server-side device code generation, validation, OTP exchange |
| `web/bin/smgr.ts` | Update login command, add `--password` flag |
| `web/middleware.ts` | Allow unauthenticated access to `/api/auth/device` and `/api/auth/device/token` |

## Testing

- **Unit**: Device code generation (entropy, format, expiry)
- **Unit**: User code format validation and uniqueness
- **Unit**: Status transitions (pending → approved → used, pending → expired)
- **Unit**: Rate limiting logic (polling interval enforcement)
- **Integration**: Full flow — initiate, approve, poll, exchange OTP, verify session
- **Integration**: Expired code rejection
- **Integration**: Invalid user_code rejection
- **E2E**: CLI login opens browser prompt, displays code (mock browser open)

## Out of Scope

- Device management UI (list/revoke devices) — future spec
- OAuth/SSO provider support (Google, GitHub login) — separate effort, but device code flow is compatible
- Push notification to CLI (WebSocket) instead of polling — polling is sufficient for v1
- QR code display in terminal — nice-to-have, not required

## Open Questions

1. **Service role key exception**: Should we create a narrow exception to the "no service role key in app code" rule for `generateLink`, or find an alternative approach? → Recommend: narrow exception, documented.
2. **Device name**: Should the CLI auto-detect a device name (hostname) or let the user provide one? → Recommend: auto-detect hostname, allow override with `--device-name`.
3. **Concurrent codes**: Should a user be limited to N active device codes? → Recommend: max 5 pending codes per IP, no per-user limit (user isn't known at initiation time).
