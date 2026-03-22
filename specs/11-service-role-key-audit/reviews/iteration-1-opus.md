# Opus Review

**Model:** claude-opus-4
**Generated:** 2026-03-21

---

## Plan Review: 11-service-role-key-audit

### Overall Assessment

The plan is well-structured and mostly accurate in its analysis of the codebase. The file inventory is correct, the implementation order is sensible, and the architecture distinction between CLI and server is sound. However, there are several issues ranging from a critical security/functional mistake in Section 3 to missing files in the rename inventory.

---

### Critical: Section 3 CLI Refactor Will Break Everything

**The plan proposes replacing `getAdminClient()` with `getUserClient()` in `smgr.ts`.** This is the right direction architecturally, but the plan dramatically underestimates the impact and does not provide a workable migration path.

The CLI currently calls `getAdminClient()` which creates a Supabase client with the service role key. This bypasses RLS entirely. Every single CLI command (`query`, `show`, `stats`, `enrich`, `watch`, `add`) uses this client to directly read/write Supabase tables.

Switching to `getUserClient()` with the anon key means RLS applies. But the CLI does not authenticate as a user through Supabase Auth -- it uses `SMGR_USER_ID` (a raw UUID) or credentials from `~/.sitemgr/credentials.json`. The `getUserClient()` from `db.ts` creates a client with just the anon key and no auth session attached. Without a valid JWT in the Authorization header, RLS will deny all access to every table, not just some commands.

The plan's risk table says "user-scoped queries should work with anon key + authenticated session" but never addresses how the authenticated session gets attached. The CLI's `login` flow stores credentials locally, but there is no code shown (or proposed) to use those stored tokens with the Supabase client.

**Recommendation:** Either (a) keep the service role key in the CLI for now and defer this to the "CLI talks to web API" refactor (which is the stated long-term goal per the architecture table), or (b) explicitly design the auth flow: load the stored access token from `~/.sitemgr/credentials.json`, call `supabase.auth.setSession()`, and handle token refresh. Option (a) is far simpler and more honest about what v1 needs.

---

### Missing Files in Section 2 Rename Inventory

The plan identifies files to rename but misses several that showed up in the grep:

1. **`docs/QUICKSTART.md`**: References `SUPABASE_SECRET_KEY`.
2. **`docs/DEPLOYMENT.md`**: References `SUPABASE_SECRET_KEY` in env var table and troubleshooting.
3. **`docs/ENV_VARS.md`**: Has `SUPABASE_SECRET_KEY` in its own variable table.
4. **`INTEGRATION_TESTS_SETUP.md`**: References `SUPABASE_SECRET_KEY`.

The plan's Section 7 mentions updating `docs/ENV_VARS.md` but only to "add a section documenting the rename" -- it does not mention fixing the existing table entry that still uses the old name.

---

### Section 1: ES256 Workaround Description Is Wrong

The plan states the workaround is at "Lines 61-91" and says it was needed for "CLI versions 2.71-2.76.3" with the fix landing in ">= 2.76.4." But the actual comment in `local-dev.sh` says the opposite: "Supabase CLI >= 2.78 sets up an EC key pair" and the workaround exists because **newer** CLI versions use ES256 keys that reject HS256 tokens. The plan's background narrative about this being a workaround for old CLI versions that is now unnecessary should be verified. If the upstream fix truly landed such that `supabase status -o json` returns a valid service role key for EC-based setups, that is fine, but the plan should not contradict the source code comments without explaining which is correct.

---

### Section 4: Tenant Isolation Test Refactor Is Counterproductive

The plan proposes replacing raw SDK calls like `aliceClient.from("events").select("*")` with `queryEvents(aliceClient, { userId: aliceId })`. This fundamentally changes what the test is testing.

The tenant isolation tests are **RLS policy tests**. They verify that Postgres row-level security correctly filters rows when an authenticated user queries directly. The raw SDK call `aliceClient.from("events").select("*")` (no filter) is intentional -- it proves RLS restricts results without the application layer adding a `WHERE user_id = ...` clause.

If you replace this with `queryEvents(aliceClient, { userId: aliceId })`, you are now testing that your application layer adds the correct filter, which is a completely different test. The RLS guarantee -- that even a buggy application layer cannot leak data -- is lost.

**Recommendation:** Leave tenant-isolation tests using raw SDK calls. They are correct as-is. The plan's principle ("test assertions call our code") should not apply to RLS/security boundary tests. Add an explicit carve-out for security tests.

---

### Section 5: Dev Server in globalSetup Has Port Conflict Risk

The plan proposes spawning `npm run dev` in globalSetup and polling port 3000. Issues:

1. **No port collision handling.** If a developer already has `next dev` running on port 3000, the spawned process will fail silently or bind to a different port. The plan should either detect an existing server and skip spawning, or use a dedicated test port (e.g., 3001).

2. **Process cleanup on test crash.** Storing the child process on `globalThis.__WEB_SERVER__` and killing in teardown works for normal exits. If the test runner crashes or is SIGKILL'd, the orphaned Next.js process will hold the port. Consider writing a PID file or using a cleanup-on-exit library.

3. **Startup time.** Next.js dev server first-start compiles pages on demand and can take well over 30 seconds on CI runners. The plan says "timeout ~30s" which is likely too short. Consider 60s, or better yet, use `next build && next start` for a production server that starts faster.

4. **Missing from CI.** Section 6 (CI workflow changes) does not mention adding the dev server startup, but Section 5 states auth smoke tests need it. If these tests run in CI, the workflow needs updating too.

---

### Section 3 + Test Files: Inconsistency in What Gets Removed

The plan says to remove `SUPABASE_SECRET_KEY` from CLI test env in `smgr-cli.test.ts` and `smgr-e2e.test.ts`. But the tests themselves document that the CLI cannot function without the service role key because there is no user JWT available in CLI context. Simply removing the env var will make all CLI integration tests fail.

---

### CI Deploy Job: `secrets.SUPABASE_SECRET_KEY` Is a GitHub Secret

In the CI workflow, the deploy job uses `${{ secrets.SUPABASE_SECRET_KEY }}` for the storage bucket creation curl. This is a GitHub Actions secret in the Production environment, not a workflow env var. The plan mentions "Document the manual Vercel secret rename in PR description" but does not mention that the GitHub Production environment secret also needs renaming. This is a separate manual step from the Vercel rename.

---

### Section 4: Re-export Approach Is Fragile

The plan proposes adding re-exports from `setup.ts`. This creates coupling: every time a function is added to `db.ts`, someone must remember to re-export it from `setup.ts`. It also conflicts with the existing `getAdminClient` already exported from `setup.ts` (which has a different signature -- it takes no arguments and reads from env vars, while the one in `db.ts` takes a config object).

**Recommendation:** Have test files import directly from `@/lib/media/db` and `@/lib/media/s3`. The `setup.ts` file should only export test-specific utilities (user creation, seeding, cleanup). This avoids the naming collision and the maintenance burden.

---

### Minor: Plan Self-Contradiction on SMGR_API_URL/SMGR_API_KEY

The plan says in Section 1: "Remove the `SMGR_API_URL` and `SMGR_API_KEY` lines from the output" then immediately reverses itself with "Wait --". This reads like the author caught a mistake during drafting but left both in the document. Clean this up.

---

### Summary of Recommended Changes

1. **Do not switch CLI from admin to user client in this PR.** Rename the env var (`SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY`) but keep `getAdminClient()`. Defer the architectural change to when the CLI actually talks to the web API.
2. **Do not refactor tenant-isolation tests to use `db.ts`.** These are security boundary tests that intentionally test raw SDK behavior.
3. **Add missing documentation files** to the Section 2 rename inventory.
4. **Add the GitHub Production environment secret rename** as an explicit manual step alongside the Vercel secret rename.
5. **Address port collision and timeout** in Section 5, and add corresponding CI workflow changes.
6. **Remove the "Wait" self-contradiction** in Section 1.
7. **Drop the re-export approach** in Section 4; let tests import directly from source modules.
