<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: cd web && npm test
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-es256-workaround
section-02-health-endpoint
section-03-agent-core-refactor
section-04-webhook-service-account
section-05-cli-user-client
section-06-instrumentation
section-07-env-var-rename
section-08-test-app-layer
section-09-dev-server-setup
section-10-ci-workflow
section-11-config-docs
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-es256-workaround | - | 07, 10 | Yes |
| section-02-health-endpoint | - | 09 | Yes |
| section-03-agent-core-refactor | - | 04 | No |
| section-04-webhook-service-account | 03 | 10 | No |
| section-05-cli-user-client | - | 07 | Yes |
| section-06-instrumentation | - | 11 | Yes |
| section-07-env-var-rename | 01, 05 | 08, 10 | No |
| section-08-test-app-layer | 07 | 10 | No |
| section-09-dev-server-setup | 02 | 10 | No |
| section-10-ci-workflow | 04, 07, 08, 09 | 11 | No |
| section-11-config-docs | 06, 10 | - | No |

## Execution Order

1. **Batch 1** (no dependencies — parallelizable):
   - section-01-es256-workaround
   - section-02-health-endpoint
   - section-05-cli-user-client
   - section-06-instrumentation

2. **Batch 2** (after batch 1):
   - section-03-agent-core-refactor
   - section-07-env-var-rename (depends on 01, 05)

3. **Batch 3** (after batch 2):
   - section-04-webhook-service-account (depends on 03)
   - section-08-test-app-layer (depends on 07)
   - section-09-dev-server-setup (depends on 02)

4. **Batch 4** (after batch 3):
   - section-10-ci-workflow (depends on 04, 07, 08, 09)

5. **Batch 5** (final):
   - section-11-config-docs (depends on 06, 10)

## Section Summaries

### section-01-es256-workaround
Remove the ES256 JWT workaround from `scripts/local-dev.sh` (lines 61–91). Delete the Docker container introspection that hand-signs JWTs. Add a capability probe to verify the service role key works with GoTrue. Update the env var output to comment out the service role key.

### section-02-health-endpoint
Switch `web/app/api/health/route.ts` from `getAdminClient()` with `SUPABASE_SERVICE_ROLE_KEY` to `getUserClient()` with the anon key. The health check only needs DB connectivity, not elevated privileges.

### section-03-agent-core-refactor
Refactor `web/lib/agent/core.ts` to accept a `SupabaseClient` parameter instead of creating admin clients internally. Remove the internal `createAdminClient()` function. Update all ~15 call sites. Update callers: `components/agent/actions.ts` passes the user's server client; `app/api/whatsapp/route.ts` passes a webhook client (implemented in section 04).

### section-04-webhook-service-account
Create a Supabase migration that adds a webhook service account user (`webhook@sitemgr.internal`) with narrowly-scoped RLS policies for cross-user access. Grant `get_user_id_from_phone` to the `authenticated` role. Update `app/api/whatsapp/route.ts` to authenticate as the webhook service account.

### section-05-cli-user-client
Switch `web/bin/smgr.ts` from `getAdminClient()` to `getUserClient()` with the stored JWT from `smgr login`. Make `getClient()` async. Remove all `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` references from the CLI. Update help text.

### section-06-instrumentation
Remove `SUPABASE_SECRET_KEY` from the required env vars list in `web/instrumentation.ts`. Update the comment in `cli-auth.ts` that references the old name.

### section-07-env-var-rename
Rename all remaining `SUPABASE_SECRET_KEY` references to `SUPABASE_SERVICE_ROLE_KEY` in test files (`setup.ts`, `smgr-cli.test.ts`, `smgr-e2e.test.ts`), config files (`.env.example`), scripts (`verify.sh`), and documentation.

### section-08-test-app-layer
Refactor `media-lifecycle.test.ts` to use `insertEvent()`, `queryEvents()` etc. from `db.ts` instead of raw `admin.from("events").insert()`. Leave `tenant-isolation.test.ts` as-is (intentionally raw for RLS testing).

### section-09-dev-server-setup
Add Next.js dev server spawning to `web/__tests__/integration/globalSetup.ts`. Detect if port 3000 is in use, spawn `npm run dev` if not, poll `/api/health` until ready (60s timeout), store process on `globalThis.__WEB_SERVER__`, kill in teardown.

### section-10-ci-workflow
Update `.github/workflows/ci.yml`: rename `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY` in integration test and deployment jobs. Add webhook service account env vars if needed.

### section-11-config-docs
Update `.env.example` files, `docs/ENV_VARS.md`, `docs/QUICKSTART.md`, `docs/DEPLOYMENT.md`, `INTEGRATION_TESTS_SETUP.md`, and `CLAUDE.md` to reflect the new architecture: service role key is test/admin only, app code uses anon key + user JWT.
