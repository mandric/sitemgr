That file doesn't exist yet (it's in section-02). Now I have enough context to write the section.

# Section 07: CLI Refactor -- Device Code Auth Flow

## Overview

This section replaces the interactive email/password `login()` function in `web/lib/auth/cli-auth.ts` with a browser-based device code authorization flow. It also updates `web/bin/smgr.ts` to remove email/password arguments from the `login` command and update usage text.

**Dependencies:**
- Section 02 (server helpers): Provides `generateDeviceCode()` and `generateUserCode()` in `web/lib/auth/device-codes.ts` -- but the CLI does not call these directly; it calls the API routes instead.
- Section 03 (API initiate): `POST /api/auth/device` must be implemented and working.
- Section 04 (API poll): `POST /api/auth/device/token` must be implemented and working.

## Files to Modify

1. **`/home/user/sitemgr/web/lib/auth/cli-auth.ts`** -- Replace `login()`, remove `prompt()` and `promptPassword()`, add `openBrowser()`.
2. **`/home/user/sitemgr/web/bin/smgr.ts`** -- Update `cmdLogin()`, usage text, and commands map.
3. **`/home/user/sitemgr/web/__tests__/unit/cli-auth-device-flow.test.ts`** -- New unit tests for the device code login flow.
4. **`/home/user/sitemgr/web/__tests__/unit/cli-open-browser.test.ts`** -- New unit tests for cross-platform browser opening.
5. **`/home/user/sitemgr/web/__tests__/unit/smgr-login-command.test.ts`** -- New unit tests for the updated smgr login command.

## Tests (Write First)

### Test File: `web/__tests__/unit/cli-auth-device-flow.test.ts`

Tests for the refactored `login()` function in `cli-auth.ts`. All HTTP calls are mocked via `vi.fn()` -- no real network requests.

**Test cases:**

1. **calls `POST /api/auth/device` and receives device_code + user_code** -- Mock `fetch` to return a 201 response with `{ device_code, user_code, verification_url, expires_at, interval }`. Verify `login()` makes this request with the correct URL and body.

2. **calls `openBrowser()` with verification_url** -- Mock `openBrowser` (or `child_process.exec`) and verify it receives the `verification_url` from the initiate response.

3. **prints user_code to stderr** -- Spy on `process.stderr.write` or `console.error` and verify the user code appears in output.

4. **prints "Waiting for browser approval" to stderr** -- Same stderr spy, verify the waiting message appears.

5. **polls `POST /api/auth/device/token` every `interval` seconds** -- Mock fetch to return `{ status: "pending" }` twice, then `{ status: "approved", token_hash: "hash123", email: "user@test.com" }`. Use fake timers (`vi.useFakeTimers()`) to advance time by the interval. Verify fetch was called the expected number of times with the correct device_code body.

6. **on approved response, calls `verifyOtp({ token_hash, type: 'magiclink' })`** -- Mock the Supabase client's `auth.verifyOtp` method. After the poll returns `approved`, verify `verifyOtp` is called with `{ token_hash: "hash123", type: "magiclink" }`.

7. **saves credentials via `saveCredentials()` on success** -- After `verifyOtp` returns a session, verify `saveCredentials()` is called with the correct `StoredCredentials` shape including `access_token`, `refresh_token`, `user_id`, `email`, and `expires_at`.

8. **throws on expired response** -- Mock poll to return `{ status: "expired" }`. Verify `login()` rejects with an error containing "expired".

9. **throws on denied response** -- Mock poll to return `{ status: "denied" }`. Verify `login()` rejects with an error containing "denied".

10. **stops polling when client-side timeout reached (expires_at passed)** -- Set `expires_at` to a time in the past (or use fake timers to advance past it). Verify `login()` stops polling and throws a timeout/expiry error without making additional fetch calls.

11. **stores device_name in credentials** -- Verify the optional `device_name` field is included in the initiate request body (defaults to `os.hostname()`).

**Key mocking strategy:**

- Mock `global.fetch` for all HTTP calls to the API routes.
- Mock `child_process.exec` for browser opening.
- Mock `@supabase/supabase-js` `createClient` to return a mock client with `auth.verifyOtp`.
- Use `vi.useFakeTimers()` for polling interval tests.
- Spy on `process.stderr.write` for output verification.

```typescript
// Skeleton structure for the test file
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process.exec for openBrowser
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// Mock @supabase/supabase-js
const mockVerifyOtp = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { verifyOtp: mockVerifyOtp },
  })),
}));

describe("login() device code flow", () => {
  beforeEach(() => {
    vi.stubEnv("SMGR_API_URL", "http://localhost:3000");
    vi.stubEnv("SMGR_API_KEY", "test-anon-key");
    vi.useFakeTimers();
    // Setup fetch mock, stderr spy, etc.
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // Test stubs as described above
  it("calls POST /api/auth/device and receives device_code + user_code", async () => { /* ... */ });
  it("calls openBrowser() with verification_url", async () => { /* ... */ });
  it("prints user_code to stderr", async () => { /* ... */ });
  it("polls POST /api/auth/device/token every interval seconds", async () => { /* ... */ });
  it("on approved, calls verifyOtp with token_hash and type magiclink", async () => { /* ... */ });
  it("saves credentials on success", async () => { /* ... */ });
  it("throws on expired response", async () => { /* ... */ });
  it("throws on denied response", async () => { /* ... */ });
  it("stops polling when expires_at has passed", async () => { /* ... */ });
  it("sends device_name in initiate request body", async () => { /* ... */ });
});
```

### Test File: `web/__tests__/unit/cli-open-browser.test.ts`

Tests for the `openBrowser()` function. Mock `child_process.exec` and `process.platform`.

**Test cases:**

1. **calls `open` on macOS** -- Set `process.platform` to `'darwin'` via `Object.defineProperty`. Verify `exec` is called with a command starting with `open `.

2. **calls `xdg-open` on Linux** -- Set `process.platform` to `'linux'`. Verify `exec` is called with `xdg-open `.

3. **calls `start` on Windows** -- Set `process.platform` to `'win32'`. Verify `exec` is called with `start `.

4. **does not throw if exec fails (prints URL as fallback)** -- Make `exec` call its callback with an error. Verify `openBrowser` does not throw and that the URL is printed to stderr as a fallback message.

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { exec } from "node:child_process";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

describe("openBrowser()", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("calls 'open' on macOS", () => { /* ... */ });
  it("calls 'xdg-open' on Linux", () => { /* ... */ });
  it("calls 'start' on Windows", () => { /* ... */ });
  it("prints URL to stderr if exec fails", () => { /* ... */ });
});
```

### Test File: `web/__tests__/unit/smgr-login-command.test.ts`

Tests for the updated `smgr.ts` login command.

**Test cases:**

1. **`smgr login` calls `login()` with no arguments** -- Verify the `login` import is called without email/password args.

2. **`smgr login` prints `Logged in as <email>` on success** -- Verify console output format.

3. **usage text does not mention `[email] [password]`** -- Read `smgr.ts` source and verify the usage string no longer contains `[email] [password]`.

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("smgr.ts login command", () => {
  it("usage text does not mention [email] [password]", () => {
    const source = readFileSync(
      "/home/user/sitemgr/web/bin/smgr.ts",
      "utf-8"
    );
    expect(source).not.toContain("[email] [password]");
  });

  it("cmdLogin does not pass args to login()", () => {
    const source = readFileSync(
      "/home/user/sitemgr/web/bin/smgr.ts",
      "utf-8"
    );
    // Should call login() with no arguments (or just deviceName)
    expect(source).not.toMatch(/login\(email/);
    expect(source).not.toMatch(/login\(password/);
  });
});
```

## Implementation Details

### Changes to `web/lib/auth/cli-auth.ts`

#### Remove

- Delete `prompt()` function (lines 58-66 in current file)
- Delete `promptPassword()` function (lines 68-95 in current file)
- Remove the `createInterface` import from `node:readline`
- Remove `emailArg` and `passwordArg` parameters from `login()`

#### Add: `openBrowser(url: string): void`

A new exported function for cross-platform browser opening. Uses `child_process.exec` with platform detection:

```typescript
import { exec } from "node:child_process";
import { hostname } from "node:os";
```

Logic:
- Check `process.platform`:
  - `'darwin'` -> `exec("open <url>")`
  - `'win32'` -> `exec("start <url>")`
  - default (Linux) -> `exec("xdg-open <url>")`
- Wrap in try/catch. If exec fails, print to stderr: `"Could not open browser. Visit this URL manually:\n  <url>"`
- This function is fire-and-forget -- it does not need to await the browser process.

#### Add: Updated `StoredCredentials` interface

Add an optional `device_name` field:

```typescript
export interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email: string;
  expires_at: number;
  device_name?: string; // NEW - optional device identifier
}
```

#### Replace: `login()` function

New signature:

```typescript
export async function login(deviceName?: string): Promise<StoredCredentials>
```

The new implementation follows this flow:

1. **Resolve API config**: Call `resolveApiConfig()` to get `url` and `anonKey`.

2. **Initiate**: `POST {url}/api/auth/device` with body `{ device_name: deviceName ?? hostname() }`. Expect 201 response with `{ device_code, user_code, verification_url, expires_at, interval }`.

3. **Open browser**: Call `openBrowser(verification_url)`.

4. **Print instructions to stderr**:
   - `"Opening browser... Enter this code if prompted: ABCD-1234"`
   - `"Waiting for browser approval. Press Ctrl+C to cancel."`

5. **Poll loop**: Repeatedly `POST {url}/api/auth/device/token` with body `{ device_code }`:
   - Before each poll, check `Date.now() > new Date(expires_at).getTime()`. If expired, throw an error telling the user to retry.
   - Use `await new Promise(r => setTimeout(r, interval * 1000))` between polls.
   - On `{ status: "pending" }` -> continue polling.
   - On `{ status: "expired" }` -> throw error "Device code expired. Please retry."
   - On `{ status: "denied" }` -> throw error "Device authorization denied."
   - On `{ status: "approved", token_hash, email }` -> proceed to step 6.

6. **Verify OTP**: Create a Supabase client with `createClient(url, anonKey)` and call `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })`. This converts the magic link hash into a full session (access_token + refresh_token). This works on an anon-key client with no prior session -- same pattern as `web/app/auth/confirm/route.ts`.

7. **Save credentials**: Build `StoredCredentials` from the session and call `saveCredentials()`:
   ```typescript
   const creds: StoredCredentials = {
     access_token: session.access_token,
     refresh_token: session.refresh_token,
     user_id: session.user.id,
     email: session.user.email ?? email,
     expires_at: session.expires_at ?? 0,
     device_name: deviceName ?? hostname(),
   };
   ```

8. **Return** the credentials.

#### Keep Unchanged

These functions remain exactly as they are:
- `loadCredentials()`
- `saveCredentials()` (internal, already handles the `StoredCredentials` shape -- the new optional `device_name` field serializes naturally via JSON.stringify)
- `clearCredentials()`
- `refreshSession()`
- `resolveApiConfig()`
- `whoami()`

### Changes to `web/bin/smgr.ts`

#### Update `cmdLogin()`

Remove the `args` parameter. No longer accepts email/password from the command line.

```typescript
async function cmdLogin() {
  try {
    const creds = await login();
    console.log(`Logged in as ${creds.email} (${creds.user_id})`);
  } catch (err) {
    cliError(`Login failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
  }
}
```

#### Update commands map

Change from:
```typescript
login: cmdLogin,
```
To:
```typescript
login: () => cmdLogin(),
```

This is necessary because `cmdLogin` no longer takes `args`.

#### Update usage text

Change:
```
smgr login [email] [password]  Authenticate with email/password
```
To:
```
smgr login                    Authenticate via browser (device code flow)
```

Also update the Authentication section of usage text:
```
Authentication:
  Run 'smgr login' to authenticate. A browser window will open for you to approve
  the device. Credentials are stored in ~/.sitemgr/credentials.json.
```

### Update Existing Test: `web/__tests__/smgr-cli-auth.test.ts`

The existing test file at `/home/user/sitemgr/web/__tests__/smgr-cli-auth.test.ts` reads source code to verify properties of `smgr.ts`. After this refactor:
- The test checking that `login` is imported still passes (the import name doesn't change).
- The test checking that no admin client or service role key is used still passes.
- No changes needed to this existing test file.

## Important Notes

- The `fetch` calls in `login()` should use the global `fetch` (available in Node 18+). No need to import a fetch library.
- All user-facing messages go to `stderr` (not `stdout`), matching the existing CLI convention. Only the final "Logged in as..." success message goes to `stdout` (via `console.log` in `cmdLogin`).
- The polling uses a simple `setTimeout`-based loop, not `setInterval`. This avoids overlapping requests if the server is slow.
- The `saveCredentials` function is not exported in the current code (it's module-private). The tests for "saves credentials" should verify indirectly -- either by mocking `writeFileSync` or by checking `loadCredentials()` after `login()` completes in a test with a mocked HOME directory.