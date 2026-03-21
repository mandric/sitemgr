# Section 2: Auth Helper and Auth Endpoints

## Context

The CLI is being decoupled from direct Supabase access. Instead of importing `db.ts` (which drags in `cli-auth.ts` and Node-native modules), the CLI will authenticate via HTTP endpoints on the Next.js web app and receive JWTs it can use as Bearer tokens on subsequent API calls.

This section creates three things:
1. A **reusable auth helper** (`requireAuth`) that API route handlers call to extract and validate the caller's identity from a Bearer token. Every data endpoint in Section 3 will depend on this helper.
2. A **login endpoint** (`POST /api/auth/login`) that accepts email/password and returns Supabase session tokens.
3. A **refresh endpoint** (`POST /api/auth/refresh`) that exchanges a refresh token for a new access token, handling Supabase's 1-hour JWT expiry.

### Why this is separate from the existing Supabase server client

The existing `web/lib/supabase/server.ts` creates a cookie-based server client for the Next.js web UI (SSR pages, server components). It uses `cookies()` from `next/headers` and is designed for browser sessions.

The auth helper in this section serves a different purpose: it validates **Bearer tokens sent by the CLI** (or any HTTP client). It does not read cookies. It creates a Supabase client configured with the token from the `Authorization` header, then calls `supabase.auth.getUser()` to validate the JWT server-side. These are two separate auth paths that coexist.

### Depends on

- Section 1 (db.ts refactored, barrel export deleted) -- but this section only touches new files, so it can be implemented in parallel with Sections 5 and 7 after Section 1 lands.

### Blocks

- Section 3 (all data API endpoints import `requireAuth` from this helper).

---

## Files to Create

### 1. `web/lib/api/auth.ts` -- Auth helper

This is the core deliverable. A single exported async function:

```typescript
export async function requireAuth(
  request: NextRequest
): Promise<{ userId: string } | NextResponse>
```

**Implementation steps:**

1. Read the `Authorization` header from `request.headers`.
2. If missing or not in the form `Bearer <token>`, return `NextResponse.json({ error: "Unauthorized" }, { status: 401 })`.
3. Create a Supabase client using `createServerClient` from `@supabase/ssr` with `process.env.NEXT_PUBLIC_SUPABASE_URL` and `process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. For the cookies adapter, provide no-op `getAll`/`setAll` implementations (the client only needs the token, not cookies). Override the `Authorization` header globally so the client uses the Bearer token from the request.
4. Call `supabase.auth.getUser()`. This makes a server-side call to Supabase Auth to validate the JWT and retrieve the user record.
5. If `error` or no `user`, return 401 `NextResponse`.
6. Return `{ userId: user.id }`.

**Key design choice:** The return type is a discriminated union -- callers check `if (result instanceof NextResponse)` to detect auth failure and can return it directly from the route handler. This avoids thrown exceptions for a normal control-flow case (unauthenticated request).

**Imports:** `NextRequest`, `NextResponse` from `next/server`; `createServerClient` from `@supabase/ssr`.

### 2. `web/app/api/auth/login/route.ts` -- Login endpoint

Exports a single `POST` handler.

```typescript
export async function POST(request: NextRequest): Promise<NextResponse>
```

**Implementation steps:**

1. Parse JSON body. If `email` or `password` is missing, return 400 with `{ error: "Email and password are required" }`.
2. Create a Supabase client using `createServerClient` from `@supabase/ssr` with `process.env.NEXT_PUBLIC_SUPABASE_URL` and `process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Use no-op cookie adapters (no browser session needed).
3. Call `supabase.auth.signInWithPassword({ email, password })`.
4. If `error`, return 401 with `{ error: "Invalid credentials" }`.
5. On success, return 200 with:
   - `access_token`: `session.access_token`
   - `refresh_token`: `session.refresh_token`
   - `user_id`: `user.id`
   - `email`: `user.email`
   - `expires_at`: `session.expires_at`

**No GET handler is exported.** Next.js will return 405 automatically for unsupported methods on route handlers.

### 3. `web/app/api/auth/refresh/route.ts` -- Refresh endpoint

Exports a single `POST` handler.

```typescript
export async function POST(request: NextRequest): Promise<NextResponse>
```

**Implementation steps:**

1. Parse JSON body. If `refresh_token` is missing, return 400 with `{ error: "refresh_token is required" }`.
2. Create a Supabase client (same pattern as login: `createServerClient` with no-op cookies).
3. Call `supabase.auth.refreshSession({ refresh_token })`.
4. If `error` or no `session`, return 401 with `{ error: "Token refresh failed" }`.
5. On success, return 200 with the same shape as the login response (`access_token`, `refresh_token`, `user_id`, `email`, `expires_at`).

---

## Shared Pattern: No-op Cookie Supabase Client

Both the login and refresh endpoints (and `requireAuth`) need a Supabase client that does not interact with browser cookies. Extract a small internal helper (not exported from `lib/api/auth.ts`, or colocated in a private module):

```typescript
function createStatelessClient(authHeader?: string): SupabaseClient
```

This calls `createServerClient(url, anonKey, { cookies: { getAll: () => [], setAll: () => {} }, global: { headers } })`. When `authHeader` is provided, it sets `Authorization` in the global headers so the client acts on behalf of that token's user.

This avoids duplicating the `createServerClient` + no-op cookie boilerplate across three call sites.

---

## TDD Test Stubs

All tests go in `web/__tests__/api/auth.test.ts`. Use Vitest. Mock `@supabase/ssr` at the module level with `vi.mock()`.

### requireAuth tests

```
describe("requireAuth", () => {
  it("returns { userId } when valid Bearer token is provided")
  it("returns 401 NextResponse when Authorization header is missing")
  it("returns 401 NextResponse when Authorization header uses Basic instead of Bearer")
  it("returns 401 NextResponse when Bearer token is empty string")
  it("returns 401 NextResponse when token is expired (auth.getUser returns error)")
  it("returns 401 NextResponse when auth.getUser returns no user (deleted account)")
})
```

**Mock strategy:** Mock `createServerClient` from `@supabase/ssr` to return a fake client with `auth.getUser()` that resolves to either `{ data: { user: { id: "test-user-id" } }, error: null }` or `{ data: { user: null }, error: { message: "..." } }`. Create `NextRequest` objects with appropriate headers using `new NextRequest("http://localhost/api/test", { headers: { Authorization: "Bearer valid-token" } })`.

### Login endpoint tests

```
describe("POST /api/auth/login", () => {
  it("returns 200 with session data on valid email/password")
  it("returns 401 with error message on invalid credentials")
  it("returns 400 when email is missing from body")
  it("returns 400 when password is missing from body")
  it("returns 400 when body is empty or malformed JSON")
})
```

**Mock strategy:** Mock `createServerClient` so that `auth.signInWithPassword` returns either a valid session object or an error. Call the `POST` function directly (import it from the route module), passing a `NextRequest` with the appropriate JSON body.

### Refresh endpoint tests

```
describe("POST /api/auth/refresh", () => {
  it("returns 200 with new session on valid refresh_token")
  it("returns 401 when refresh_token is expired or invalid")
  it("returns 400 when refresh_token is missing from body")
  it("returns 400 when body is empty or malformed JSON")
})
```

**Mock strategy:** Same as login -- mock `createServerClient` so `auth.refreshSession` returns either a valid session or an error.

### Test fixture values

Use `vi.stubEnv()` for Supabase URL and anon key per CLAUDE.md testing pattern:

```typescript
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
});
```

---

## Verification Steps

After implementing and before moving to Section 3:

1. **Run the auth tests:**
   ```
   cd web && npx vitest run __tests__/api/auth.test.ts
   ```
   All tests must pass.

2. **Run the full test suite:**
   ```
   cd web && npm test
   ```
   Ensure no regressions. The auth helper and endpoints are new files, so existing tests should be unaffected.

3. **Type check:**
   ```
   cd web && npx tsc --noEmit
   ```
   No type errors in the new files or anywhere else.

4. **Manual smoke test (optional, requires local Supabase running):**
   ```bash
   # Start local Supabase and dev server
   supabase start
   npm run dev

   # Test login (use a seeded test user)
   curl -s -X POST http://localhost:3000/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"test-password"}' | jq .

   # Test refresh (use the refresh_token from login response)
   curl -s -X POST http://localhost:3000/api/auth/refresh \
     -H "Content-Type: application/json" \
     -d '{"refresh_token":"<token-from-above>"}' | jq .

   # Test requireAuth via health (once Section 5 adds auth, or any future Section 3 endpoint)
   curl -s http://localhost:3000/api/auth/login ... # get access_token
   # (requireAuth itself is tested via unit tests; endpoint integration tests come in Section 3)
   ```

5. **Verify file structure:**
   ```
   web/lib/api/auth.ts           # exists, exports requireAuth
   web/app/api/auth/login/route.ts    # exists, exports POST
   web/app/api/auth/refresh/route.ts  # exists, exports POST
   web/__tests__/api/auth.test.ts     # exists, all tests green
   ```
