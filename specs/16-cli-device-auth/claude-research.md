# Research: CLI Device Code Auth

## Codebase Research

### WhatsApp Webhook Service Account Pattern

**Location:** `web/app/api/whatsapp/route.ts`

The webhook creates a Supabase client authenticated as a service account:

```typescript
async function createWebhookClient(): Promise<SupabaseClient> {
  const client = getUserClient({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  });

  const email = process.env.WEBHOOK_SERVICE_ACCOUNT_EMAIL;
  const password = process.env.WEBHOOK_SERVICE_ACCOUNT_PASSWORD;

  if (!email || !password) {
    throw new Error("Webhook service account credentials not configured");
  }

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`Webhook service account auth failed: ${error.message}`);
  }

  return client;
}
```

**Key details:**
- Uses the **anon key** client, not service role (least privilege)
- Signs in as a pre-created auth user with narrowly-scoped RLS policies
- Well-known UUID: `00000000-0000-0000-0000-000000000001`
- Env vars: `WEBHOOK_SERVICE_ACCOUNT_EMAIL`, `WEBHOOK_SERVICE_ACCOUNT_PASSWORD`
- Stored in Vercel production secrets only

### Existing API Route Patterns

- `/api/health/route.ts` — Simple health check, no auth
- `/api/media/[id]/route.ts` — Auth via `createClient()` + `auth.getUser()`
- `/api/whatsapp/route.ts` — Unauthenticated endpoint, service account internally

**Auth-protected pattern:**
```typescript
const supabase = await createClient();
const { data: { user } } = await supabase.auth.getUser();
if (!user) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

**Response format:** `NextResponse.json({ data } | { error: "message" }, { status })`

### Middleware

```typescript
export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next(); // API routes skip middleware auth
  }
  return await updateSession(request);
}
```

API routes handle auth themselves. The device code initiate/poll endpoints need no middleware changes — they're already under `/api/`.

The **web page** at `/auth/device` will need auth via `updateSession()` middleware (which redirects to login if no session). This is the existing behavior for all non-API routes.

### Auth Page Patterns

Login form (`components/login-form.tsx`):
- Client-side form submission
- Uses browser Supabase client from `lib/supabase/client.ts`
- Direct `signInWithPassword()` call
- Redirect on success via `router.push("/protected")`
- Error state displayed in UI

### Migration Patterns

**Naming:** `YYYYMMDDHHMMSS_descriptive_name.sql`

**RLS pattern for service accounts:**
```sql
CREATE POLICY "Service account can access device_codes"
ON device_codes FOR ALL
TO authenticated
USING (
  (SELECT auth.uid()) = '<service-account-uuid>'::uuid
)
WITH CHECK (
  (SELECT auth.uid()) = '<service-account-uuid>'::uuid
);
```

RLS policies are additive (OR logic) — new policies don't override existing ones.

### CLI Auth (`lib/auth/cli-auth.ts`)

**Current flow:**
- `login(emailArg?, passwordArg?)` — prompts for email/password, calls `signInWithPassword()`
- `refreshSession()` — auto-refresh if expires in < 60 seconds
- `loadCredentials()` / `saveCredentials()` — read/write `~/.sitemgr/credentials.json` (mode 0o600)
- `resolveApiConfig()` — reads `SMGR_API_URL` and `SMGR_API_KEY` from env

**CLI getClient() in smgr.ts:**
```typescript
async function getClient(): Promise<SupabaseClient> {
  const { url, anonKey } = resolveApiConfig();
  const client = getUserClient({ url, anonKey });
  const creds = await refreshSession();
  // ... setSession with stored tokens
}
```

### Test Infrastructure

**Integration tests bypass login entirely:**
- `createTestUser()` in `setup.ts` uses admin API to create user + sign in
- Writes session tokens directly to temp credentials file
- Tests set `HOME` env to temp dir so CLI reads from there

**Unit tests:** Mock the auth module with `vi.mock()` and `vi.stubEnv()`

**Vitest config:** Two projects (`unit` and `integration`), integration has 60s timeout.

---

## Supabase Auth API Research

### `auth.admin.generateLink()`

**Requires service role key** — cannot be called by a regular authenticated user or service account.

```typescript
const { data, error } = await supabase.auth.admin.generateLink({
  type: 'magiclink',
  email: 'user@example.com',
});
// Returns: { properties: { action_link, hashed_token, redirect_to, verification_type } }
```

- Returns `hashed_token` — a verifiable OTP hash
- The CLI can use `verifyOtp({ token_hash: hashed_token, type: 'magiclink' })` to establish a session
- **Problem:** Requires service role key, which we don't want in app code

### `signInWithOtp({ email })`

```typescript
const { data, error } = await supabase.auth.signInWithOtp({
  email: 'user@example.com',
  options: { shouldCreateUser: false }
});
```

- Sends a magic link email to the user
- **Does NOT return the OTP** — it's only in the email
- Can be called with the anon key (no admin required)
- **Problem:** Sends an email, which adds friction and doesn't fit the device code UX

### `verifyOtp()`

```typescript
const { data, error } = await supabase.auth.verifyOtp({
  token_hash: '<hashed_token>',
  type: 'magiclink',
});
// Returns: { session: { access_token, refresh_token, ... }, user: { ... } }
```

- Produces a real Supabase session (access_token + refresh_token)
- Works with any client (anon key is sufficient)
- The `token_hash` comes from `admin.generateLink()`

### Alternative: Custom Token Exchange

Since the service account can't call `admin.generateLink()`, we need an alternative approach:

**Option A: Narrow service role key exception**
- Use the service role key ONLY in the `/api/auth/device/approve` route
- This is a server-side endpoint, the key never leaves the server
- The approve endpoint is itself authenticated (user must be logged in)
- Minimal blast radius — single endpoint, controlled access

**Option B: Supabase Edge Function**
- Deploy an Edge Function with service role access that generates the link
- Call it from the API route
- More infrastructure complexity

**Option C: Password-based exchange (creative hack)**
- When user approves, server generates a random one-time password
- Server updates the user's password to this OTP (requires service role)
- CLI signs in with OTP password, then server restores original password
- **Bad idea** — race conditions, fragile

**Option D: Session token relay**
- When user approves in browser, their active session tokens are captured
- These tokens are stored with the device_code
- CLI receives these tokens directly
- **Problem:** This creates a session clone, both browser and CLI share tokens
- Supabase sessions have independent refresh tokens, so this could actually work
- But it feels hacky and may break if Supabase invalidates the original session

**Recommended: Option A** — Use the service role key in a single, well-documented endpoint. Per the spec, this is marked as a TODO to revisit. The endpoint is authenticated and server-side only.

### Service Account Capabilities

A regular Supabase user (service account) **can:**
- `signInWithPassword()` — authenticate itself
- Query tables per RLS policies
- Call RPC functions per EXECUTE grants
- `signInWithOtp()` — trigger magic link emails (for itself or others)

A regular user **cannot:**
- `auth.admin.*` — any admin operations
- `generateLink()` — create OTP tokens
- `createUser()` / `deleteUser()` — manage users
- Bypass RLS

---

## RFC 8628: Device Authorization Grant

### Core Flow

1. **Device Authorization Request** (`POST /device/authorize`)
   - Client sends: `client_id`, optional `scope`
   - Server returns: `device_code`, `user_code`, `verification_uri`, `verification_uri_complete` (optional, includes user_code in URL), `expires_in`, `interval`

2. **User Interaction**
   - User visits `verification_uri` in browser
   - Enters `user_code` (or uses `verification_uri_complete` which pre-fills it)
   - Authenticates and approves the device

3. **Device Token Request** (polling, `POST /token`)
   - Client sends: `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id`
   - Server responds with token or error

### Standard Error Responses

| Error | Meaning |
|-------|---------|
| `authorization_pending` | User hasn't approved yet, keep polling |
| `slow_down` | Polling too fast, increase interval by 5 seconds |
| `expired_token` | Device code expired |
| `access_denied` | User denied the request |

### User Code Format

RFC recommends:
- Case-insensitive comparison
- Group of characters separated by hyphens for readability
- Exclude ambiguous characters (0/O, 1/I/l)
- Example: `WDJB-MJHT` (8 chars, two groups of 4)
- Minimum 20 bits of entropy (RFC minimum), but 30+ bits recommended

**GitHub CLI uses:** 4+4 alphanumeric (e.g., `ABCD-1234`)
**Google uses:** Letters only, no digits, to avoid 0/O confusion

### Security Best Practices

- **Rate limiting on polling:** Enforce `interval` (typically 5s), return `slow_down` if violated
- **Short expiry:** 10-15 minutes maximum for device codes
- **One-time use:** Device code consumed on approval, cannot be replayed
- **User code brute force:** Rate limit verification attempts per IP
- **HTTPS required:** All endpoints must use TLS
- **No user code in URL by default:** `verification_uri_complete` is optional (some implementations include it for QR codes)

### Practical Implementation Notes

**GitHub CLI pattern:**
1. `gh auth login` initiates flow
2. Opens browser to `https://github.com/login/device`
3. Displays 8-char code in terminal
4. Polls every 5 seconds
5. On success, stores OAuth token in `~/.config/gh/hosts.yml`

**Polling strategy:**
- Start at `interval` seconds (typically 5)
- On `slow_down`, increase by 5 seconds
- On `authorization_pending`, continue at current interval
- Stop on `expired_token` or `access_denied`
- Display spinner/status in terminal during polling

**Browser opening (Node.js):**
- `open` npm package — cross-platform (macOS `open`, Linux `xdg-open`, Windows `start`)
- Fallback: display URL for manual copy-paste
- Detect non-interactive terminal (no TTY) and skip browser opening

---

## Testing Infrastructure Notes

### Test Patterns for Device Code Flow

**Unit tests (no Supabase needed):**
- Device code generation: entropy, format, uniqueness
- User code generation: format, charset, uniqueness
- Status transitions: state machine correctness
- Rate limiting: interval enforcement logic
- Expiry: time-based validation

**Integration tests (real Supabase):**
- Full flow: initiate → approve → poll → exchange
- Requires:
  - Test user (via `createTestUser()`)
  - Service role key (for `admin.generateLink()` in approve endpoint)
  - Web app running (for API route testing)
- Pattern: Direct HTTP calls to API routes (no browser needed)
  - `fetch('http://localhost:3000/api/auth/device', { method: 'POST' })`
  - Simulate approval via direct API call with authenticated session

**CLI tests:**
- Mock the browser-opening step
- Mock the HTTP calls to API endpoints
- Test the polling loop logic
- Test credential storage after successful auth
