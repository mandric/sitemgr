# Implementation Plan: Fix Integration CI Env Vars

## Background

The service-role-key-audit refactor (spec 11) changed the health endpoint (`web/app/api/health/route.ts`) from using `getAdminClient` with `SUPABASE_SERVICE_ROLE_KEY` to `getUserClient` with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. It also added dev server spawning to the integration test `globalSetup.ts`.

The CI integration test job was not updated to provide these `NEXT_PUBLIC_*` environment variables. This causes:
1. **Integration tests**: The dev server starts but the health endpoint returns 503 because the env vars are undefined. `waitForReady()` times out after 60s.
2. **Production deploy**: The smoke test hits the deployed health endpoint which returns "degraded" (503).

The Vercel production environment already has the correct `NEXT_PUBLIC_*` vars configured — the production failure was a transient issue at deploy time. The fix focuses on CI.

## Architecture Context

The codebase uses two parallel naming conventions for the same Supabase connection details:

- **`NEXT_PUBLIC_SUPABASE_URL`** / **`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`** — Used by Next.js app code (health endpoint, webhook handler). The `NEXT_PUBLIC_` prefix makes these available to client-side code.
- **`SMGR_API_URL`** / **`SMGR_API_KEY`** — Used by CLI tools and test infrastructure. Same values, different names.

In local development, `scripts/local-dev.sh` generates a `.env.local` file with both sets. In CI, the E2E test job writes `.env.local` with the `NEXT_PUBLIC_*` vars. The integration test job only sets `SMGR_*` vars via `$GITHUB_ENV`.

The `globalSetup.ts` spawns the dev server with `{ ...process.env, PORT: "3000" }`, so the dev server inherits whatever is in the CI environment. Since `NEXT_PUBLIC_*` vars aren't there, the health endpoint fails.

---

## Section 1: CI Workflow — Add NEXT_PUBLIC Env Vars

### What to change

In `.github/workflows/ci.yml`, add two lines to the "Configure environment for smgr" step in the integration test job. These map from the already-available Supabase connection values to the `NEXT_PUBLIC_*` names the health endpoint expects.

### Where in the file

The integration test job's environment configuration step is around lines 113-124. The new lines should be added at the top of this step's `run` block, before the existing `SMGR_S3_*` lines.

### Values to set

- `NEXT_PUBLIC_SUPABASE_URL` ← value of `$SUPABASE_URL` (extracted from `supabase status -o json` earlier in the job, stored as `SUPABASE_URL` env var at line ~94)
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` ← value of `$SUPABASE_PUBLISHABLE_KEY` (extracted similarly, stored at line ~95)

These use the same `${{ env.SUPABASE_URL }}` / `${{ env.SUPABASE_PUBLISHABLE_KEY }}` references that the E2E job already uses.

### Format

Use the existing `echo "VAR=value" >> $GITHUB_ENV` pattern, consistent with how `SMGR_*` vars are set in the same step.

---

## Section 2: globalSetup.ts — Defensive Env Var Mapping

### What to change

When `globalSetup.ts` spawns the dev server, it should ensure the `NEXT_PUBLIC_*` vars are present in the child process environment. This is a defensive measure — if CI configuration is correct (Section 1), these vars are already in `process.env`. But if someone runs integration tests locally without `.env.local` or without setting `NEXT_PUBLIC_*` vars, the fallback from `SMGR_*` prevents a confusing timeout.

### How it works

In the spawn call, instead of `{ ...process.env, PORT: "3000" }`, construct an env object that:
1. Starts with `...process.env`
2. Sets `PORT: "3000"` (existing)
3. Sets `NEXT_PUBLIC_SUPABASE_URL` to `process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SMGR_API_URL` (fallback)
4. Sets `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to `process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SMGR_API_KEY` (fallback)

This preserves existing `NEXT_PUBLIC_*` values if already set (from `.env.local` or CI), and falls back to `SMGR_*` values if not.

### Error handling

If neither `NEXT_PUBLIC_*` nor `SMGR_*` vars are available, the dev server will still fail at the health endpoint. The existing 60s timeout and error message handle this case. No additional error handling is needed in globalSetup — the current timeout message is clear enough.

### Where in the file

The spawn call is in the `setup()` function, around lines 90-95 of `globalSetup.ts`. The env object construction should happen just before the `spawn()` call.

---

## Section 3: Smoke Test Improvements

### What to change

The `smoke_test` function in `scripts/lib.sh` should be made more robust with retry logic and better diagnostic output.

### Current behavior

The function makes a single `curl` request to `/api/health`, checks for `status: "ok"` in the JSON response, and exits with code 5 if it fails. It also tests the webhook endpoint with a POST. No retries, minimal diagnostics.

### Improvements

**Retry logic for the health check:**
- Retry the GET `/api/health` request up to 3 times with a short delay (5s between retries)
- This handles transient cold-start failures on Vercel (first request after deploy may timeout or fail)
- Only the health check GET needs retries — the webhook POST is a secondary check

**Better diagnostic output on failure:**
- Print the full response body when the health check fails (the function already captures it to `/tmp/health.json` but could print it more prominently)
- Print the HTTP status code alongside the JSON status
- Distinguish between connection errors (curl fails), HTTP errors (non-200), and degraded status (200 but status != "ok")

**Retry implementation approach:**
- Wrap the health check curl in a loop (max 3 attempts)
- On each failure, print which attempt it was and what happened
- Sleep 5 seconds between retries
- Only proceed to the webhook test if health check eventually succeeds
- If all retries exhausted, print all diagnostic info and exit with failure

### Where in the file

The `smoke_test` function starts around line 21 of `scripts/lib.sh`. The health check portion (lines ~30-45) gets the retry wrapper. The webhook POST portion stays as-is but only runs after health check passes.

---

## Implementation Order

1. **Section 1 (CI workflow)** — Fixes the root cause. Can be validated immediately by pushing to branch.
2. **Section 2 (globalSetup)** — Defensive improvement. Prevents recurrence if CI config is modified.
3. **Section 3 (smoke test)** — Robustness improvement. Makes future deploy failures easier to diagnose.

All three sections are independent and can be implemented in any order, but logically flow as listed.

## Files Modified

| File | Section | Type of change |
|------|---------|---------------|
| `.github/workflows/ci.yml` | 1 | Add 2 env var lines |
| `web/__tests__/integration/globalSetup.ts` | 2 | Modify spawn env object |
| `scripts/lib.sh` | 3 | Add retry loop and diagnostics to `smoke_test` |

## Validation Strategy

- Push all changes to `claude/fix-pipeline-O8zyY`
- CI integration tests should pass (dev server starts, health returns 200, tests run)
- No local validation needed — CI is the validation environment
- Smoke test improvements validated on next production deploy
