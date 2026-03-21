# Interview Transcript — 11-service-role-key-audit

## Q1: Env var migration strategy — hard cut or deprecation period?

**Question:** The CLI (`smgr.ts`) currently does `SMGR_API_URL ?? NEXT_PUBLIC_SUPABASE_URL`. After consolidation, should we drop the fallback entirely or keep a deprecation period?

**Answer:** Hard cut — no fallbacks. Anyone with stale `.env.local` re-runs `local-dev.sh`.

## Q2: CLI test negative cases?

**Question:** For `smgr-cli.test.ts` and `smgr-e2e.test.ts` that spawn CLI as subprocess — should we add negative tests for missing canonical env vars?

**Answer:** The CLI generally needs to be logged in and caches credentials. Not sure how admin/service functions will work through CLI if at all. For now the focus is user space.

## Q3: Next.js dev server in globalSetup?

**Question:** Should we add Next.js dev server startup in globalSetup.ts now or defer?

**Answer:** Add it now — auth smoke tests need it.

## Q4: Supabase CLI version check approach?

**Question:** Should version check parse `supabase --version` or probe a capability?

**Answer:** Why do we need a version check? Just test the feature works or not. (Capability probe preferred.)

## Q5: Integration test refactor scope?

**Question:** Should we do full test refactor (SDK→db.ts/s3.ts) now or just env var rename?

**Answer:** Full refactor per spec.

## Q6: CLI env var architecture

**Question:** `SMGR_API_URL` is the web API URL (not Supabase directly), and `SMGR_API_KEY` authenticates to the web API. Should these stay as CLI-specific env vars? The spec's proposed consolidation (SMGR_API_URL → NEXT_PUBLIC_SUPABASE_URL) would be wrong since they serve different purposes.

**Answer:** Keep SMGR_* for CLI. Only the web API is dependent on Supabase — it's an implementation detail. The CLI is just a web client. The API wraps the backend and the CLI just uses the API.

## Q7: CLI and SUPABASE_SECRET_KEY

**Question:** Currently `smgr.ts` uses `SUPABASE_SECRET_KEY` to create an admin Supabase client directly. Should CLI stop reading any Supabase key entirely?

**Answer:** Remove — CLI goes through API only.

## Q8: CLI refactor scope — removing admin Supabase access

**Question:** Removing `SUPABASE_SECRET_KEY` from CLI means `getClient()` in `smgr.ts` can't create an admin client. smgr.ts is 696 lines with many commands. How to handle?

**Answer:** We use the anon/publishable key for the CLI, not the service key. (The admin client reference is legacy.)

## Key Architectural Insight

The CLI is a **web API client**, not a direct Supabase client. `SMGR_API_URL` and `SMGR_API_KEY` are the web API endpoint and key, not aliases for Supabase vars. This changes the consolidation plan:

- **`SMGR_API_URL` stays** — it's the web API URL, not `NEXT_PUBLIC_SUPABASE_URL`
- **`SMGR_API_KEY` stays** — it authenticates to the web API, not directly to Supabase
- **`SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY`** — only in server-side code
- **CLI drops `SUPABASE_SECRET_KEY`** — removes direct admin Supabase access entirely
