# 12-fix-integration-ci-env-vars — Spec

## Overview

Fix two CI failures caused by missing `NEXT_PUBLIC_*` environment variables after the service-role-key-audit refactor (spec 11). The health endpoint was migrated from admin client to user client, but the CI integration test job and the Vercel production environment were not updated to supply the new env vars.

## Current Failures

Five consecutive CI runs fail across two branches:

| Run ID | Branch | Job | Status | Error |
|--------|--------|-----|--------|-------|
| 23395992701 | `claude/fix-pipeline-O8zyY` | Integration Tests | **fail** | Dev server timeout (60s) |
| 23395901195 | `claude/fix-pipeline-O8zyY` | Integration Tests | **fail** | Dev server timeout (60s) |
| 23395813658 | `claude/fix-pipeline-O8zyY` | Integration Tests | **fail** | Dev server timeout (60s) |
| 23388493608 | `main` | Deploy to Production | **fail** | Smoke test: health returns 503 "degraded" |
| 23388455413 | `claude/fix-pipeline-O8zyY` | All jobs | **pass** | Last known good (SHA `6c85cbcb`, before refactor) |

## Root Cause Analysis

### The refactor (spec 11, SHA `6c85cbcb..5ffe7a6f`)

Two changes landed together in the service-role-key-audit implementation:

1. **`web/app/api/health/route.ts`** — Switched from `getAdminClient` (using `SUPABASE_SERVICE_ROLE_KEY`) to `getUserClient` (using `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`). This is the correct change — the health endpoint should not use the service role key.

2. **`web/__tests__/integration/globalSetup.ts`** — Added dev server spawning: the global setup now runs `npm run dev` and polls `http://localhost:3000/api/health` for readiness before integration tests execute. Previously, no dev server was involved.

### Failure 1: Integration tests — Dev server never becomes ready

**Symptom:** `Dev server did not become ready at http://localhost:3000/api/health within 60000ms`

**Chain of events:**
1. `globalSetup.ts` validates Supabase connectivity (passes — `SMGR_API_URL` is set)
2. Port 3000 is not in use, so it spawns `npm run dev` with `{ ...process.env, PORT: "3000" }`
3. Next.js starts and serves `/api/health`
4. The health handler calls `getUserClient({ url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! })`
5. **Neither `NEXT_PUBLIC_SUPABASE_URL` nor `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is set** in the integration test CI job
6. `getUserClient` throws `"url is required for user client"` (or receives `undefined` and the Supabase client fails)
7. Health endpoint returns HTTP 503 (`{ status: "degraded" }`) or crashes
8. `waitForReady()` polls for 60 seconds, every response is non-200, timeout fires
9. Vitest reports "No test files found" because `globalSetup` threw before test discovery

**Evidence from CI logs (run 23395992701):**
```
2026-03-22T04:56:44.1782430Z  RUN  v4.0.18  /home/runner/work/sitemgr/sitemgr/web
2026-03-22T04:57:44.5834223Z No test files found, exiting with code 1
2026-03-22T04:57:44.5903071Z Error: Dev server did not become ready at http://localhost:3000/api/health within 60000ms
```

Exactly 60 seconds between start and failure — the full timeout elapsed.

**CI env vars set for integration tests (`ci.yml` lines 84-124):**
```
SMGR_API_URL=http://127.0.0.1:54321
SMGR_API_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SMGR_S3_ENDPOINT=...
SMGR_S3_BUCKET=media
...
```

**Missing:**
```
NEXT_PUBLIC_SUPABASE_URL         (not set — health endpoint needs this)
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY  (not set — health endpoint needs this)
```

**Comparison with E2E test job** — The E2E job *does* set these (lines 194-200):
```yaml
printf '%s\n' \
  "NEXT_PUBLIC_SUPABASE_URL=${{ env.SUPABASE_URL }}" \
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${{ env.SUPABASE_PUBLISHABLE_KEY }}" \
  > .env.local
```

The integration test job has no equivalent step.

### Failure 2: Production deploy — Smoke test returns "degraded"

**Symptom:** `HEALTH CHECK FAILED (status: degraded)` with HTTP 503

**CI logs (run 23388493608):**
```
=== Health check: GET https://sitemgr-nine.vercel.app/api/health ===
HTTP status: 503
Response:
{
  "status": "degraded",
  "service": "smgr",
  "timestamp": "2026-03-21T20:54:38.918Z"
}
```

**Chain of events:**
1. The merge to `main` deployed the new health endpoint code to Vercel
2. The smoke test hits `https://sitemgr-nine.vercel.app/api/health`
3. The health endpoint calls `getUserClient({ url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! })`
4. If these env vars are missing or misconfigured in Vercel, the Supabase query fails
5. The catch block sets `ok = false`, returns `{ status: "degraded" }` with HTTP 503
6. `smoke_test` in `scripts/lib.sh` detects non-"ok" status, exits with code 5

**Additional clue** — the "Create storage bucket" step also failed:
```
{"statusCode":"403","error":"Unauthorized","message":"Invalid Compact JWS"}
```
The `Authorization: Bearer ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}` header produced an invalid JWS, suggesting the secret may be stale or malformed. This is a separate issue but compounds the deploy failure.

### Why the last successful run passed

Run `23388455413` (SHA `6c85cbcb`) used the **pre-refactor code**:
- `globalSetup.ts` only validated Supabase connectivity — it did **not** spawn a dev server
- `health/route.ts` used `getAdminClient` with `SUPABASE_SERVICE_ROLE_KEY` — no `NEXT_PUBLIC_*` vars needed
- All integration tests ran directly against Supabase without a web server

## Affected Files

| File | Issue |
|------|-------|
| `.github/workflows/ci.yml` (lines 113-124) | Integration test env config missing `NEXT_PUBLIC_*` vars |
| `web/app/api/health/route.ts` | Correctly uses `getUserClient` but needs matching env vars |
| `web/__tests__/integration/globalSetup.ts` | Spawns dev server that depends on `NEXT_PUBLIC_*` vars |
| Vercel project settings | May need `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` configured |

## Proposed Fix

### Fix 1: CI integration test job — add NEXT_PUBLIC env vars

In `.github/workflows/ci.yml`, add to the "Configure environment for smgr" step (around line 114):

```yaml
- name: Configure environment for smgr
  run: |
    echo "NEXT_PUBLIC_SUPABASE_URL=${{ env.SMGR_API_URL }}" >> $GITHUB_ENV
    echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${{ env.SMGR_API_KEY }}" >> $GITHUB_ENV
    echo "SMGR_S3_ENDPOINT=${{ env.STORAGE_S3_URL }}" >> $GITHUB_ENV
    # ... rest of existing env vars
```

The values map directly: `SMGR_API_URL` → `NEXT_PUBLIC_SUPABASE_URL`, `SMGR_API_KEY` → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. They point to the same local Supabase instance.

### Fix 2: Verify Vercel production env vars

Confirm that the Vercel project has these environment variables set for the Production environment:
- `NEXT_PUBLIC_SUPABASE_URL` = `https://<project-ref>.supabase.co`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = the project's anon/publishable key

### Fix 3 (optional): Investigate stale SUPABASE_SERVICE_ROLE_KEY in GitHub deploy secrets

The "Invalid Compact JWS" error on storage bucket creation suggests the `SUPABASE_SERVICE_ROLE_KEY` secret in the GitHub Production environment may be stale or incorrectly formatted. This is a separate issue from the health check failure but should be investigated.

## Testing

After applying Fix 1:
1. Push to `claude/fix-pipeline-O8zyY` and verify the integration test job passes
2. Confirm the dev server starts within the 60s timeout
3. Confirm all integration tests execute and pass

After applying Fix 2:
1. Merge to `main` and verify the deploy smoke test returns `{ status: "ok" }`
2. Manually verify: `curl https://sitemgr-nine.vercel.app/api/health` returns HTTP 200

## Risk Assessment

- **Fix 1 (CI):** Zero risk — only adds env vars to the CI test runner, no code changes
- **Fix 2 (Vercel):** Low risk — adding/verifying env vars in Vercel dashboard, standard operational task
- **Fix 3 (secret rotation):** Medium risk — changing the service role key requires coordination; incorrect values could break bucket creation in future deploys
