# Implementation Plan — 11-service-role-key-audit

## Background

This codebase uses Supabase for its database, auth, and storage. The local development script (`scripts/local-dev.sh`) contains a workaround that manually constructs JWTs by reaching into Docker containers — a practice that violates the principle that application code should never sign JWTs.

The workaround was added when Supabase CLI ≥ 2.78 switched GoTrue to ES256 JWT signing, which broke `auth.admin.*` calls using the HS256 `SERVICE_ROLE_KEY` from `supabase status`. Upstream fixes have since landed: CLI ≥ 2.76.4 (PR [supabase/cli#4818](https://github.com/supabase/cli/pull/4818)) fixed `auth.admin.*` calls, and the keys from `supabase status -o json` now work as-is. The source code comments in `local-dev.sh` describe the state when the workaround was written and are now outdated.

Additionally, the Supabase service role key is referenced under two different env var names (`SUPABASE_SECRET_KEY` and `SUPABASE_SERVICE_ROLE_KEY`) across the codebase, creating confusion about which is canonical. Server-side code uses `SUPABASE_SERVICE_ROLE_KEY` but instrumentation, tests, and CI use `SUPABASE_SECRET_KEY`.

Integration tests also call Supabase SDK directly (`client.from("events").select()`) instead of going through the application layer (`queryEvents()` from `db.ts`), meaning they test Supabase, not the app.

## Goals

1. **Delete the ES256 JWT workaround** in `local-dev.sh` and add a capability probe to verify keys work
2. **Rename `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY`** everywhere in server-side code, CI, tests, config, and documentation
3. **Rename the env var in the CLI** but keep `getAdminClient()` — defer the "CLI talks to web API" architecture change
4. **Refactor integration tests** to use `db.ts`/`s3.ts` instead of raw Supabase SDK calls, except for RLS/security boundary tests
5. **Start Next.js dev server in test globalSetup** for HTTP-layer tests (auth smoke tests)

## Architecture: CLI vs Server

A critical distinction: **the CLI is a web API client, not a direct Supabase client.** Supabase is an implementation detail of the server.

| Layer | Env vars | Talks to |
|-------|----------|----------|
| Web app (browser) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase directly |
| Web app (server) | Same + `SUPABASE_SERVICE_ROLE_KEY` | Supabase directly |
| CLI (`smgr`) | `SMGR_API_URL`, `SMGR_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase directly (v1); Web API (future) |

The CLI's `SMGR_API_URL` and `SMGR_API_KEY` are **not** aliases for Supabase vars. They point to the Next.js web API. The original spec incorrectly proposed consolidating these — they stay as-is.

**Note on CLI architecture:** The long-term goal is for the CLI to talk exclusively to the web API (no direct Supabase access). However, the CLI currently uses `getAdminClient()` with the service role key to bypass RLS, and has no authenticated Supabase session mechanism. Switching to `getUserClient()` without designing the auth flow (loading stored tokens, calling `setSession()`, handling refresh) would break all CLI commands. This architectural change is deferred to a separate spec.

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

The script's output section currently writes `SUPABASE_SECRET_KEY=...`. Change to `SUPABASE_SERVICE_ROLE_KEY=...`. Keep the `SMGR_API_URL` and `SMGR_API_KEY` lines in the output — during local dev the CLI points directly at Supabase (since the Next.js dev server may not be running yet). Add clear comments separating the two groups:

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

Hard cut — no fallbacks. Every occurrence of `SUPABASE_SECRET_KEY` in server-side code, tests, CI, config, and documentation becomes `SUPABASE_SERVICE_ROLE_KEY`.

### Application and test files

**`web/instrumentation.ts`** — The `required` array includes `"SUPABASE_SECRET_KEY"`. Change to `"SUPABASE_SERVICE_ROLE_KEY"`.

**`web/__tests__/integration/setup.ts`** — The `SUPABASE_SERVICE_KEY` local var reads from `process.env.SUPABASE_SECRET_KEY`. Change to read from `process.env.SUPABASE_SERVICE_ROLE_KEY`.

**`web/__tests__/integration/globalSetup.ts`** — If it references `SUPABASE_SECRET_KEY`, rename.

**`web/__tests__/integration/smgr-cli.test.ts`** — The `cliEnv()` function passes `SUPABASE_SECRET_KEY` to subprocess. Change to `SUPABASE_SERVICE_ROLE_KEY`.

**`web/__tests__/integration/smgr-e2e.test.ts`** — Same pattern as smgr-cli.test.ts.

**`.github/workflows/ci.yml`** — All `SUPABASE_SECRET_KEY` references in the integration test job and deployment job.

**`web/.env.example`** and **`.env.example`** — Rename the key.

**`scripts/setup/verify.sh`** — Change the checked var name.

### Documentation files

**`docs/ENV_VARS.md`** — Rename the existing `SUPABASE_SECRET_KEY` table entry to `SUPABASE_SERVICE_ROLE_KEY`.

**`docs/QUICKSTART.md`** — Rename all references.

**`docs/DEPLOYMENT.md`** — Rename in env var table and troubleshooting sections.

**`INTEGRATION_TESTS_SETUP.md`** — Rename all references.

### Files already correct (no change needed)

- `web/app/api/health/route.ts` — Already uses `SUPABASE_SERVICE_ROLE_KEY`
- `web/lib/agent/core.ts` — Already uses `SUPABASE_SERVICE_ROLE_KEY`
- `web/__tests__/agent-core.test.ts` — Already stubs `SUPABASE_SERVICE_ROLE_KEY`
- `web/__tests__/phone-migration-app.test.ts` — Already stubs `SUPABASE_SERVICE_ROLE_KEY`

## Section 3: Rename Env Var in CLI (Keep Admin Client)

The CLI (`web/bin/smgr.ts`) currently has:

```typescript
function getClient() {
  return getAdminClient({
    url: process.env.SMGR_API_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY!,
  });
}
```

### What changes

**Rename only** — keep `getAdminClient()`, update env var references:

```typescript
function getClient() {
  return getAdminClient({
    url: process.env.SMGR_API_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  });
}
```

- Remove the `SUPABASE_SECRET_KEY ??` fallback (hard cut)
- Remove the `NEXT_PUBLIC_SUPABASE_URL` fallback (CLI should use `SMGR_API_URL`)
- Keep `getAdminClient()` — the CLI needs RLS bypass until the "CLI talks to web API" refactor

### What does NOT change

- CLI still uses `getAdminClient()` with service role key
- CLI tests still pass `SUPABASE_SERVICE_ROLE_KEY` (renamed from `SUPABASE_SECRET_KEY`) to subprocess
- The "CLI talks to web API only" architecture is deferred to a separate spec

### Why not switch to `getUserClient()` now

The CLI has no authenticated Supabase session mechanism. It stores credentials in `~/.sitemgr/credentials.json` but there is no code to load those tokens into a Supabase client via `setSession()`. Without a valid user JWT, RLS denies all access — every CLI command would break. Designing this auth flow is out of scope for an env var rename PR.

## Section 4: Refactor Integration Tests to Use App Layer

### Principle

Test assertions call our code (`db.ts`, `s3.ts`). Test setup/teardown can use raw Supabase admin SDK (no app-layer equivalent for `auth.admin.createUser()`).

**Exception: RLS/security boundary tests.** Tests that verify Postgres row-level security policies (e.g., `tenant-isolation.test.ts`) must use raw SDK calls. These tests intentionally query without app-layer filters to prove RLS restricts results at the database level. Replacing `client.from("events").select("*")` with `queryEvents(client, { userId })` would test the app filter, not the RLS policy.

### Import approach

Test files import app functions directly from `@/lib/media/db` and `@/lib/media/s3` — no re-exports through `setup.ts`. The `setup.ts` file keeps only test-specific utilities (user creation, seeding, cleanup). This avoids a naming collision with the existing `getAdminClient` in `setup.ts` (which has a different signature — no arguments, reads from env vars) and eliminates the maintenance burden of keeping re-exports in sync.

### Refactor `media-lifecycle.test.ts`

Current raw SDK calls for writes:
- `admin.from("events").insert({...})` → `insertEvent(admin, eventData)`
- `admin.from("bucket_configs").insert({...})` — this is test-only setup (configuring a bucket), raw SDK is acceptable per the principle.

### Do NOT refactor `tenant-isolation.test.ts`

This test verifies RLS policies by making unfiltered queries through authenticated user clients. The raw SDK calls are intentional — they prove Postgres enforces row-level security even when the application layer doesn't add `WHERE` clauses. Leave these as-is.

### Files already correct

- `media-storage.test.ts` — already uses `uploadS3Object()` from `s3.ts`
- `auth-smoke.test.ts` — already uses `getAdminClient()` and `getUserClient()` from `db.ts`

## Section 5: Add Next.js Dev Server to `globalSetup.ts`

Auth smoke tests need to hit `/api/*` endpoints on the running web app.

### Implementation

In `globalSetup.ts`:
1. After validating Supabase connectivity, check if port 3000 (or a configurable `TEST_PORT`) is already in use
2. If a server is already running on that port, skip spawning (developer may have `next dev` running)
3. If not, spawn `npm run dev` in the `web/` directory with `PORT` set explicitly
4. Poll `http://localhost:{port}/api/health` until it returns 200 (timeout 60s — Next.js first-start compiles on demand)
5. Store the child process reference and "did we spawn it" flag on `globalThis.__WEB_SERVER__`
6. In teardown, only kill the process if we spawned it

### Considerations

- The dev server picks up env vars from `web/.env.local` automatically
- Use 60s timeout (not 30s) — CI runners are slower and Next.js compiles pages on first request
- Port collision detection: `fetch("http://localhost:{port}/api/health")` — if it succeeds, server is already running

### CI workflow impact

If auth smoke tests run in CI and need the dev server, the CI workflow must also start it. Add a step in the integration tests job to start the Next.js dev server before running tests, or have globalSetup handle it (preferred — keeps the logic in one place).

## Section 6: Update CI Workflow

**`.github/workflows/ci.yml`** changes:

### Integration tests job
- `SUPABASE_SECRET_KEY=$(...)` → `SUPABASE_SERVICE_ROLE_KEY=$(...)`
- `echo "SUPABASE_SECRET_KEY=..." >> $GITHUB_ENV` → `echo "SUPABASE_SERVICE_ROLE_KEY=..." >> $GITHUB_ENV`

### Deployment job
- Storage bucket creation curl command uses `${{ secrets.SUPABASE_SECRET_KEY }}` in the Authorization header → change to `${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}`
- Any Vercel environment variable references that use `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY`

### Manual steps (outside code)
- **Vercel Production:** Rename the `SUPABASE_SECRET_KEY` environment variable to `SUPABASE_SERVICE_ROLE_KEY` in Vercel dashboard. Coordinate timing with deploy.
- **GitHub Production Environment:** Rename the `SUPABASE_SECRET_KEY` secret to `SUPABASE_SERVICE_ROLE_KEY` in GitHub repository settings → Environments → Production. This is the secret referenced by `${{ secrets.SUPABASE_SECRET_KEY }}` in the deploy job.

Document both manual steps in the PR description.

## Section 7: Update Config and Documentation

### `.env.example` (root)
- `SUPABASE_SECRET_KEY=` → `SUPABASE_SERVICE_ROLE_KEY=`

### `web/.env.example`
- `SUPABASE_SECRET_KEY=` → `SUPABASE_SERVICE_ROLE_KEY=`
- Keep `SMGR_API_URL` and `SMGR_API_KEY` (they're correct)

### `scripts/setup/verify.sh`
- Check for `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`

### `docs/ENV_VARS.md`
- Rename existing `SUPABASE_SECRET_KEY` entry to `SUPABASE_SERVICE_ROLE_KEY`
- Add a section documenting the rename and why
- Document the CLI vs server architecture: CLI uses `SMGR_API_URL`/`SMGR_API_KEY` (web API), server uses `NEXT_PUBLIC_SUPABASE_*` and `SUPABASE_SERVICE_ROLE_KEY` (Supabase direct)
- Explain which keys are JWTs and why (the table from the original spec is excellent)

### `docs/QUICKSTART.md`
- Rename all `SUPABASE_SECRET_KEY` references

### `docs/DEPLOYMENT.md`
- Rename in env var table and troubleshooting sections

### `INTEGRATION_TESTS_SETUP.md`
- Rename all `SUPABASE_SECRET_KEY` references

## Implementation Order

1. **Section 1** (ES256 workaround) — Foundation, must go first since `local-dev.sh` generates the env file other things depend on
2. **Section 2** (env var rename) — Straightforward find-and-replace across app/test/config files
3. **Section 3** (CLI env var rename) — Just rename, keep admin client
4. **Section 4** (test refactor) — Depends on section 2 (new env var names in setup.ts)
5. **Section 5** (Next.js dev server) — Independent, but test refactor may surface the need
6. **Section 6** (CI workflow) — Depends on section 2
7. **Section 7** (config/docs) — Last, documents final state

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Vercel production still expects `SUPABASE_SECRET_KEY` | Document the manual Vercel secret rename in PR description; coordinate deploy |
| GitHub Production environment secret still has old name | Document the manual GitHub secret rename alongside Vercel rename |
| Integration tests fail after refactor | Run tests after each file change, not batch |
| `db.ts` missing functions that tests need | Check each raw SDK call against `db.ts` API surface; add functions only if truly needed |
| `local-dev.sh` capability probe flaky | Make probe lightweight (single admin API call); timeout after 5s with clear error |
| Port 3000 already in use when starting dev server | Detect existing server, skip spawning if already running |
| Next.js dev server slow to start in CI | Use 60s timeout; consider `next build && next start` if dev mode too slow |
