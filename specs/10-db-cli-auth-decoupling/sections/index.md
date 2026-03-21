<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: npm test
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-refactor-db
section-02-auth-helper
section-03-api-endpoints
section-04-api-client
section-05-health-route
section-06-rewrite-cli
section-07-update-server-consumers
section-08-cleanup
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-refactor-db | - | 02, 03, 05, 07 | Yes |
| section-02-auth-helper | 01 | 03 | No |
| section-03-api-endpoints | 01, 02 | 04, 06 | No |
| section-04-api-client | 03 | 06 | No |
| section-05-health-route | 01 | - | Yes |
| section-06-rewrite-cli | 03, 04 | 08 | No |
| section-07-update-server-consumers | 01 | 08 | Yes |
| section-08-cleanup | 06, 07 | - | No |

## Execution Order

1. section-01-refactor-db (no dependencies)
2. section-02-auth-helper, section-05-health-route, section-07-update-server-consumers (parallel after 01)
3. section-03-api-endpoints (after 01 AND 02)
4. section-04-api-client (after 03)
5. section-06-rewrite-cli (after 03 AND 04)
6. section-08-cleanup (after 06 AND 07)

## Section Summaries

### section-01-refactor-db
Remove cli-auth import from db.ts. Parameterize client factories to accept config. Pass Supabase client as first param to all data functions. Make device_id a parameter in getStats. Delete barrel export lib/media/index.ts. Update all imports from @/lib/media to @/lib/media/db. Update db unit tests.

### section-02-auth-helper
Create lib/api/auth.ts with requireAuth() helper that extracts userId from Bearer JWT via Supabase server-side auth. Create POST /api/auth/login endpoint (email/password → JWT). Create POST /api/auth/refresh endpoint (refresh_token → new JWT). Write auth tests.

### section-03-api-endpoints
Create command-oriented API endpoints: /api/query (GET), /api/show/[id] (GET), /api/add (POST), /api/stats (GET), /api/enrich (GET/POST), /api/watch (GET/POST), /api/find-by-hash (GET), /api/model-config (GET). Each uses requireAuth, creates parameterized db client, calls db.ts functions, returns HTTP status codes. Create error mapping helper. Write endpoint tests.

### section-04-api-client
Create lib/api/client.ts with SmgrApiClient class. Thin fetch wrapper with auth headers, base URL, JSON parsing, error handling. Methods for each API endpoint. Auto-refresh on 401 if refreshToken available. ApiError class for typed errors. Write client tests with mocked fetch.

### section-05-health-route
Refactor app/api/health/route.ts to use parameterized getAdminClient with server env vars. No auth required. Keep existing "ok"/"degraded" logic. Write health route tests.

### section-06-rewrite-cli
Replace all db.ts imports in smgr.ts with SmgrApiClient calls. Update login flow: prompt email/password → api.login() → saveCredentials(). Remove db.ts and @supabase/supabase-js imports. Update cli-auth.ts: delete resolveApiConfig(), refreshSession(), login(). Keep credential storage functions. SMGR_API_URL now points to web app URL. Remove SMGR_API_KEY. Rewrite CLI integration tests.

### section-07-update-server-consumers
Update agent core (lib/agent/core.ts): create admin client from env vars, pass to all db functions. Update server actions (components/agent/actions.ts): create user client from env vars, pass to getStats. These stay on direct db.ts access — no HTTP. Update their tests.

### section-08-cleanup
Final verification: no cli-auth imports in db.ts, no barrel export references, no SMGR_API_KEY usage. Update docs/ENV_VARS.md. Run full test suite.
