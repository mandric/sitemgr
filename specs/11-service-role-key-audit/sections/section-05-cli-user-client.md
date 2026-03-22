Now I have all the context I need. Let me generate the section content.

# Section 5: Switch CLI from Admin Client to User Client

## Overview

The CLI (`web/bin/smgr.ts`) currently uses `getAdminClient()` with `SUPABASE_SECRET_KEY` to bypass RLS for all operations. This is unnecessary -- every `db.ts` function already filters by `userId`, which is exactly what RLS does automatically. The CLI should use `getUserClient()` with the stored JWT from `smgr login`, making the service role key unnecessary for CLI users.

## Background

The CLI already has a complete auth system in `web/lib/auth/cli-auth.ts`:
- `login()` authenticates via email/password against Supabase Auth and stores credentials in `~/.sitemgr/credentials.json`
- `refreshSession()` refreshes an expired JWT using the stored refresh token
- `loadCredentials()` reads the stored credentials file
- `resolveApiConfig()` reads `SMGR_API_URL` and `SMGR_API_KEY` from environment

The current `getClient()` function in `smgr.ts` (line 46-51) ignores all of this and creates an admin client:

```typescript
function getClient() {
  return getAdminClient({
    url: process.env.SMGR_API_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY!,
  });
}
```

## Dependencies

- No section dependencies (this section is in Batch 1, parallelizable)
- Requires `getUserClient` from `web/lib/media/db.ts` (already exists)
- Requires `refreshSession` and `resolveApiConfig` from `web/lib/auth/cli-auth.ts` (already exist)

## Tests First

### Test file: `web/__tests__/smgr-cli-auth.test.ts` (new, unit)

This unit test verifies the new `getClient()` behavior by mocking `cli-auth.ts` functions and `getUserClient`.

```
# Test: getClient() returns a user client (getUserClient), not an admin client
# Test: getClient() calls refreshSession() before setSession()
# Test: getClient() errors with "Not logged in" when no stored credentials
# Test: getClient() errors with "Session invalid" when setSession() fails
# Test: getClient() uses SMGR_API_URL and SMGR_API_KEY (not SUPABASE_SERVICE_ROLE_KEY)
# Test: getClient() is async (returns a Promise)
```

The test should:
- Mock `@/lib/auth/cli-auth` to control `refreshSession()` and `resolveApiConfig()` return values
- Mock `@/lib/media/db` to intercept `getUserClient()` calls and return a fake client with a mockable `auth.setSession()` method
- Verify that `getAdminClient` is never imported or called
- Use `vi.stubEnv()` for `SMGR_API_URL` and `SMGR_API_KEY` fixture values
- Verify the function returns a `Promise` (is async)

Key assertions:
1. When `refreshSession()` returns valid credentials, `getUserClient()` is called with `{ url, anonKey }` from `resolveApiConfig()`, then `client.auth.setSession()` is called with the access and refresh tokens from the credentials
2. When `refreshSession()` returns `null`, the function calls `cliError` (or equivalent) with a message containing "Not logged in"
3. When `client.auth.setSession()` returns an error, the function calls `cliError` with a message containing "Session invalid"

### Test file: `web/__tests__/integration/smgr-cli.test.ts` (existing, modify)

The existing integration test passes `SUPABASE_SECRET_KEY` to the CLI subprocess. Update it:

```
# Test: CLI subprocess does NOT receive SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY in env
# Test: CLI subprocess receives SMGR_API_URL and SMGR_API_KEY
# Test: CLI commands work with user JWT auth (login then execute then verify)
# Test: CLI errors with clear message when not logged in
```

## Implementation Details

### File: `web/bin/smgr.ts`

#### 1. Change `getClient()` from sync to async

The current `getClient()` is synchronous. It must become `async` because `refreshSession()` is async and `client.auth.setSession()` is async.

**Target signature:**

```typescript
async function getClient(): Promise<SupabaseClient> {
  const { url, anonKey } = resolveApiConfig();
  const client = getUserClient({ url, anonKey });

  const creds = await refreshSession();
  if (!creds) {
    cliError("Not logged in. Run 'smgr login' first.", EXIT.USER);
  }

  const { error } = await client.auth.setSession({
    access_token: creds.access_token,
    refresh_token: creds.refresh_token,
  });
  if (error) {
    cliError(`Session invalid: ${error.message}. Run 'smgr login'.`, EXIT.USER);
  }

  return client;
}
```

#### 2. Update imports

**Remove** from the `db.ts` import:
- `getAdminClient`

**Add** to the `db.ts` import:
- `getUserClient`

**Add** to the `cli-auth.ts` import (line 54 currently imports `login`, `clearCredentials`, `loadCredentials`):
- `refreshSession`
- `resolveApiConfig`

#### 3. Add `await` to all `getClient()` call sites

Every place that calls `getClient()` must now `await` it. Scan the file for all occurrences. Based on the current code, these are at:

- `cmdQuery` (line 129): `const client = getClient();` becomes `const client = await getClient();`
- `cmdShow` (line 180): same
- `cmdStats` (line 190): same
- `cmdEnrich` (line 214): same
- `cmdWatch` (line 354): same
- `cmdAdd` (line 509): same
- Main block model config loading (line 676-677): same -- this section also needs updating since it currently calls `getClient()` to load model config

For the main block (lines 672-695), the model config loading currently does:
```typescript
const creds = loadCredentials();
const userId = process.env.SMGR_USER_ID ?? creds?.user_id;
if (userId) {
  const client = getClient();
  // ...
}
```

This should become:
```typescript
const creds = loadCredentials();
const userId = process.env.SMGR_USER_ID ?? creds?.user_id;
if (userId) {
  const client = await getClient();
  // ...
}
```

Note: if the user is not logged in and `SMGR_USER_ID` is set via env, `getClient()` will fail because there are no stored credentials. This is intentional -- the CLI now requires authentication via `smgr login`. The `SMGR_USER_ID` env var remains useful as a convenience override for the user ID claim, but authentication is still required.

#### 4. Remove all `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` references

The current `getClient()` reads `process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY`. Remove these entirely. The CLI only needs:
- `SMGR_API_URL` -- the Supabase URL
- `SMGR_API_KEY` -- the anon/publishable key

#### 5. Update help text

The current help text (lines 621-668) includes an "Environment" section. Remove any reference to `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`. The environment section should list only:

```
Environment:
  SMGR_API_URL           Backend API URL (required)
  SMGR_API_KEY           Backend public key (required)
  SMGR_S3_BUCKET         S3 bucket name
  SMGR_S3_ENDPOINT       Custom S3 endpoint (for Supabase Storage)
  SMGR_S3_REGION         AWS region (default: us-east-1)
  ANTHROPIC_API_KEY      For enrichment
  SMGR_USER_ID           User UUID (overrides login session)
  SMGR_DEVICE_ID         Device identifier (default: default)
  SMGR_WATCH_INTERVAL    Poll interval in seconds (default: 60)
  SMGR_AUTO_ENRICH       Auto-enrich on watch (default: true)
```

The current help text already looks like this (no service role key listed), so this may already be correct. Verify and leave as-is if so.

#### 6. Update the `requireUserId()` function

The current `requireUserId()` falls back to `loadCredentials()` for user ID. This is fine as-is -- it does not use the admin client. No change needed here.

### File: `web/__tests__/integration/smgr-cli.test.ts`

#### Update `cliEnv()` function

The current `cliEnv()` function (lines 35-49) passes both `SMGR_API_KEY: cfg.serviceKey` and `SUPABASE_SECRET_KEY: cfg.serviceKey` to the CLI subprocess. This must change:

1. `SMGR_API_KEY` should use the **anon key** (not the service key). Get the anon key from the Supabase config.
2. Remove `SUPABASE_SECRET_KEY` entirely from the env passed to the CLI subprocess.
3. The CLI now needs a valid user session. The test setup must either:
   - Write a credentials file to a temp `HOME` directory, or
   - Use an alternative approach to provide the session

The integration test already creates a test user via `createTestUser()` which returns a `userClient` with a valid session. The test needs to extract the session tokens and make them available to the CLI subprocess. Options:
- Write a `~/.sitemgr/credentials.json` file in a temp home directory and set `HOME` in the subprocess env
- Or, since this is an integration test, the subprocess can be given a pre-authenticated session via a temp credentials file

The `cliEnv()` should set `HOME` to a temp directory where a valid `credentials.json` has been written, containing the test user's access and refresh tokens.

#### Update the exit codes test

The current test at line 358 checks `SUPABASE_SECRET_KEY`. This test should be updated to verify that the CLI errors when not logged in (no credentials file and no `SMGR_USER_ID`):

```
# Test: should exit non-zero when not logged in and no SMGR_USER_ID
```

### File: `web/lib/auth/cli-auth.ts`

No functional changes needed. The module already exports everything the CLI needs: `refreshSession`, `resolveApiConfig`, `loadCredentials`, `login`, `clearCredentials`.

Note: Line 6 has a comment referencing `SUPABASE_SECRET_KEY`:
```typescript
 * so the service role key (SUPABASE_SECRET_KEY) is never needed on user machines.
```
This comment update is handled by section-06 (instrumentation), not this section. Leave it as-is here.

## Why This Works

- Every `db.ts` function already filters by `userId` in the query (belt-and-suspenders with RLS)
- `cli-auth.ts` already implements `login()`, `refreshSession()`, `loadCredentials()`, `resolveApiConfig()`
- The stored JWT has the user's `sub` claim -- RLS checks `auth.uid()` against it
- S3 operations use `createS3Client()` which reads `SMGR_S3_*` env vars -- completely independent of Supabase auth
- The anon key is safe to distribute (it is the publishable key, same as what the browser uses)

## Verification

After implementation, confirm:
- `grep -r "getAdminClient" web/bin/` returns zero matches
- `grep -r "SUPABASE_SECRET_KEY\|SUPABASE_SERVICE_ROLE_KEY" web/bin/` returns zero matches
- `smgr login` followed by `smgr stats` works with only `SMGR_API_URL` and `SMGR_API_KEY` set
- `smgr stats` without login prints "Not logged in. Run 'smgr login' first." and exits with code 1