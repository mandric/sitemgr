# Interview Transcript: Fix Integration CI Env Vars

## Q1: Vercel Environment Configuration

**Q:** The CI fix is straightforward (add 2 env vars to $GITHUB_ENV). But for the production deploy failure — do you know if NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are configured in your Vercel project settings?

**A:** Yes, they're configured.

## Q2: Scope — JWS Issue

**Q:** The deploy job also shows 'Invalid Compact JWS' when creating the storage bucket with SUPABASE_SERVICE_ROLE_KEY. Should the fix include investigating/updating this secret, or focus only on the env var issue?

**A:** Focus on env vars only.

## Q3: Env Var Propagation Approach

**Q:** For passing NEXT_PUBLIC_* vars to the dev server in CI, should we use the .env.local approach (like E2E tests do) or $GITHUB_ENV (like the existing SMGR_* vars)?

**A:** Your call.

## Q4: Smoke Test Robustness

**Q:** The smoke_test function in scripts/lib.sh is pretty minimal. Should we improve its error reporting (e.g. print response body on failure, add retry logic) or keep it simple?

**A:** Yes, make it more robust.

## Q5: globalSetup Defensive Mapping

**Q:** The globalSetup spawns the dev server with `{ ...process.env, PORT: '3000' }`. Should globalSetup explicitly map SMGR_API_URL → NEXT_PUBLIC_SUPABASE_URL (defensive, works even if CI forgets), or should we keep globalSetup simple and just ensure CI provides the vars?

**A:** Explicit mapping in globalSetup.

## Q6: Validation Approach

**Q:** How should we validate the fix works before merging?

**A:** CI validation only.
