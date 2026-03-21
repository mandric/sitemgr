# Section 6: Rewrite smgr.ts (CLI) as HTTP Client

## Overview

The CLI (`web/bin/smgr.ts`) currently imports data functions directly from `db.ts` and talks to Supabase Postgres. After this section, the CLI becomes a pure HTTP client that calls the web API endpoints created in Sections 3 and 4. All Supabase imports are removed from the CLI. Authentication switches from direct Supabase Auth to the `/api/auth/login` and `/api/auth/refresh` endpoints via `SmgrApiClient`.

The companion module `lib/auth/cli-auth.ts` is trimmed: functions that called Supabase directly (`login()`, `refreshSession()`, `resolveApiConfig()`) are deleted. Credential storage functions (`loadCredentials`, `saveCredentials`, `clearCredentials`, `whoami`) and prompt helpers are kept -- they deal with local files, not Supabase.

## Dependencies

- **section-03-api-endpoints** must be complete (the API routes the CLI will call).
- **section-04-api-client** must be complete (`SmgrApiClient` class the CLI will use).
- **section-01-refactor-db** must be complete (barrel export deleted, db.ts parameterized).

## What This Section Blocks

- **section-08-cleanup** depends on this section completing.

## Files Involved

| File | Action |
|------|--------|
| `/home/user/sitemgr/web/bin/smgr.ts` | Modify (major rewrite) |
| `/home/user/sitemgr/web/lib/auth/cli-auth.ts` | Modify (delete functions, keep credential storage) |
| `/home/user/sitemgr/web/__tests__/smgr-cli.test.ts` | Modify (rewrite tests) |
| `/home/user/sitemgr/web/__tests__/cli-auth.test.ts` | Modify or create (test trimmed module) |

## Current State

### `web/bin/smgr.ts`

Lines 18-29 import ten data functions from `../lib/media/db`:
- `queryEvents`, `showEvent`, `getStats`, `getEnrichStatus`, `getPendingEnrichments`, `insertEvent`, `insertEnrichment`, `upsertWatchedKey`, `getWatchedKeys`, `findEventByHash`

Line 41 imports `getModelConfig` from `../lib/media/db`.

Line 45 imports `login`, `clearCredentials`, `loadCredentials` from `../lib/auth/cli-auth`.

Each CLI command handler calls these db functions directly, constructs Supabase clients internally, and reads `SMGR_API_URL` / `SMGR_API_KEY` as Supabase connection details.

### `web/lib/auth/cli-auth.ts`

Contains:
- **Keep:** `StoredCredentials` interface, `loadCredentials()`, `saveCredentials()`, `clearCredentials()`, `ensureConfigDir()`, `prompt()`, `promptPassword()`, `whoami()`
- **Delete:** `resolveApiConfig()` (reads `SMGR_API_URL`/`SMGR_API_KEY` for Supabase), `login()` (calls Supabase `signInWithPassword` directly), `refreshSession()` (calls Supabase `refreshSession` directly)
- **Delete import:** `createClient` from `@supabase/supabase-js` (no longer needed)

## Changes

### 1. Trim `lib/auth/cli-auth.ts`

Remove these exports and their implementations:

- `resolveApiConfig()` -- replaced by `SMGR_API_URL` pointing at the web app
- `login()` -- replaced by `SmgrApiClient.login()` in the CLI
- `refreshSession()` -- replaced by `SmgrApiClient.refresh()` / auto-refresh

Remove the import of `createClient` from `@supabase/supabase-js` at the top of the file.

Export `saveCredentials` (currently not exported) so the CLI can save credentials after calling `api.login()`.

Keep all other functions and types unchanged:
- `StoredCredentials` (interface)
- `loadCredentials()`
- `clearCredentials()`
- `ensureConfigDir()`
- `prompt()` -- export this (currently private) so smgr.ts can use it for login prompts
- `promptPassword()` -- export this (currently private) so smgr.ts can use it for login prompts
- `whoami()`

### 2. Rewrite `bin/smgr.ts` imports

**Remove these imports:**
```typescript
// DELETE: all db.ts imports
import { queryEvents, showEvent, getStats, ... } from "../lib/media/db";
import { getModelConfig } from "../lib/media/db";

// DELETE: login from cli-auth (function is being deleted)
import { login, clearCredentials, loadCredentials } from "../lib/auth/cli-auth";
```

**Add these imports:**
```typescript
import { SmgrApiClient } from "../lib/api/client";
import { loadCredentials, saveCredentials, clearCredentials, prompt, promptPassword } from "../lib/auth/cli-auth";
```

Imports for `s3`, `utils`, `enrichment`, `logger`, `request-context`, and `s3-errors` are unchanged -- they are not part of the db.ts decoupling.

### 3. Rewrite CLI initialization

Replace the current initialization (which resolves Supabase config) with API client setup:

```typescript
const baseUrl = process.env.SMGR_API_URL || "https://sitemgr.vercel.app";
const creds = loadCredentials();
const api = new SmgrApiClient(baseUrl, {
  token: creds?.access_token,
  refreshToken: creds?.refresh_token,
});
```

### 4. Rewrite command handlers

Each command handler replaces direct db.ts calls with `SmgrApiClient` method calls. The command parsing (`parseArgs`), output formatting, and error handling structure remain the same -- only the data access layer changes.

**login command:**

Before: calls `login()` from cli-auth (which calls Supabase directly).
After: prompts for email/password using `prompt()` and `promptPassword()`, calls `api.login(email, password)`, then calls `saveCredentials()` with the result.

```typescript
// Pseudocode
const email = await prompt("Email: ");
const password = await promptPassword("Password: ");
const result = await api.login(email, password);
saveCredentials({
  access_token: result.access_token,
  refresh_token: result.refresh_token,
  user_id: result.user_id,
  email: result.email,
  expires_at: result.expires_at,
});
```

**logout command:** unchanged (`clearCredentials()` is local-only).

**whoami command:** unchanged (`loadCredentials()` is local-only).

**query command:**

Before: `queryEvents({ search, type, since, until, limit, offset, userId })`
After: `api.query({ search, type, since, until, limit, offset })`

Note: `userId` is no longer passed -- the JWT identifies the user server-side.

**show command:**

Before: `showEvent(id, userId)`
After: `api.show(id)`

**stats command:**

Before: `getStats(userId)` and optionally `getEnrichStatus(userId)`
After: `api.stats()` (the API endpoint handles combining stats and enrich status)

**add command:**

Before: `insertEvent({ ...event, user_id: userId })`
After: `api.add({ ...event })` (API sets user_id from JWT)

**enrich command:**

Before: `getPendingEnrichments(userId)` and `insertEnrichment(client, eventId, result, userId)`
After: `api.getPendingEnrichments()` and `api.insertEnrichment(eventId, result)`

Note: The enrich command also does S3 downloads and calls `enrichImage()` locally. Those parts are unchanged -- only the db reads/writes switch to HTTP.

**watch command:**

Before: `getWatchedKeys(userId)` and `upsertWatchedKey(client, ...)`
After: `api.getWatchedKeys()` and `api.upsertWatchedKey(...)`

Note: The watch command also does S3 operations (`listS3Objects`, `downloadS3Object`). Those parts are unchanged.

**find-by-hash (internal helper):**

Before: `findEventByHash(hash, userId)`
After: `api.findEventByHash(hash)`

**model-config (internal helper):**

Before: `getModelConfig(client, userId, provider)`
After: `api.getModelConfig(provider)`

### 5. Error handling in command handlers

All `SmgrApiClient` methods throw `ApiError` on non-2xx responses. The existing `cliError()` helper handles errors with exit codes. Wrap API calls in try/catch:

```typescript
try {
  const result = await api.query(opts);
  // format and print result
} catch (err) {
  if (err instanceof ApiError) {
    if (err.status === 401) cliError("Not authenticated. Run: smgr login", EXIT.USER);
    cliError(err.message, EXIT.SERVICE, err.details);
  }
  throw err;
}
```

### 6. Environment variable changes

| Env Var | Before | After |
|---------|--------|-------|
| `SMGR_API_URL` | Supabase project URL | Web app URL (e.g., `http://localhost:3000`) |
| `SMGR_API_KEY` | Supabase anon key | **Deleted** -- no longer needed |
| `SUPABASE_SECRET_KEY` | Used by CLI for admin ops | **Deleted from CLI** -- only web API uses service role key |

## TDD Test Stubs

### `__tests__/cli-auth.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("cli-auth (trimmed)", () => {
  it("does not export resolveApiConfig", async () => {
    // Import cli-auth and assert resolveApiConfig is not in exports
  });

  it("does not export refreshSession", async () => {
    // Import cli-auth and assert refreshSession is not in exports
  });

  it("does not export login", async () => {
    // Import cli-auth and assert login is not in exports
  });

  it("does not import from @supabase/supabase-js", async () => {
    // Read the file content and assert no @supabase/supabase-js import
    // (or grep the built output)
  });

  it("exports loadCredentials that reads from ~/.sitemgr/credentials.json", () => {
    // Mock fs.readFileSync, call loadCredentials, assert correct path
  });

  it("exports saveCredentials that writes with 0600 permissions", () => {
    // Mock fs.writeFileSync, call saveCredentials, assert mode: 0o600
  });

  it("exports clearCredentials that removes credentials file", () => {
    // Mock fs.unlinkSync, call clearCredentials, assert correct path
  });

  it("exports prompt helper", async () => {
    // Assert prompt is exported and is a function
  });

  it("exports promptPassword helper", async () => {
    // Assert promptPassword is exported and is a function
  });
});
```

### `__tests__/smgr-cli.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// These tests mock SmgrApiClient and verify the CLI wiring.
// For full integration tests, use a running dev server.

vi.mock("../lib/api/client", () => ({
  SmgrApiClient: vi.fn().mockImplementation(() => ({
    login: vi.fn(),
    query: vi.fn(),
    show: vi.fn(),
    add: vi.fn(),
    stats: vi.fn(),
    getPendingEnrichments: vi.fn(),
    insertEnrichment: vi.fn(),
    getWatchedKeys: vi.fn(),
    upsertWatchedKey: vi.fn(),
    findEventByHash: vi.fn(),
    getModelConfig: vi.fn(),
    health: vi.fn(),
  })),
}));

describe("smgr CLI (HTTP client)", () => {
  it("initializes SmgrApiClient with SMGR_API_URL env var", () => {
    // Stub SMGR_API_URL, import smgr module init logic
    // Assert SmgrApiClient constructor called with correct baseUrl
  });

  it("defaults SMGR_API_URL to https://sitemgr.vercel.app", () => {
    // Do not set SMGR_API_URL
    // Assert SmgrApiClient constructor called with default URL
  });

  it("passes loaded credentials token to SmgrApiClient", () => {
    // Mock loadCredentials to return a token
    // Assert SmgrApiClient constructor called with { token: "..." }
  });

  it("login command prompts for email/password and calls api.login()", () => {
    // Mock prompt and promptPassword
    // Invoke login command
    // Assert api.login called with email and password
    // Assert saveCredentials called with the result
  });

  it("query command calls api.query() with parsed options", () => {
    // Mock api.query to return test data
    // Invoke query command with --search "beach" --limit 5
    // Assert api.query called with { search: "beach", limit: 5 }
  });

  it("show command calls api.show() with event id", () => {
    // Invoke show command with event id argument
    // Assert api.show called with that id
  });

  it("stats command calls api.stats()", () => {
    // Invoke stats command
    // Assert api.stats called
  });

  it("handles 401 ApiError with helpful re-login message", () => {
    // Mock api.query to throw ApiError with status 401
    // Assert process exits with EXIT.USER and error message includes "login"
  });

  it("handles ApiError with service exit code for 5xx", () => {
    // Mock api.stats to throw ApiError with status 500
    // Assert process exits with EXIT.SERVICE
  });

  it("logout command calls clearCredentials()", () => {
    // Invoke logout command
    // Assert clearCredentials called
  });

  it("whoami command calls loadCredentials() and prints info", () => {
    // Mock loadCredentials to return test creds
    // Invoke whoami command
    // Assert output includes email
  });

  it("does not import from @/lib/media/db", () => {
    // Read smgr.ts file content
    // Assert no import from "../lib/media/db" or "@/lib/media/db"
  });
});
```

## Verification Steps

Run these from `/home/user/sitemgr/web`:

```bash
# 1. Type-check compiles (catches missing imports, wrong signatures)
npx tsc --noEmit

# 2. cli-auth tests pass
npx vitest run __tests__/cli-auth.test.ts

# 3. CLI tests pass
npx vitest run __tests__/smgr-cli.test.ts

# 4. Full test suite still passes
npm test

# 5. Verify no db.ts imports in smgr.ts
grep -n "lib/media/db" bin/smgr.ts
# Expected: no output (exit code 1)

# 6. Verify no @supabase/supabase-js imports in cli-auth.ts
grep -n "@supabase/supabase-js" lib/auth/cli-auth.ts
# Expected: no output (exit code 1)

# 7. Verify deleted functions are gone from cli-auth.ts
grep -n "resolveApiConfig\|refreshSession\|export async function login" lib/auth/cli-auth.ts
# Expected: no output (exit code 1)

# 8. Manual smoke test (requires running dev server)
SMGR_API_URL=http://localhost:3000 npx tsx bin/smgr.ts login
SMGR_API_URL=http://localhost:3000 npx tsx bin/smgr.ts stats
SMGR_API_URL=http://localhost:3000 npx tsx bin/smgr.ts query --limit 5
```

## Completion Criteria

1. `bin/smgr.ts` has zero imports from `lib/media/db` -- all data access goes through `SmgrApiClient`
2. `lib/auth/cli-auth.ts` has zero imports from `@supabase/supabase-js`
3. `resolveApiConfig`, `login`, and `refreshSession` are deleted from `cli-auth.ts`
4. `saveCredentials`, `prompt`, and `promptPassword` are exported from `cli-auth.ts`
5. `SMGR_API_URL` is interpreted as the web app URL (not Supabase URL)
6. `SMGR_API_KEY` is not referenced anywhere in the CLI
7. All test cases pass
8. The full test suite passes without regressions
