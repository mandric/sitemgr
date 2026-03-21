# Implementation Plan: Full API Abstraction — DB/CLI Auth Decoupling

## Background

The sitemgr project has a web app (Next.js on Vercel) and a CLI (`smgr`). Both currently import `db.ts` for Supabase access, but `db.ts` imports `cli-auth.ts` which uses Node-native modules (`node:fs`, `node:os`, `node:readline`) and calls `homedir()` at module scope. This breaks all web consumers at import time in Vercel.

The architectural fix goes beyond removing the import: the CLI should not access Supabase directly at all. Only the web API should know about Supabase. The CLI becomes an HTTP client to command-oriented API endpoints. Server-side consumers (agent core, server actions) continue to use `db.ts` directly via parameterized client factories.

## Goals

1. **db.ts has zero dependency on cli-auth.ts** — client factories accept config as parameters
2. **New API endpoints** for every data operation the CLI needs
3. **CLI (`smgr.ts`) is a pure HTTP client** — no db.ts imports, calls web API endpoints
4. **Agent core and server actions keep direct db.ts access** — they run server-side, no HTTP overhead
5. **CLI authenticates via JWT** — `/api/auth/login` endpoint, Bearer token on subsequent requests
6. **Token refresh endpoint** — `/api/auth/refresh` to handle Supabase's 1-hour JWT expiry
7. **Barrel export `lib/media/index.ts` is deleted** early in the process
8. **All existing tests pass** (updated alongside each section)

## Architectural Decisions

### Agent core stays on direct db.ts

Agent core (`lib/agent/core.ts`) and server actions (`components/agent/actions.ts`) run server-side on the same Vercel deployment. Routing them through HTTP would add latency, cold start amplification, and an artificial authentication problem. Once db.ts is parameterized, these consumers pass config from env vars directly.

### userId comes from JWT at the API boundary

API routes extract `userId` from the Bearer token via `supabase.auth.getUser()`. No `userId` query parameters — the JWT is the sole source of user identity. This eliminates cross-user authorization concerns.

### `{ data, error }` shape at boundaries

**db.ts (DAL):** Preserves Supabase's `{ data, error }` shape per CLAUDE.md coding principles.

**API routes → HTTP:** Translates to standard HTTP status codes (200, 400, 401, 404, 500) with JSON body. This is a deliberate deviation at the HTTP boundary — Supabase's shape doesn't map naturally to HTTP, and the CLI expects thrown errors.

**API client:** Throws `ApiError` on non-2xx. Callers use try/catch, not `{ data, error }` destructuring.

## Section 1: Refactor db.ts and Delete Barrel Export

### What Changes

1. Remove the `cli-auth` import from `db.ts` (line 12)
2. Parameterize `getAdminClient()` and `getUserClient()` to accept config
3. Remove `getAuthenticatedClient()` entirely (CLI auth goes through `/api/auth/login`)
4. Make `device_id` in `getStats()` a parameter instead of reading `process.env.SMGR_DEVICE_ID`
5. Pass Supabase client as first parameter to all data functions
6. Delete `lib/media/index.ts` barrel export
7. Update all imports from `@/lib/media` to `@/lib/media/db`

### Client Factory Signatures (After)

```typescript
interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

interface SupabaseUserConfig {
  url: string;
  anonKey: string;
}

function getAdminClient(config: SupabaseConfig): SupabaseClient
function getUserClient(config: SupabaseUserConfig): SupabaseClient
```

### Data Function Signatures (After)

Each data function receives the appropriate client as its first parameter:

```typescript
function queryEvents(client: SupabaseClient, opts: QueryOptions): Promise<...>
function showEvent(client: SupabaseClient, eventId: string, userId?: string): Promise<...>
function getStats(client: SupabaseClient, opts?: { userId?: string; deviceId?: string }): Promise<...>
function getEnrichStatus(client: SupabaseClient, userId?: string): Promise<...>
function insertEvent(client: SupabaseClient, event: ...): Promise<...>
function insertEnrichment(client: SupabaseClient, eventId: string, result: ..., userId?: string): Promise<...>
function upsertWatchedKey(client: SupabaseClient, ...): Promise<...>
function getWatchedKeys(client: SupabaseClient, userId?: string): Promise<...>
function findEventByHash(client: SupabaseClient, hash: string, userId?: string): Promise<...>
function getPendingEnrichments(client: SupabaseClient, userId?: string): Promise<...>
function getModelConfig(client: SupabaseClient, userId: string, provider?: string): Promise<...>
```

### Updating Server-Side Consumers

**Agent core (`lib/agent/core.ts`):** Creates admin client once at the top of each request handler:
```typescript
const adminConfig = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
};
const client = getAdminClient(adminConfig);
```
Then passes `client` to all data functions.

**Server actions (`components/agent/actions.ts`):** Same pattern with user client:
```typescript
const userConfig = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
};
const client = getUserClient(userConfig);
```

**Health route:** Parameterized admin client (see Section 5).

### Tests for Section 1

Update `__tests__/db-operations.test.ts`:
- Remove `vi.stubEnv()` for `SMGR_API_URL` / `SMGR_API_KEY`
- Create mock Supabase client directly and pass it to each function
- Still mock `createClient` from `@supabase/supabase-js` for client factory tests
- Add test for `getStats` with explicit `deviceId` parameter

Update `__tests__/integration/` tests that import from `@/lib/media` to import from `@/lib/media/db`.

## Section 2: Create Auth Helper and Auth Endpoints

### Auth Helper (`lib/api/auth.ts`)

```typescript
async function requireAuth(request: NextRequest): Promise<{ userId: string } | NextResponse>
```

Steps:
1. Extract `Authorization: Bearer <token>` from request headers
2. Create Supabase server client with `createServerClient(url, anonKey, ...)`
3. Call `supabase.auth.getUser()` — this validates the JWT server-side
4. Return `{ userId: user.id }` on success
5. Return `NextResponse.json({ error: "Unauthorized" }, { status: 401 })` on failure

### Login Endpoint (`app/api/auth/login/route.ts`)

**Request:**
```typescript
POST /api/auth/login
Content-Type: application/json

{ "email": "user@example.com", "password": "..." }
```

**Success Response (200):**
```typescript
{
  "access_token": "eyJ...",
  "refresh_token": "abc...",
  "user_id": "uuid",
  "email": "user@example.com",
  "expires_at": 1234567890
}
```

**Error Response (401):**
```typescript
{ "error": "Invalid credentials" }
```

Implementation: Create Supabase client with anon key, call `signInWithPassword`, return session data.

### Refresh Endpoint (`app/api/auth/refresh/route.ts`)

**Request:**
```typescript
POST /api/auth/refresh
Content-Type: application/json

{ "refresh_token": "abc..." }
```

**Success Response (200):**
```typescript
{
  "access_token": "eyJ...",
  "refresh_token": "new-abc...",
  "user_id": "uuid",
  "email": "user@example.com",
  "expires_at": 1234567890
}
```

**Error Response (401):**
```typescript
{ "error": "Token refresh failed" }
```

Implementation: Create Supabase client, call `supabase.auth.refreshSession({ refresh_token })`.

### Tests for Section 2

- `requireAuth`: Test with missing header, malformed header ("Basic" instead of "Bearer"), expired token (mock auth.getUser to fail), valid token
- Login endpoint: Test happy path, missing email/password (400), invalid credentials (401)
- Refresh endpoint: Test happy path, expired refresh token (401), missing body (400)

## Section 3: Create Data API Endpoints

### Shared Helpers

A `getServerConfig()` function returns the Supabase config from env vars — used by all route handlers:

```typescript
function getServerConfig(): SupabaseConfig {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}
```

### Query Endpoint (`app/api/query/route.ts`)

**Request:**
```
GET /api/query?limit=20&offset=0&type=photo&since=2024-01-01&until=2024-12-31&search=sunset&device=iphone
Authorization: Bearer <token>
```

All query params are optional.

**Success Response (200):**
```typescript
{
  "data": EventRow[],  // with normalized enrichment field
  "count": number
}
```

**Error Response:** 401 (no auth), 500 (db error)

Implementation: Call `requireAuth`, extract query params, call `queryEvents(client, opts)` with `userId` from auth.

### Show Endpoint (`app/api/show/[id]/route.ts`)

**Request:**
```
GET /api/show/<event-id>
Authorization: Bearer <token>
```

**Success Response (200):**
```typescript
{ "data": EventRow }  // with normalized enrichment
```

**Error Responses:** 401 (no auth), 404 (not found), 500 (db error)

### Add Endpoint (`app/api/add/route.ts`)

**Request:**
```typescript
POST /api/add
Authorization: Bearer <token>
Content-Type: application/json

{
  "id": "uuid",
  "device_id": "string",
  "type": "create",
  "content_type": "photo" | "video" | "note" | null,
  "content_hash": "string" | null,
  "local_path": "string" | null,
  "remote_path": "string" | null,
  "metadata": {} | null,
  "parent_id": "uuid" | null,
  "bucket_config_id": "uuid" | null,
  "timestamp": "ISO8601" | null  // optional, defaults to now
}
```

**Success Response (201):** `{}`

**Error Responses:** 400 (missing fields), 401 (no auth), 409 (duplicate), 500 (db error)

Implementation: Call `requireAuth`, parse body, call `insertEvent(client, { ...body, user_id: auth.userId })`.

### Stats Endpoint (`app/api/stats/route.ts`)

**Request:**
```
GET /api/stats
Authorization: Bearer <token>
```

**Success Response (200):**
```typescript
{
  "total_events": number,
  "by_content_type": Record<string, number>,
  "by_event_type": Record<string, number>,
  "watched_s3_keys": number,
  "enriched": number,
  "pending_enrichment": number,
  "device_id": "web"  // hardcoded for web context
}
```

Also supports `GET /api/stats?include=enrich_status` to include enrichment status in the same response (combines `getStats` + `getEnrichStatus`).

### Enrich Endpoint (`app/api/enrich/route.ts`)

**GET /api/enrich** — Get pending enrichments

**Response (200):**
```typescript
{ "data": Array<{ id, content_hash, content_type, local_path, remote_path, metadata }> }
```

**POST /api/enrich** — Insert enrichment result

**Request:**
```typescript
{
  "event_id": "uuid",
  "description": "string",
  "objects": ["string"],
  "context": "string",
  "suggested_tags": ["string"]
}
```

**Response (201):** `{}`

### Watch Endpoint (`app/api/watch/route.ts`)

**GET /api/watch** — List watched keys

**Response (200):**
```typescript
{ "data": Array<{ s3_key: string }> }
```

**POST /api/watch** — Upsert watched key

**Request:**
```typescript
{
  "s3_key": "string",
  "event_id": "uuid" | null,
  "etag": "string",
  "size_bytes": number,
  "bucket_config_id": "uuid" | null
}
```

**Response (200):** `{}`

### Find-by-Hash Endpoint (`app/api/find-by-hash/route.ts`)

**Request:**
```
GET /api/find-by-hash?hash=<content_hash>
Authorization: Bearer <token>
```

**Response (200):**
```typescript
{ "data": { "id": "uuid" } | null }
```

### Model Config Endpoint (`app/api/model-config/route.ts`)

**Request:**
```
GET /api/model-config?provider=<provider>
Authorization: Bearer <token>
```

**Response (200):**
```typescript
{ "data": ModelConfigRow | null }
```

Note: The API route handles decryption of `api_key_encrypted` before returning it, since encryption keys are server-side only. Returns `api_key` (plaintext) instead of `api_key_encrypted`.

### Error Mapping Helper

```typescript
function mapSupabaseError(error: unknown): { status: number; message: string }
```

Maps Supabase error codes to HTTP status:
- `23505` → 409 Conflict
- `23503` → 400 Bad Request (foreign key violation)
- `42501` → 403 Forbidden
- `PGRST301`/`PGRST302` → 404 Not Found
- Other → 500 Internal Server Error

### Tests for Section 3

For each endpoint:
- Mock db.ts functions via `vi.mock("@/lib/media/db")`
- Mock `requireAuth` to return `{ userId: "test-user" }`
- Test happy path returns correct status and shape
- Test db error returns mapped HTTP status
- Test missing/invalid request parameters return 400

## Section 4: Create API Client Class

### Location

`web/lib/api/client.ts` — used by CLI only (not agent core).

### Interface

```typescript
class SmgrApiClient {
  constructor(baseUrl: string, options?: { token?: string })

  // Auth
  login(email: string, password: string): Promise<LoginResult>
  refresh(refreshToken: string): Promise<LoginResult>

  // Data operations (no userId params — JWT identifies the user)
  query(opts?: QueryOpts): Promise<QueryResult>
  show(id: string): Promise<EventWithEnrichments>
  add(event: EventInput): Promise<void>
  stats(): Promise<StatsResult>
  getPendingEnrichments(): Promise<PendingEnrichment[]>
  insertEnrichment(eventId: string, result: EnrichmentInput): Promise<void>
  getWatchedKeys(): Promise<WatchedKey[]>
  upsertWatchedKey(input: WatchedKeyInput): Promise<void>
  findEventByHash(hash: string): Promise<{ id: string } | null>
  getModelConfig(provider?: string): Promise<ModelConfig | null>
  health(): Promise<HealthResult>

  // Internal
  private request<T>(path: string, opts?: RequestInit): Promise<T>
  setToken(token: string): void  // update token after login/refresh
}
```

### Error Type

```typescript
class ApiError extends Error {
  status: number;
  details?: string;
}
```

### Token Auto-Refresh

The `request()` method checks for 401 responses. If the client has a `refreshToken`, it automatically calls `refresh()` and retries the original request once. This handles the 1-hour JWT expiry transparently.

### Tests for Section 4

Mock `globalThis.fetch`. For each method:
- Verify correct URL, HTTP method, headers, body
- Verify response parsing on success
- Verify `ApiError` thrown on 4xx/5xx with correct status and message
- Test auto-refresh: mock first request returning 401, then refresh succeeding, then retry succeeding

## Section 5: Refactor Health Route

Update `app/api/health/route.ts`:
1. Import parameterized `getAdminClient` from `@/lib/media/db`
2. Create client with server env vars
3. Query events table for connectivity check
4. Return `{ status: "ok" | "degraded" }`

### Tests for Section 5

Mock db.ts `getAdminClient`, verify health route returns 200 with `{ status: "ok" }` or `{ status: "degraded" }` based on Supabase response.

## Section 6: Rewrite smgr.ts (CLI)

### After Rewrite

`smgr.ts` imports:
- `SmgrApiClient` from `lib/api/client.ts`
- `loadCredentials`, `clearCredentials`, `saveCredentials` from `lib/auth/cli-auth.ts` (local credential storage only)
- Prompt helpers from `cli-auth.ts`
- No db.ts imports

### CLI Initialization

```
const baseUrl = process.env.SMGR_API_URL || "https://sitemgr.vercel.app";
const creds = loadCredentials();
const api = new SmgrApiClient(baseUrl, { token: creds?.access_token });
```

`SMGR_API_URL` now points to the **web app URL** (not Supabase). In local dev: `http://localhost:3000`. In production: the Vercel deployment URL.

### Command Mapping

| CLI Command | Before (db.ts) | After (API client) |
|-------------|----------------|-------------------|
| `smgr query` | `queryEvents(opts)` | `api.query(opts)` |
| `smgr show <id>` | `showEvent(id, userId)` | `api.show(id)` |
| `smgr add` | `insertEvent(event)` | `api.add(event)` |
| `smgr stats` | `getStats(userId)` | `api.stats()` |
| `smgr enrich` | `getPendingEnrichments()` | `api.getPendingEnrichments()` |
| `smgr watch` | `getWatchedKeys()`, `upsertWatchedKey()` | `api.getWatchedKeys()`, `api.upsertWatchedKey()` |
| `smgr login` | `login()` (direct Supabase) | prompt email/password, call `api.login()`, `saveCredentials()` |
| `smgr logout` | `clearCredentials()` | `clearCredentials()` (unchanged) |
| `smgr whoami` | `loadCredentials()` | `loadCredentials()` (unchanged) |

### Changes to cli-auth.ts

- **Delete:** `resolveApiConfig()`, `refreshSession()`, `login()` (moved to CLI using API client)
- **Keep:** `loadCredentials()`, `saveCredentials()`, `clearCredentials()`, `whoami()`, `StoredCredentials`, `ensureConfigDir()`, prompt helpers
- **Remove import:** `createClient` from `@supabase/supabase-js` (no longer needed)

### Environment Variables After Migration

| Env Var | Before | After |
|---------|--------|-------|
| `SMGR_API_URL` | Supabase URL | Web app URL (e.g., `http://localhost:3000`) |
| `SMGR_API_KEY` | Supabase anon key | **Deleted** |
| `SUPABASE_SECRET_KEY` | Service role key on CLI | **Deleted from CLI** — only web API needs it |

### Tests for Section 6

Rewrite `smgr-cli.test.ts`:
- Spawn CLI child process with `SMGR_API_URL` pointing to a running dev server (or mock HTTP server)
- Test `smgr login` → verify HTTP POST to `/api/auth/login`
- Test `smgr query` → verify HTTP GET to `/api/query` with correct auth header
- Test `smgr stats` → verify HTTP GET to `/api/stats`
- Test expired token → verify 401 handling and helpful error message

## Section 7: Update Agent Core and Server Actions

### Agent Core (`lib/agent/core.ts`)

Agent core **keeps direct db.ts access**. Changes needed:

1. Replace `import { getAdminClient, queryEvents, ... } from "@/lib/media/db"` — same imports, just parameterized
2. Create admin client config from env vars at the top of each handler
3. Pass client to all data function calls

Example before/after for `resolveUserId`:
```
// Before
const supabase = getAdminClient();

// After
const client = getAdminClient({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
});
```

All 9 imported data functions get `client` as first parameter. Encryption operations (`encryptSecretVersioned`, `decryptSecretVersioned`) are unchanged.

### Server Actions (`components/agent/actions.ts`)

Replace:
```
import { getStats } from "@/lib/media/db";
const { data: stats } = await getStats(user.id);
```
With:
```
import { getStats, getUserClient } from "@/lib/media/db";
const client = getUserClient({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
});
const { data: stats } = await getStats(client, user.id);
```

### Tests for Section 7

- Update agent core tests to provide parameterized config instead of env var stubs
- Update server action tests similarly

## Section 8: Cleanup and Documentation

### Delete Barrel Export

Already done in Section 1 (moved early per review feedback).

### Update Env Var Documentation

Update `docs/ENV_VARS.md`:
- Document `SMGR_API_URL` new meaning (web app URL, not Supabase URL)
- Remove `SMGR_API_KEY` and `SUPABASE_SECRET_KEY` from CLI-related docs
- Add note about CLI JWT auth flow

### Verify No Remaining cli-auth Imports in db.ts

Run a final check: `grep -r "cli-auth" web/lib/media/` should return nothing.

## Migration Execution Order

Big bang — all in one PR, but implement in this order:

1. **Section 1:** Refactor db.ts + delete barrel + update server-side consumers + update db tests
2. **Section 2:** Auth helper + login/refresh endpoints + auth tests
3. **Section 3:** Data API endpoints + endpoint tests
4. **Section 4:** API client class + client tests
5. **Section 5:** Refactor health route + health tests
6. **Section 6:** Rewrite smgr.ts + update cli-auth.ts + CLI tests
7. **Section 7:** Update agent core + server actions + their tests
8. **Section 8:** Cleanup, documentation, final verification

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Token expiry mid-CLI-session | CLI commands fail with 401 | `/api/auth/refresh` endpoint + auto-refresh in API client |
| Large blast radius (big bang) | Hard to bisect if something breaks | Implement in ordered commits. Run full test suite at each step. |
| S3 operations in agent core | Agent core does S3 operations that don't go through db.ts | S3 operations use `createS3Client` from `lib/s3`. Not affected. |
| `getModelConfig` returns encrypted API keys | CLI would receive encrypted data it can't decrypt | API endpoint decrypts before returning to CLI. Encryption keys are server-side only. |
| Vercel cold starts for new API routes | New serverless functions need cold start | Each route is small (few KB). Cold starts are ~100-200ms for Node.js. Acceptable. |
| `process.env.SMGR_DEVICE_ID` in getStats | CLI-specific env var in server DAL | Made into a parameter. API route passes "web", CLI passes from env or "cli". |
