# TDD Plan — 11-service-role-key-audit

Test stubs for each section of `claude-plan.md`. Tests are written BEFORE implementation using Vitest (the project's existing framework).

**Testing conventions (from codebase):**
- Unit tests: `web/__tests__/*.test.ts` — use `vi.stubEnv()` for env vars, `vi.mock()` for modules
- Integration tests: `web/__tests__/integration/*.test.ts` — require running Supabase (`supabase start`)
- Test helpers: `web/__tests__/integration/setup.ts` — `createTestUser()`, `getAdminClient()`, `cleanupTestData()`
- Global setup: `web/__tests__/integration/globalSetup.ts` — validates Supabase connectivity
- Run: `npm test` (unit), `npm run test:integration` (integration)

---

## Section 1: Remove ES256 Workaround from `local-dev.sh`

Shell script changes — tested via integration test that validates the generated env file.

### Test file: `web/__tests__/integration/local-dev-output.test.ts`

```
# Test: print_setup_env_vars outputs NEXT_PUBLIC_SUPABASE_URL
# Test: print_setup_env_vars outputs NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
# Test: print_setup_env_vars outputs SMGR_API_URL and SMGR_API_KEY
# Test: print_setup_env_vars does NOT output SUPABASE_SECRET_KEY (old name)
# Test: print_setup_env_vars outputs SUPABASE_SERVICE_ROLE_KEY as a comment (not active env var)
# Test: print_setup_env_vars outputs valid dotenv format (no syntax errors)
# Test: capability probe succeeds when Supabase is running (service role key accepted by GoTrue)
```

These tests shell out to `scripts/local-dev.sh print_setup_env_vars` and parse the output. They require `supabase start` (integration test suite).

---

## Section 2: Remove Service Role Key from Health Endpoint

### Test file: `web/__tests__/health-route.test.ts` (unit)

```
# Test: health endpoint creates a user client (getUserClient), not an admin client
# Test: health endpoint does not reference SUPABASE_SERVICE_ROLE_KEY env var
# Test: health endpoint returns 200 with status "ok" when DB is reachable
# Test: health endpoint returns 503 when DB query fails
```

Unit test — mock `getUserClient` and verify the health route uses it correctly. No real Supabase needed.

### Test file: `web/__tests__/integration/auth-smoke.test.ts` (existing, extend)

```
# Test: GET /api/health returns 200 without service role key in environment
```

Integration test — verify the live health endpoint works with only the anon key configured.

---

## Section 3: Refactor Agent Core — Remove `createAdminClient()`

### Test file: `web/__tests__/agent-core.test.ts` (existing, modify)

The existing test already mocks `db.ts`. Update to verify dependency injection:

```
# Test: sendMessageToAgent accepts a SupabaseClient parameter
# Test: executeAction accepts a SupabaseClient parameter and passes it to db functions
# Test: getConversationHistory accepts a SupabaseClient parameter
# Test: saveConversationHistory accepts a SupabaseClient parameter
# Test: resolveUserId accepts a SupabaseClient parameter and calls get_user_id_from_phone RPC
# Test: agent core module does NOT import getAdminClient from db.ts
# Test: agent core module does NOT reference process.env.SUPABASE_SERVICE_ROLE_KEY
```

These are unit tests that verify the refactored function signatures and that no admin client is created internally.

### Test file: `web/__tests__/agent-actions.test.ts` (new, unit)

```
# Test: sendMessage server action passes the user's server client to getConversationHistory
# Test: sendMessage server action passes the user's server client to sendMessageToAgent
# Test: sendMessage server action passes the user's server client to saveConversationHistory
# Test: sendMessage does not create an admin client or reference service role key
```

Unit test — mock `@/lib/supabase/server` and `@/lib/agent/core`, verify the server action wires the user's client through.

---

## Section 4: Webhook Service Account + RLS Policy

### Test file: `web/__tests__/integration/webhook-service-account.test.ts` (new)

```
# Test: webhook service account user exists in auth.users (email = webhook@sitemgr.internal)
# Test: webhook service account can sign in with signInWithPassword
# Test: webhook service account can call get_user_id_from_phone RPC
# Test: webhook service account can read events belonging to another user
# Test: webhook service account can read enrichments belonging to another user
# Test: webhook service account can read/write conversations belonging to another user
# Test: webhook service account can read bucket_configs belonging to another user
# Test: regular authenticated user CANNOT read events belonging to another user (RLS still enforced)
# Test: regular authenticated user CANNOT call get_user_id_from_phone (or can but only sees own phone)
# Test: anon client CANNOT read any user's events (RLS enforced)
```

Integration test — requires running Supabase with the new migration applied. Creates real test users, verifies RLS boundaries.

### Test file: `web/__tests__/whatsapp-route.test.ts` (existing, modify)

```
# Test: WhatsApp webhook handler creates a webhook service account client (not admin client)
# Test: WhatsApp webhook handler does not reference SUPABASE_SERVICE_ROLE_KEY
# Test: WhatsApp webhook handler passes client to resolveUserId
# Test: WhatsApp webhook handler passes client to getConversationHistory and saveConversationHistory
```

Unit test — mock the Supabase client creation and verify the webhook uses the service account pattern.

---

## Section 5: Switch CLI from Admin Client to User Client

### Test file: `web/__tests__/smgr-cli-auth.test.ts` (new, unit)

```
# Test: getClient() returns a user client (getUserClient), not an admin client
# Test: getClient() calls refreshSession() before setSession()
# Test: getClient() errors with "Not logged in" when no stored credentials
# Test: getClient() errors with "Session invalid" when setSession() fails
# Test: getClient() uses SMGR_API_URL and SMGR_API_KEY (not SUPABASE_SERVICE_ROLE_KEY)
# Test: getClient() is async (returns a Promise)
```

Unit test — mock `cli-auth.ts` functions and `getUserClient`, verify the new auth flow.

### Test file: `web/__tests__/integration/smgr-cli.test.ts` (existing, modify)

```
# Test: CLI subprocess does NOT receive SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY in env
# Test: CLI subprocess receives SMGR_API_URL and SMGR_API_KEY
# Test: CLI commands work with user JWT auth (login → execute → verify)
# Test: CLI errors with clear message when not logged in
```

Integration test — runs the CLI as a subprocess with only anon key credentials.

---

## Section 6: Remove Service Role Key from Instrumentation

### Test file: `web/__tests__/instrumentation.test.ts` (new, unit)

```
# Test: instrumentation required vars include NEXT_PUBLIC_SUPABASE_URL
# Test: instrumentation required vars include NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
# Test: instrumentation required vars do NOT include SUPABASE_SECRET_KEY
# Test: instrumentation required vars do NOT include SUPABASE_SERVICE_ROLE_KEY
# Test: instrumentation warns when required vars are missing (existing behavior preserved)
```

Unit test — stub `process.env.NEXT_RUNTIME` to `"nodejs"`, capture console.error output.

---

## Section 7: Consolidate Remaining `SUPABASE_SECRET_KEY` References

### Test: codebase-wide grep (manual verification step)

```
# Test: grep for SUPABASE_SECRET_KEY in all .ts, .tsx, .yml, .sh files returns zero matches
#       (except this spec file and historical docs)
# Test: grep for SUPABASE_SERVICE_ROLE_KEY appears ONLY in:
#       - web/__tests__/integration/setup.ts (test admin client)
#       - .github/workflows/ci.yml (test setup + deployment)
#       - scripts/setup/verify.sh (optional verification)
#       - .env.example files (documented as test/admin only)
#       - docs/ files
```

This is a verification step, not a test file. Run after the rename and confirm no stale references.

### Test file: `web/__tests__/integration/setup.ts` (existing, modify — verification)

```
# Test: getAdminClient reads from process.env.SUPABASE_SERVICE_ROLE_KEY (not SUPABASE_SECRET_KEY)
# Test: getSupabaseConfig returns serviceKey from SUPABASE_SERVICE_ROLE_KEY
```

---

## Section 8: Refactor Integration Tests to Use App Layer

### Test file: `web/__tests__/integration/media-lifecycle.test.ts` (existing, modify)

```
# Test: event creation uses insertEvent() from db.ts (not admin.from("events").insert())
# Test: event query uses queryEvents() from db.ts (not client.from("events").select())
# Test: enrichment insert uses insertEnrichment() from db.ts
# Test: all assertions go through app-layer functions
```

This is a refactor of existing tests — the tests themselves ARE the deliverable. Verify by reading the test file and confirming no raw `client.from("events")` calls remain (except in `tenant-isolation.test.ts` which is intentionally raw).

### Verification: `tenant-isolation.test.ts` unchanged

```
# Verify: tenant-isolation.test.ts still uses raw SDK calls (intentional — tests RLS, not app layer)
# Verify: no imports from @/lib/media/db in tenant-isolation.test.ts
```

---

## Section 9: Add Next.js Dev Server to `globalSetup.ts`

### Test file: `web/__tests__/integration/globalSetup.ts` (existing, modify)

The globalSetup itself isn't tested — it's test infrastructure. Verify behavior manually:

```
# Test: globalSetup spawns dev server when port 3000 is not in use
# Test: globalSetup skips spawning when dev server already running on port 3000
# Test: globalSetup polls /api/health until 200 (timeout 60s)
# Test: globalSetup stores child process on globalThis.__WEB_SERVER__
# Test: teardown kills the spawned process (only if we spawned it)
# Test: auth-smoke tests can hit /api/health after globalSetup runs
```

Verification: run `npm run test:integration` without a running dev server — tests should still pass because globalSetup starts one.

---

## Section 10: Update CI Workflow

### Verification (not a test file — CI validation)

```
# Verify: ci.yml integration test job uses SUPABASE_SERVICE_ROLE_KEY (not SUPABASE_SECRET_KEY)
# Verify: ci.yml deployment job uses SUPABASE_SERVICE_ROLE_KEY for bucket creation
# Verify: ci.yml does NOT set SUPABASE_SECRET_KEY anywhere
# Verify: ci.yml integration tests pass in CI after all changes
```

Validated by the CI run itself. No separate test file needed.

---

## Section 11: Update Config and Documentation

### Verification (not a test file — doc validation)

```
# Verify: docs/ENV_VARS.md documents SUPABASE_SERVICE_ROLE_KEY as test/admin only
# Verify: docs/ENV_VARS.md documents webhook service account env vars
# Verify: CLAUDE.md Environment Variables section updated
# Verify: .env.example files have clear comments separating app vars from test/admin vars
# Verify: QUICKSTART.md and DEPLOYMENT.md use SUPABASE_SERVICE_ROLE_KEY (not SUPABASE_SECRET_KEY)
```

---

## Cross-Cutting: No Service Role Key in App Code

After all sections are implemented, run this final verification:

```
# Final: grep -r "SUPABASE_SECRET_KEY" across all .ts files returns zero matches
# Final: grep -r "SUPABASE_SERVICE_ROLE_KEY" in web/lib/ returns zero matches (app layer clean)
# Final: grep -r "SUPABASE_SERVICE_ROLE_KEY" in web/app/ returns zero matches (route handlers clean)
# Final: grep -r "SUPABASE_SERVICE_ROLE_KEY" in web/bin/ returns zero matches (CLI clean)
# Final: grep -r "getAdminClient" in web/lib/agent/ returns zero matches (agent core clean)
# Final: grep -r "getAdminClient" in web/bin/ returns zero matches (CLI clean)
# Final: getAdminClient still exists in web/lib/media/db.ts (it's a library function, used by tests)
# Final: getAdminClient still used in web/__tests__/integration/setup.ts (test-only)
```
