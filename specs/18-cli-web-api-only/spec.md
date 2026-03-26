# Spec 18: CLI talks only to web API (no direct Supabase)

## Problem

The CLI (`smgr.ts`) creates Supabase clients directly and calls Supabase REST/Auth APIs. This means:

1. **The CLI knows about Supabase** — an implementation detail that should be hidden behind the web API
2. **Two URLs needed** — `SMGR_API_URL` currently points to Supabase (`http://127.0.0.1:54321`), but the device code flow (spec 16) needs the Next.js web app URL (`http://localhost:3000`). This is a **bug** — `login()` calls `/api/auth/device/*` routes using the Supabase URL, which doesn't serve those routes.
3. **Auth token management leaks** — the CLI calls `verifyOtp`, `refreshSession`, `setSession` directly against Supabase Auth. These should be web API responsibilities.

## Goal

The CLI should have a single env var pointing to the web API. All operations go through Next.js API routes. Supabase is invisible to the CLI.

## Current state (what the CLI does directly against Supabase)

### Auth operations (cli-auth.ts)
- `login()` → calls `verifyOtp` on a Supabase client (should be done server-side by poll endpoint)
- `refreshSession()` → calls `supabase.auth.refreshSession()` directly
- `getClient()` in smgr.ts → calls `supabase.auth.setSession()` to set access/refresh tokens

### Data operations (smgr.ts via db.ts)
- `queryEvents()` → direct Supabase query
- `showEvent()` → direct Supabase query
- `getStats()` → direct Supabase RPC
- `getEnrichStatus()` / `getPendingEnrichments()` → direct Supabase queries
- `insertEvent()` / `insertEnrichment()` → direct Supabase inserts
- `upsertWatchedKey()` / `getWatchedKeys()` / `findEventByHash()` → direct Supabase operations
- `getModelConfig()` → direct Supabase query
- S3 operations (listS3Objects, downloadS3Object, uploadS3Object) → direct S3 calls (separate concern, not Supabase)

## Proposed changes

### Phase 1: Fix the login bug (blocking — spec 16 is broken without this)

1. **Move `verifyOtp` server-side**: The poll endpoint (`POST /api/auth/device/token`) should call `verifyOtp` when status is `approved` and return the full session (`access_token`, `refresh_token`, `expires_at`, `user_id`, `email`) directly. The CLI saves credentials without ever touching Supabase.

2. **Add `SMGR_WEB_URL`** (or rename `SMGR_API_URL`): Point the CLI at the Next.js app. The CLI's `login()` only needs fetch calls to `/api/auth/device/*`.

3. **Remove Supabase imports from cli-auth.ts login path**: No `createClient`, no `verifyOtp`.

### Phase 2: Move auth operations to web API

4. **Add `POST /api/auth/refresh`**: Accepts refresh_token, returns new session. CLI calls this instead of `supabase.auth.refreshSession()`.

5. **Add `POST /api/auth/session`**: Validates an access_token and returns user info. Replaces the CLI's `setSession` call.

6. **Update `refreshSession()` in cli-auth.ts**: Call the web API instead of Supabase directly.

### Phase 3: Move data operations to web API

7. **Add API routes for each CLI command**:
   - `GET /api/events` (query, show)
   - `GET /api/stats`
   - `GET /api/enrichments` (status, pending)
   - `POST /api/events` (insert)
   - `POST /api/enrichments` (insert)
   - `GET /api/watched-keys` / `POST /api/watched-keys`
   - `GET /api/model-config`

8. **Update smgr.ts commands**: Replace direct Supabase client usage with fetch calls to the web API.

9. **Remove `getUserClient` / Supabase client creation from CLI**: The CLI becomes a pure HTTP client.

### Phase 4: Clean up env vars

10. **Single CLI env var**: `SITEMGR_URL` (or `SITEMGR_WEB_URL`) pointing to the Next.js app. Remove `SMGR_API_KEY` (anon key) from CLI — the web API handles auth internally.

## Priority

- **Phase 1 is urgent** — the device code login (spec 16) is broken without it
- **Phases 2-4 are important** but can be done incrementally

## Notes

- S3 operations (watch, add commands) are a separate concern — the CLI talks directly to S3, not through the web API. This is acceptable for v1.
- The web API routes in phases 2-3 are authenticated via the access_token in an Authorization header (not cookies — the CLI doesn't have a browser session).
- This spec overlaps with spec 17 (rename smgr → sitemgr). Phase 4 env var cleanup should coordinate with that rename.
- The existing `db.ts` query functions are still used by the web app's own API routes — they don't go away, the CLI just stops calling them directly.
