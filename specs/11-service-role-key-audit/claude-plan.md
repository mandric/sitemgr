# Implementation Plan — 11-service-role-key-audit

## Background

This codebase uses Supabase for its database, auth, and storage. The local development script (`scripts/local-dev.sh`) contains a workaround that manually constructs JWTs by reaching into Docker containers — a practice that violates the principle that application code should never sign JWTs. The workaround was needed for Supabase CLI versions 2.71–2.76.3 but is now unnecessary since upstream fixes landed in CLI ≥ 2.76.4.

Additionally, the Supabase service role key is referenced under two different env var names (`SUPABASE_SECRET_KEY` and `SUPABASE_SERVICE_ROLE_KEY`) across the codebase, creating confusion about which is canonical. Server-side code uses `SUPABASE_SERVICE_ROLE_KEY` but instrumentation, tests, and CI use `SUPABASE_SECRET_KEY`.

Integration tests also call Supabase SDK directly (`client.from("events").select()`) instead of going through the application layer (`queryEvents()` from `db.ts`), meaning they test Supabase, not the app.

## Goals

1. **Delete the ES256 JWT workaround** in `local-dev.sh` and add a capability probe to verify keys work
2. **Rename `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY`** everywhere in server-side code, CI, tests, and config
3. **Remove the service role key from the CLI** — the CLI is a web API client, not a direct Supabase client
4. **Refactor integration tests** to use `db.ts`/`s3.ts` instead of raw Supabase SDK calls
5. **Start Next.js dev server in test globalSetup** for HTTP-layer tests (auth smoke tests)

## Architecture: CLI vs Server

A critical distinction: **the CLI is a web API client, not a direct Supabase client.** Supabase is an implementation detail of the server.

| Layer | Env vars | Talks to |
|-------|----------|----------|
| Web app (browser) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase directly |
| Web app (server) | Same + `SUPABASE_SERVICE_ROLE_KEY` | Supabase directly |
| CLI (`smgr`) | `SMGR_API_URL`, `SMGR_API_KEY` | Web API (not Supabase) |

The CLI's `SMGR_API_URL` and `SMGR_API_KEY` are **not** aliases for Supabase vars. They point to the Next.js web API. The original spec incorrectly proposed consolidating these — they stay as-is.

## Section 1: Remove ES256 Workaround from `local-dev.sh`

### What to remove

Lines 61–91 of `scripts/local-dev.sh` contain the workaround:
1. Find the `supabase_auth_*` Docker container
2. Extract `GOTRUE_JWT_KEYS` env var
3. Parse JWKS for EC private key
4. Hand-sign a JWT with `{iss: "supabase-local", role: "service_role", exp: 9999999999}`
5. Use this as `SUPABASE_SECRET_KEY`

Delete this entire block. The keys from `supabase status -o json` work as-is on CLI ≥ 2.76.4.

### Capability probe (replaces version check)

Instead of parsing `supabase --version`, add a capability probe after extracting keys from `supabase status`. The probe makes a lightweight GoTrue admin API call (e.g., `GET /auth/v1/admin/users?per_page=1` with `Authorization: Bearer ${SERVICE_ROLE_KEY}`) and checks for a 200 response. If it fails, error with a message: "Service role key rejected by GoTrue. If you're on Supabase CLI < 2.76.4, upgrade: https://github.com/supabase/cli".

### Update env var output

The script's output section currently writes `SUPABASE_SECRET_KEY=...`. Change to `SUPABASE_SERVICE_ROLE_KEY=...`. Remove the `SMGR_API_URL` and `SMGR_API_KEY` lines from the output — those are web API vars set separately, not derived from `supabase status`.

Wait — the script currently outputs `SMGR_API_URL=${api_url}` because during local dev, the CLI points directly at Supabase (since there's no separate running web API in some setups). This may need to stay for local dev convenience. The output should clearly comment which vars are for what:

```
# --- Supabase (server-side) ---
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# --- CLI (local dev points directly at Supabase) ---
SMGR_API_URL=...
SMGR_API_KEY=...
```

## Section 2: Rename `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY`

Hard cut — no fallbacks. Every occurrence of `SUPABASE_SECRET_KEY` in server-side code, tests, CI, and config becomes `SUPABASE_SERVICE_ROLE_KEY`.

### Files affected

**`web/instrumentation.ts`** — The `required` array includes `"SUPABASE_SECRET_KEY"`. Change to `"SUPABASE_SERVICE_ROLE_KEY"`.

**`web/__tests__/integration/setup.ts`** — The `SUPABASE_SERVICE_KEY` local var reads from `process.env.SUPABASE_SECRET_KEY`. Change to read from `process.env.SUPABASE_SERVICE_ROLE_KEY`.

**`web/__tests__/integration/globalSetup.ts`** — If it references `SUPABASE_SECRET_KEY`, rename.

**`web/__tests__/integration/smgr-cli.test.ts`** — The `cliEnv()` function passes `SUPABASE_SECRET_KEY` to subprocess. Change to `SUPABASE_SERVICE_ROLE_KEY`.

**`web/__tests__/integration/smgr-e2e.test.ts`** — Same pattern as smgr-cli.test.ts.

**`.github/workflows/ci.yml`** — All `SUPABASE_SECRET_KEY` references in the integration test job and deployment job. The deployment job also uses it in a `curl` Authorization header for storage bucket creation.

**`web/.env.example`** — Rename the key.

**`.env.example`** — Rename the key.

**`scripts/setup/verify.sh`** — Change the checked var name from `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY`.

### Files already correct (no change needed)

- `web/app/api/health/route.ts` — Already uses `SUPABASE_SERVICE_ROLE_KEY`
- `web/lib/agent/core.ts` — Already uses `SUPABASE_SERVICE_ROLE_KEY`
- `web/__tests__/agent-core.test.ts` — Already stubs `SUPABASE_SERVICE_ROLE_KEY`
- `web/__tests__/phone-migration-app.test.ts` — Already stubs `SUPABASE_SERVICE_ROLE_KEY`

## Section 3: Remove Service Role Key from CLI

The CLI (`web/bin/smgr.ts`) currently has:

```typescript
function getClient() {
  return getAdminClient({
    url: process.env.SMGR_API_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY!,
  });
}
```

This creates an **admin** Supabase client (bypasses RLS). The CLI should instead use the anon/publishable key through the web API.

### Changes to `smgr.ts`

Replace `getClient()` to use `getUserClient()` (from `db.ts`) instead of `getAdminClient()`. The client config comes from `SMGR_API_URL` and `SMGR_API_KEY`:

```typescript
function getClient() {
  return getUserClient({
    url: process.env.SMGR_API_URL!,
    anonKey: process.env.SMGR_API_KEY!,
  });
}
```

**Risk:** Some CLI commands may currently depend on admin/RLS-bypass behavior. Audit each command in `smgr.ts` to identify which ones:
- Query events, stats, enrichment status — these should work with user-scoped RLS (they filter by user ID anyway)
- Insert events, enrichments — same, user-scoped
- Any admin-only operations (bucket creation, user management) — these shouldn't be in the CLI

If any command breaks because it relied on RLS bypass, that's a signal the command needs to be moved to a server API endpoint or removed from the CLI.

### Changes to CLI test files

`smgr-cli.test.ts` and `smgr-e2e.test.ts` pass `SUPABASE_SECRET_KEY` to the CLI subprocess. Remove this env var from the subprocess env — CLI shouldn't need it. Keep `SMGR_API_URL` and `SMGR_API_KEY`.

## Section 4: Refactor Integration Tests to Use App Layer

### Principle

Test assertions call our code (`db.ts`, `s3.ts`). Test setup/teardown can use raw Supabase admin SDK (no app-layer equivalent for `auth.admin.createUser()`).

### Add re-exports to `setup.ts`

Add re-exports from `db.ts` and `s3.ts` so test files import from `setup.ts`:

```typescript
export { getAdminClient, getUserClient, queryEvents, showEvent, getStats,
         getEnrichStatus, insertEvent, insertEnrichment, upsertWatchedKey,
         getWatchedKeys, findEventByHash, getPendingEnrichments } from "@/lib/media/db";
export { createS3Client, listS3Objects, downloadS3Object,
         uploadS3Object } from "@/lib/media/s3";
```

### Refactor `tenant-isolation.test.ts`

Current raw SDK calls:
- `aliceClient.from("events").select("*")` → `queryEvents(aliceClient, { userId: aliceId })`
- `aliceClient.from("enrichments").select("*")` → use `getEnrichStatus()` or a direct enrichment query if one exists
- `aliceClient.from("watched_keys").select("*")` → `getWatchedKeys(aliceClient, aliceId)`

Review each assertion to map to the correct `db.ts` function. Some may not have exact equivalents (e.g., if a test selects from `enrichments` directly and `db.ts` only has `getEnrichStatus` which returns a count). In those cases, either:
1. Use the closest available function if the test intent is preserved
2. Add a thin query function to `db.ts` if genuinely needed (but prefer option 1)

### Refactor `media-lifecycle.test.ts`

Current raw SDK calls for writes:
- `admin.from("events").insert({...})` → `insertEvent(admin, eventData)`
- `admin.from("bucket_configs").insert({...})` — this may not have a `db.ts` equivalent. If it's test-only setup (configuring a bucket for the test), raw SDK is acceptable per the principle.

### Files already correct

- `media-storage.test.ts` — already uses `uploadS3Object()` from `s3.ts`
- `auth-smoke.test.ts` — already uses `getAdminClient()` and `getUserClient()` from `db.ts`

## Section 5: Add Next.js Dev Server to `globalSetup.ts`

Auth smoke tests need to hit `/api/*` endpoints on the running web app.

### Implementation

In `globalSetup.ts`:
1. After validating Supabase connectivity, spawn `npm run dev` in the `web/` directory
2. Poll `http://localhost:3000/api/health` until it returns 200 (with timeout ~30s)
3. Store the child process reference on `globalThis.__WEB_SERVER__`
4. In teardown, kill the process

### Considerations

- The dev server needs env vars set (the canonical names from `.env.local`)
- If tests already run from the `web/` directory, the dev server will pick up `.env.local` automatically
- Set `PORT=3000` explicitly (or read from config) so tests know where to send requests
- Add a reasonable startup timeout with clear error message if the server doesn't start

## Section 6: Update CI Workflow

**`.github/workflows/ci.yml`** changes:

### Integration tests job
- `SUPABASE_SECRET_KEY=$(...)` → `SUPABASE_SERVICE_ROLE_KEY=$(...)`
- `echo "SUPABASE_SECRET_KEY=..." >> $GITHUB_ENV` → `echo "SUPABASE_SERVICE_ROLE_KEY=..." >> $GITHUB_ENV`

### Deployment job
- Storage bucket creation curl command uses `${{ env.SUPABASE_SECRET_KEY }}` in the Authorization header → change to `${{ env.SUPABASE_SERVICE_ROLE_KEY }}`
- Any Vercel environment variable references that use `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY`
- **Production Vercel secret:** The actual secret name in Vercel must also be renamed. This is a manual step outside the code — document it in the PR description.

## Section 7: Update Config and Documentation

### `.env.example` (root)
- `SUPABASE_SECRET_KEY=` → `SUPABASE_SERVICE_ROLE_KEY=`

### `web/.env.example`
- `SUPABASE_SECRET_KEY=` → `SUPABASE_SERVICE_ROLE_KEY=`
- Keep `SMGR_API_URL` and `SMGR_API_KEY` (they're correct)

### `scripts/setup/verify.sh`
- Check for `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`

### `docs/ENV_VARS.md`
- Add a section documenting the rename and why
- Document the CLI vs server architecture: CLI uses `SMGR_API_URL`/`SMGR_API_KEY` (web API), server uses `NEXT_PUBLIC_SUPABASE_*` and `SUPABASE_SERVICE_ROLE_KEY` (Supabase direct)
- Explain which keys are JWTs and why (the table from the original spec is excellent)
- Note that `SUPABASE_SECRET_KEY` is deprecated/removed

## Implementation Order

1. **Section 1** (ES256 workaround) — Foundation, must go first since `local-dev.sh` generates the env file other things depend on
2. **Section 2** (env var rename) — Straightforward find-and-replace, low risk
3. **Section 3** (CLI service key removal) — Depends on understanding smgr.ts command surface
4. **Section 4** (test refactor) — Depends on section 2 (new env var names in setup.ts)
5. **Section 5** (Next.js dev server) — Independent, but test refactor may surface the need
6. **Section 6** (CI workflow) — Depends on section 2
7. **Section 7** (config/docs) — Last, documents final state

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| CLI commands break without admin client | Audit each command before removing; user-scoped queries should work with anon key + authenticated session |
| Vercel production still expects `SUPABASE_SECRET_KEY` | Document the manual Vercel secret rename in PR description; coordinate deploy |
| Integration tests fail after refactor | Run tests after each file change, not batch |
| `db.ts` missing functions that tests need | Check each raw SDK call against `db.ts` API surface; add functions only if truly needed |
| `local-dev.sh` capability probe flaky | Make probe lightweight (single admin API call); timeout after 5s with clear error |
