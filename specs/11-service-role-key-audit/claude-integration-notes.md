# Integration Notes — Opus Review Feedback

## What I'm Integrating

### 1. CLI refactor: Switch to user client (REVISED)
**Reviewer said:** Switching from `getAdminClient()` to `getUserClient()` will break all CLI commands because the CLI has no authenticated Supabase session.

**Original decision was: INTEGRATE (keep admin client).** However, on further review this was wrong. The auth infrastructure already exists in `cli-auth.ts`:
- `login()` calls `signInWithPassword()` and stores `access_token` + `refresh_token` in `~/.sitemgr/credentials.json`
- `refreshSession()` handles token refresh (checks expiry, calls `supabase.auth.refreshSession()`)
- `resolveApiConfig()` returns `{ url, anonKey }` from `SMGR_API_URL` / `SMGR_API_KEY`

The missing piece is just wiring `setSession()` into `getClient()`. The Opus reviewer was incorrect that "there is no code to load those tokens" — it exists, it's just not connected. The CLI is an end-user tool for indexing/enriching S3 media; it should not require the service role key.

**Revised decision: Switch CLI to `getUserClient()` + `setSession()` with stored JWT.** All `db.ts` functions already pass `userId` with `.eq("user_id", userId)` filters, so RLS + app-layer filtering is belt-and-suspenders.

### 2. Don't refactor tenant-isolation tests
**Reviewer said:** These are RLS policy tests that intentionally use raw SDK calls without filters to prove Postgres enforces row-level security. Replacing `client.from("events").select("*")` with `queryEvents(client, { userId })` would test the app filter, not the RLS policy.

**Decision: INTEGRATE.** This is a sharp observation. Tenant-isolation tests should be carved out from the "tests call our code" principle — they are security boundary tests.

### 3. Missing documentation files in rename inventory
**Reviewer said:** `docs/QUICKSTART.md`, `docs/DEPLOYMENT.md`, `docs/ENV_VARS.md` table entry, and `INTEGRATION_TESTS_SETUP.md` also reference `SUPABASE_SECRET_KEY`.

**Decision: INTEGRATE.** Need to verify these files exist and add them to the inventory.

### 4. GitHub Production environment secret
**Reviewer said:** `secrets.SUPABASE_SECRET_KEY` in CI deploy job is a GitHub Actions Production environment secret, separate from Vercel. Both need manual renaming.

**Decision: INTEGRATE.** Add as explicit manual step.

### 5. Drop re-export approach in setup.ts
**Reviewer said:** Re-exports create coupling and naming collision (`getAdminClient` already exported from `setup.ts` with different signature). Tests should import directly from `@/lib/media/db` and `@/lib/media/s3`.

**Decision: INTEGRATE.** This is cleaner. `setup.ts` keeps test-only utilities; test files import app functions directly.

### 6. Section 5 port collision and timeout
**Reviewer said:** No port collision handling, 30s timeout too short, missing CI workflow changes, orphaned process risk.

**Decision: PARTIALLY INTEGRATE.** Add port collision detection (check if already running, skip spawn). Increase timeout to 60s. Add CI workflow changes. Skip PID file complexity — if tests crash, developers know to check for orphaned processes.

### 7. Clean up "Wait" self-contradiction in Section 1
**Reviewer said:** The plan says "remove SMGR_* from output" then immediately says "Wait — keep them."

**Decision: INTEGRATE.** Just state the final decision cleanly.

## What I'm NOT Integrating

### 1. ES256 workaround timeline narrative
**Reviewer said:** The plan's narrative about which CLI versions needed the workaround contradicts source code comments.

**Decision: NOT INTEGRATING as a change.** The plan's narrative is informed by the spec which researched the upstream issues (the spec cites specific PRs and issues). The source code comment in `local-dev.sh` was written when the workaround was added and describes the state at that time. The spec documents that upstream fixes have since landed. The plan is correct — it's the code comment that's outdated. However, I'll clarify this in the plan.
