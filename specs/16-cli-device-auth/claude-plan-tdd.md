# TDD Plan: CLI Device Code Auth

Mirrors the structure of `claude-plan.md`. For each section, defines the tests to write BEFORE implementing.

**Testing stack:** Vitest with two projects (`unit` and `integration`). Unit tests use `vi.stubEnv()` and mocks. Integration tests use real local Supabase via `createTestUser()` from `__tests__/integration/setup.ts`.

---

## Database: `device_codes` Table

### Unit Tests (migration validation)

- Test: migration SQL is valid (parse check, no syntax errors)
- Test: `device_codes` table has expected columns after migration
- Test: partial unique index on `user_code WHERE status = 'pending'` prevents duplicate pending codes
- Test: `get_device_code_status()` RPC function returns only `status`, `token_hash`, `email`, `expires_at`
- Test: `get_device_code_status()` returns null for non-existent device_code
- Test: anon role can INSERT into device_codes
- Test: anon role CANNOT directly SELECT from device_codes (reads go through RPC)
- Test: service role can UPDATE device_codes

---

## Server-Side Helpers (device code generation)

### Unit Tests

**User code generation:**
- Test: generates 8-character code in `XXXX-XXXX` format
- Test: all characters are from safe charset (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`)
- Test: no ambiguous characters (0, O, 1, I, l)
- Test: generates unique codes across 100 invocations (statistical uniqueness)

**Device code generation:**
- Test: generates 64-character hex string
- Test: uses cryptographically random bytes (verify length of underlying buffer)

---

## API Route: Initiate (`POST /api/auth/device`)

### Unit Tests

- Test: returns 201 with `device_code`, `user_code`, `verification_url`, `expires_at`, `interval`
- Test: `device_code` is 64-char hex
- Test: `user_code` matches `XXXX-XXXX` format
- Test: `verification_url` contains the user_code as query parameter
- Test: `expires_at` is ~10 minutes in the future
- Test: `interval` is 5
- Test: accepts optional `device_name` in body
- Test: retries user_code generation on collision (mock the insert to fail once, succeed on retry)

### Integration Tests

- Test: calling the endpoint creates a row in `device_codes` with status `pending`
- Test: expired rows older than 1 hour are cleaned up on new insert

---

## API Route: Poll (`POST /api/auth/device/token`)

### Unit Tests

- Test: returns `{ status: "pending" }` for pending device code
- Test: returns `{ status: "approved", token_hash, email }` for approved code
- Test: returns `{ status: "expired" }` for expired code
- Test: returns 404 for unknown device code
- Test: after returning `approved`, token_hash is nulled (status becomes `consumed`)
- Test: subsequent poll after consumption returns `{ status: "consumed" }` without token_hash

### Integration Tests

- Test: create pending code → poll → get pending status
- Test: create and approve code → poll → get approved with token_hash → poll again → consumed (no token_hash)
- Test: create code → wait past expiry → poll → get expired

---

## API Route: Approve (`POST /api/auth/device/approve`)

### Unit Tests

- Test: returns 401 if user is not authenticated
- Test: returns 404 if user_code doesn't exist or is expired
- Test: returns 200 with `{ success: true }` on valid approval
- Test: updates device_code row with `status: 'approved'`, `user_id`, `email`, `token_hash`
- Test: calls `admin.generateLink({ type: 'magiclink', email })` and extracts `data.properties.hashed_token`

### Integration Tests

- Test: full approval flow with real authenticated user and real Supabase admin client
- Test: approving an already-approved code returns 404 (status is no longer `pending`)
- Test: approving an expired code returns 404

---

## Web UI: `/auth/device` Page

### Unit Tests (component tests)

- Test: renders code input form
- Test: pre-fills code from URL query parameter `?code=ABCD-1234`
- Test: shows input field when no code in URL
- Test: shows success message after successful approval
- Test: shows error message on invalid/expired code
- Test: shows loading state while submitting
- Test: calls `POST /api/auth/device/approve` with correct body

---

## CLI: `login()` in cli-auth.ts

### Unit Tests

- Test: calls `POST /api/auth/device` and receives device_code + user_code
- Test: calls `openBrowser()` with verification_url
- Test: prints user_code to stderr
- Test: prints "Waiting for browser approval" to stderr
- Test: polls `POST /api/auth/device/token` every `interval` seconds
- Test: on approved response, calls `verifyOtp({ token_hash, type: 'magiclink' })`
- Test: saves credentials via `saveCredentials()` on success
- Test: throws on expired response
- Test: throws on denied response
- Test: stops polling when client-side timeout reached (expires_at passed)
- Test: stores device_name in credentials

**openBrowser():**
- Test: calls `open` on macOS (mock `process.platform = 'darwin'`)
- Test: calls `xdg-open` on Linux (mock `process.platform = 'linux'`)
- Test: calls `start` on Windows (mock `process.platform = 'win32'`)
- Test: does not throw if exec fails (prints URL as fallback)

---

## CLI: `smgr.ts` Updates

### Unit Tests

- Test: `smgr login` calls `login()` with no arguments
- Test: `smgr login` prints `Logged in as <email>` on success
- Test: usage text does not mention `[email] [password]`

---

## Integration: Full Flow

### Integration Tests

- Test: complete device code auth flow end-to-end
  1. `POST /api/auth/device` → get device_code + user_code
  2. Sign in as test user via `createTestUser()`
  3. `POST /api/auth/device/approve` with authenticated session + user_code
  4. `POST /api/auth/device/token` with device_code → get token_hash + email
  5. `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })` → valid session
  6. Verify session has correct user email

- Test: expired code flow
  1. Create device code with very short expiry (mock or DB override)
  2. Wait past expiry
  3. Poll → get `expired` status
  4. Approve → get 404

- Test: invalid user_code
  1. `POST /api/auth/device/approve` with non-existent code → 404

- Test: unauthenticated approve
  1. `POST /api/auth/device/approve` without session → 401
