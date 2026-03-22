# Opus Review

**Model:** claude-opus-4
**Generated:** 2026-03-22T06:15:00.000Z

---

## Plan Review: Fix Integration CI Env Vars

### Section 1 (CI Workflow): Source variable name mismatch

The plan (Section 1 line 38-39 and spec lines 134-135) says to use `${{ env.SUPABASE_URL }}` and `${{ env.SUPABASE_PUBLISHABLE_KEY }}` -- but those env var names do not exist in the integration test job. They only exist in the E2E job (lines 191-192 of `ci.yml`).

In the integration test job, the "Extract Supabase connection details" step (line 84-96) stores:
- `SMGR_API_URL` (not `SUPABASE_URL`)
- `SMGR_API_KEY` (not `SUPABASE_PUBLISHABLE_KEY`)

The spec's proposed fix block actually gets this right (`${{ env.SMGR_API_URL }}` and `${{ env.SMGR_API_KEY }}`), but the plan's Section 1 text on lines 38-41 is misleading when it says "These use the same `${{ env.SUPABASE_URL }}` / `${{ env.SUPABASE_PUBLISHABLE_KEY }}` references that the E2E job already uses." They are NOT the same references. The implementer should use `${{ env.SMGR_API_URL }}` and `${{ env.SMGR_API_KEY }}`. This contradiction between the plan narrative and the spec code block could cause someone to use the wrong variable names.

### Section 1: Env var verification step not updated

Lines 98-111 of `ci.yml` show a "Verify integration test env vars" step that checks `SMGR_API_URL`, `SMGR_API_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. The plan does not mention adding `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to this verification list. Since these are now required for the dev server to start, they should be verified too. Otherwise, a future regression that breaks the env var mapping will produce the same confusing 60-second timeout instead of a fast, clear error.

### Section 1: Ordering within the workflow

The plan says to add the `NEXT_PUBLIC_*` lines "at the top of" the "Configure environment for smgr" step (line 113). This works, but there is a subtlety: the `NEXT_PUBLIC_*` vars are set via `>> $GITHUB_ENV`, which means they are only available in subsequent steps, not in the same step. Since the dev server is spawned much later (in the test run step via `globalSetup.ts`), this is fine. But the plan should note that these vars will NOT be available in the same step they are defined -- only in later steps. This is a common `$GITHUB_ENV` footgun.

### Section 2 (globalSetup.ts): SMGR_API_URL is NOT equivalent to NEXT_PUBLIC_SUPABASE_URL

The plan proposes falling back `NEXT_PUBLIC_SUPABASE_URL` to `SMGR_API_URL`. In local dev and CI these happen to be the same value (`http://127.0.0.1:54321`). But conceptually `SMGR_API_URL` is the Supabase REST API URL while `NEXT_PUBLIC_SUPABASE_URL` is the Supabase project URL used by `@supabase/supabase-js`. In the local Supabase instance these are identical, but if someone ever runs against a remote Supabase, they might differ. The fallback is fine as a pragmatic defensive measure, but the code should include a comment explaining this is only safe for local Supabase instances.

### Section 2: .env.local files and Next.js auto-loading

The plan does not discuss how Next.js auto-loads `.env.local`. When `npm run dev` is spawned, Next.js will read `.env.local` if it exists (which `scripts/local-dev.sh` creates). In local development, the `NEXT_PUBLIC_*` vars are likely already in `.env.local`, making the globalSetup fallback redundant. In CI, there is no `.env.local` for the integration job (only the E2E job creates one). The plan should mention this -- alternatively, the integration test job could write a `.env.local` file the same way the E2E job does (lines 194-200), which would be more consistent and would avoid needing the globalSetup fallback entirely. This is worth considering as an alternative or additional approach.

### Section 3 (Smoke test retries): Masking real failures

Adding retry logic with 3 attempts and 5-second delays is reasonable for cold starts, but the plan should specify which failure modes should trigger a retry versus which should fail immediately:

- **Connection refused / timeout**: Retry (cold start)
- **HTTP 503 with `status: degraded`**: This could be a legitimate configuration error, not a cold start. Retrying a misconfigured deployment 3 times wastes 10 seconds and obscures the problem.
- **HTTP 200 with `status: ok`**: Success, stop.

The plan lumps all failures together for retry. A better approach: retry on connection errors and HTTP 5xx, but consider logging a warning if the response body says "degraded" since that typically indicates a config problem, not a transient issue.

### Section 3: /tmp/health.json is a shared path

The smoke test writes to `/tmp/health.json`. In a retry loop, each iteration overwrites the previous response. If the plan intends to "print all diagnostic info" after retries are exhausted, it should capture or print each attempt's response, not just the last one. Otherwise you lose the response from the first attempt that might have had a different error than the last.

### Missing consideration: The health endpoint uses non-null assertions

In `/home/user/sitemgr/web/app/api/health/route.ts` lines 13-14:
```typescript
url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
```

The `!` non-null assertions mean TypeScript won't warn about undefined values. At runtime, `undefined` gets passed to `getUserClient`. The `try/catch` around this code catches the resulting error and returns 503 "degraded", so it does not crash the server. However, the error message is generic. A quick improvement (not in scope of this plan, but worth noting) would be to check for undefined before calling `getUserClient` and return a more specific error message like `"NEXT_PUBLIC_SUPABASE_URL not configured"`. This would make debugging much faster than the current opaque "degraded" response.

### Missing consideration: Production failure root cause is unresolved

The plan says on line 11: "The Vercel production environment already has the correct NEXT_PUBLIC_* vars configured -- the production failure was a transient issue at deploy time." But the spec (lines 79-107) shows the production deploy returned 503 "degraded" and a separate "Invalid Compact JWS" error. The plan explicitly defers investigation of the stale `SUPABASE_SERVICE_ROLE_KEY` (spec Fix 3, marked optional). If the production Vercel env vars are truly correct, what caused the 503? Was it a cold start? A deployment race? The plan does not resolve this question and the smoke test retry logic in Section 3 is essentially a workaround for an unexplained failure. The plan should either investigate the production failure or explicitly document it as a known gap.

### Missing consideration: No `.env.local` validation step for integration tests

The E2E job writes `.env.local` and Next.js loads it. The integration job does not write `.env.local` and relies on `$GITHUB_ENV` (which the spawned process inherits via `process.env`). This works but is inconsistent. If a future change to globalSetup uses `execa` or a different spawn mechanism that doesn't inherit `process.env` the same way, it will break silently. The plan should mention this design choice and the assumption it depends on.

### Minor: Plan says "No local validation needed"

Line 130: "No local validation needed -- CI is the validation environment." This is pragmatic, but if the CI change itself has a typo in the variable name, you discover it only after a CI run. A quick local check would be to run `SMGR_API_URL=http://127.0.0.1:54321 SMGR_API_KEY=test npm run test:integration` without `NEXT_PUBLIC_*` set, verifying the globalSetup fallback (Section 2) works. This would validate Section 2 locally.

### Summary of actionable items

1. **Fix the variable name contradiction** between Section 1 narrative (says `SUPABASE_URL`) and actual CI env var names (`SMGR_API_URL`). This is the most likely source of an implementation error.
2. **Add `NEXT_PUBLIC_*` to the verification step** at lines 98-111 of `ci.yml` for fast failure.
3. **Differentiate retry-worthy vs non-retry-worthy failures** in the smoke test.
4. **Consider writing `.env.local`** in the integration job (matching the E2E pattern) instead of or in addition to the `$GITHUB_ENV` approach.
5. **Document the unresolved production failure** root cause or investigate it.
