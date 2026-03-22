# Integration Notes: Opus Review Feedback

## Integrating

### 1. Fix variable name contradiction (Section 1)
**Suggestion:** The plan incorrectly says to use `${{ env.SUPABASE_URL }}` — the integration job stores these as `SMGR_API_URL` / `SMGR_API_KEY`.
**Action:** Fix the narrative in Section 1 to use the correct source variable names. This is a genuine error that could cause implementation mistakes.

### 2. Add NEXT_PUBLIC_* to env var verification step
**Suggestion:** The CI workflow has a "Verify integration test env vars" step that doesn't check the new vars.
**Action:** Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to the verification step. This gives a fast, clear error instead of a confusing 60s timeout.

### 3. Differentiate retry-worthy failures in smoke test
**Suggestion:** Don't retry on `status: degraded` (config error), only on connection errors and timeouts.
**Action:** Update Section 3 to specify: retry on connection refused/timeout, fail immediately on HTTP 200 with non-ok status or HTTP 503 with degraded response (config error).

### 4. Add comment to globalSetup fallback
**Suggestion:** Note that SMGR_API_URL = NEXT_PUBLIC_SUPABASE_URL equivalence is only true for local Supabase.
**Action:** Add a comment in the plan specifying this constraint.

### 5. Note $GITHUB_ENV availability footgun
**Suggestion:** Vars set via `>> $GITHUB_ENV` are only available in subsequent steps, not the same step.
**Action:** Add a brief note to Section 1.

## NOT Integrating

### A. Write .env.local instead of $GITHUB_ENV
**Why not:** The user explicitly chose `$GITHUB_ENV` over `.env.local` during the interview (answered "Your call" and we chose `$GITHUB_ENV` for consistency with existing SMGR_* pattern). The globalSetup defensive fallback covers the gap. Adding `.env.local` would duplicate the approach.

### B. Investigate production failure root cause
**Why not:** The user confirmed Vercel env vars are configured correctly. The production 503 was likely a transient cold-start or deployment race. The scope is explicitly "focus on env vars only" — the JWS/service-role-key issue is out of scope. The smoke test retry addresses transient failures; config errors fail fast.

### C. Health endpoint error message improvement
**Why not:** Out of scope for this spec. The reviewer correctly noted it's not in scope. Could be a follow-up.

### D. /tmp/health.json shared path concern
**Why not:** The smoke test runs serially (one curl at a time). In a retry loop, we only need the last response for diagnostics. Each attempt prints its own status as it goes.

### E. Local validation of globalSetup fallback
**Why not:** User explicitly chose "CI validation only" during interview. The globalSetup fallback is simple enough that CI validation is sufficient.
