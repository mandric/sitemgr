# Spec 18: CLI Web API Only — Implementation Plan

## Summary

Move the CLI from direct Supabase access to using Next.js web API routes exclusively.
Phase 1 (login) is already done. This plan covers phases 2-4.

## Sections

### Section 1: Bearer Token Auth Helper
Create a server-side helper that authenticates API requests using `Authorization: Bearer <access_token>` headers. This is the foundation all new API routes depend on.

- File: `web/lib/supabase/api-auth.ts`
- Creates a Supabase client authenticated with the caller's JWT
- Returns `{ supabase, user }` or error response
- Tests: unit test with mocked Supabase client

### Section 2: Auth API Routes
Add routes for token refresh and session validation so the CLI no longer needs a direct Supabase client for auth operations.

- `POST /api/auth/refresh` — accepts refresh_token, returns new session
- `GET /api/auth/session` — validates Bearer token, returns user info
- Update `refreshSession()` in `cli-auth.ts` to call web API
- Tests: unit tests for each route

### Section 3: Data API Routes
Add API routes that wrap existing db.ts functions, authenticated via Bearer token.

- `GET /api/events` — query/search (wraps `queryEvents`)
- `GET /api/events/[id]` — show single event (wraps `showEvent`)
- `POST /api/events` — insert event (wraps `insertEvent`)
- `GET /api/stats` — aggregate stats (wraps `getStats`)
- `GET /api/enrichments/status` — enrichment counts (wraps `getEnrichStatus`)
- `GET /api/enrichments/pending` — pending items (wraps `getPendingEnrichments`)
- `POST /api/enrichments` — save enrichment result (wraps `insertEnrichment`)
- `GET /api/watched-keys` — list watched keys (wraps `getWatchedKeys`)
- `POST /api/watched-keys` — upsert watched key (wraps `upsertWatchedKey`)
- `GET /api/events/by-hash/[hash]` — find event by hash (wraps `findEventByHash`)
- `GET /api/model-config` — fetch model config (wraps `getModelConfig`)
- Tests: unit tests for routes

### Section 4: Update CLI to Use Web API
Replace all direct Supabase calls in `smgr.ts` with fetch calls to the new API routes.

- Remove `getClient()` function (no more Supabase client in CLI)
- Remove `getUserClient` import from CLI
- Add `apiFetch()` helper in CLI for authenticated requests
- Update each command: `cmdQuery`, `cmdShow`, `cmdStats`, `cmdEnrich`, `cmdWatch`, `cmdAdd`
- `getModelConfig` call at startup uses API
- S3 operations remain direct (per spec)
- Tests: update CLI integration tests

### Section 5: Clean Up Env Vars
Consolidate to single `SITEMGR_URL` env var for CLI. Remove `SMGR_API_URL` and `SMGR_API_KEY`.

- Rename `SMGR_WEB_URL` to `SITEMGR_URL` in cli-auth.ts
- Remove `SMGR_API_URL` / `SMGR_API_KEY` from `resolveApiConfig()`
- Update `resolveApiConfig()` to return only `{ url: string }`
- Remove Supabase client creation import from cli-auth.ts
- Update help text, env var docs in CLI
- Update `.env.example`, test fixtures
- Tests: update unit tests for cli-auth

## Dependencies

Section 1 → Section 2, Section 3 (auth helper needed by all routes)
Section 2 + Section 3 → Section 4 (routes must exist before CLI uses them)
Section 4 → Section 5 (CLI must use web API before removing old env vars)
