# TDD Plan: Full API Abstraction — DB/CLI Auth Decoupling

Testing framework: **Vitest** with two profiles (unit, integration). Existing patterns: `vi.mock()` for module mocking, `vi.stubEnv()` for env vars, mock Supabase client objects.

---

## Section 1: Refactor db.ts and Delete Barrel Export

### db.ts Client Factory Tests

```
# Test: getAdminClient creates client with provided url and serviceKey
# Test: getAdminClient throws when config is missing url
# Test: getAdminClient throws when config is missing serviceKey
# Test: getUserClient creates client with provided url and anonKey
# Test: getUserClient throws when config is missing url
```

### db.ts Data Function Tests (parameterized)

```
# Test: queryEvents accepts client as first param, passes it through to Supabase
# Test: queryEvents with search uses RPC with correct params
# Test: queryEvents normalizes enrichments join to single enrichment property
# Test: showEvent accepts client as first param, queries by eventId
# Test: showEvent scopes to userId when provided
# Test: getStats accepts client and optional { userId, deviceId }
# Test: getStats returns deviceId from opts, defaults to "default"
# Test: getStats no longer reads process.env.SMGR_DEVICE_ID
# Test: insertEvent accepts client as first param, uses admin client for insert
# Test: insertEvent retries on retryable errors via withRetryDb
# Test: insertEnrichment accepts client, eventId, result, optional userId
# Test: upsertWatchedKey accepts client and all params
# Test: getWatchedKeys accepts client and optional userId
# Test: findEventByHash accepts client, hash, optional userId
# Test: getPendingEnrichments accepts client, returns photos without enrichments
# Test: getModelConfig accepts client, userId, optional provider
```

### Barrel Export Removal Tests

```
# Test: importing from "@/lib/media" fails (module not found)
# Test: importing from "@/lib/media/db" succeeds
```

### Server-Side Consumer Tests

```
# Test: agent core creates admin client from env vars and passes to data functions
# Test: server action creates user client from env vars and passes to getStats
# Test: health route creates admin client from env vars
```

---

## Section 2: Create Auth Helper and Auth Endpoints

### requireAuth Tests

```
# Test: requireAuth returns { userId } when valid Bearer token provided
# Test: requireAuth returns 401 when Authorization header is missing
# Test: requireAuth returns 401 when Authorization header is not "Bearer <token>"
# Test: requireAuth returns 401 when token is expired (auth.getUser fails)
# Test: requireAuth returns 401 when token is for deleted/non-existent user
```

### Login Endpoint Tests

```
# Test: POST /api/auth/login with valid email/password returns 200 with session data
# Test: POST /api/auth/login with invalid credentials returns 401
# Test: POST /api/auth/login with missing email or password returns 400
# Test: GET /api/auth/login returns 405 Method Not Allowed
```

### Refresh Endpoint Tests

```
# Test: POST /api/auth/refresh with valid refresh_token returns 200 with new session
# Test: POST /api/auth/refresh with expired refresh_token returns 401
# Test: POST /api/auth/refresh with missing body returns 400
```

---

## Section 3: Create Data API Endpoints

### Query Endpoint Tests

```
# Test: GET /api/query with valid auth returns 200 with events array and count
# Test: GET /api/query passes userId from JWT to queryEvents (not from query params)
# Test: GET /api/query forwards search, type, since, until, limit, offset params
# Test: GET /api/query without auth returns 401
# Test: GET /api/query when db returns error returns 500
```

### Show Endpoint Tests

```
# Test: GET /api/show/[id] with valid auth returns 200 with event data
# Test: GET /api/show/[id] scopes to authenticated userId
# Test: GET /api/show/[id] returns 404 when event not found
# Test: GET /api/show/[id] without auth returns 401
```

### Add Endpoint Tests

```
# Test: POST /api/add with valid event body returns 201
# Test: POST /api/add sets user_id from JWT, not from request body
# Test: POST /api/add with duplicate content_hash returns 409
# Test: POST /api/add with missing required fields returns 400
# Test: POST /api/add without auth returns 401
```

### Stats Endpoint Tests

```
# Test: GET /api/stats returns 200 with stats object
# Test: GET /api/stats passes userId from JWT to getStats
# Test: GET /api/stats includes device_id: "web"
# Test: GET /api/stats?include=enrich_status includes enrichment status
```

### Enrich Endpoint Tests

```
# Test: GET /api/enrich returns 200 with pending enrichments array
# Test: POST /api/enrich with valid enrichment data returns 201
# Test: POST /api/enrich with missing event_id returns 400
# Test: both GET and POST require auth (401 without)
```

### Watch Endpoint Tests

```
# Test: GET /api/watch returns 200 with watched keys array
# Test: POST /api/watch with valid data returns 200
# Test: POST /api/watch upserts on conflict (same s3_key)
# Test: both GET and POST require auth (401 without)
```

### Find-by-Hash Endpoint Tests

```
# Test: GET /api/find-by-hash?hash=abc returns 200 with event id
# Test: GET /api/find-by-hash?hash=abc returns 200 with null when not found
# Test: GET /api/find-by-hash without hash param returns 400
```

### Model Config Endpoint Tests

```
# Test: GET /api/model-config returns 200 with decrypted config
# Test: GET /api/model-config?provider=openai filters by provider
# Test: GET /api/model-config returns null data when no config exists
# Test: api_key_encrypted is decrypted to api_key in response
```

### Error Mapping Tests

```
# Test: mapSupabaseError maps 23505 to 409
# Test: mapSupabaseError maps 23503 to 400
# Test: mapSupabaseError maps 42501 to 403
# Test: mapSupabaseError maps PGRST301 to 404
# Test: mapSupabaseError maps unknown codes to 500
```

---

## Section 4: Create API Client Class

### SmgrApiClient Constructor Tests

```
# Test: constructor sets baseUrl and optional token
# Test: setToken updates the Authorization header for subsequent requests
```

### SmgrApiClient.request Tests

```
# Test: request prepends baseUrl to path
# Test: request includes Authorization header when token is set
# Test: request includes Content-Type: application/json for POST requests
# Test: request parses JSON response on 2xx
# Test: request throws ApiError with status and message on 4xx
# Test: request throws ApiError with status and message on 5xx
```

### SmgrApiClient Auth Methods

```
# Test: login sends POST to /api/auth/login with email and password
# Test: login returns LoginResult on success
# Test: login throws ApiError on invalid credentials
# Test: refresh sends POST to /api/auth/refresh with refresh_token
# Test: refresh updates internal token on success
```

### SmgrApiClient Data Methods

```
# Test: query sends GET to /api/query with query params
# Test: show sends GET to /api/show/<id>
# Test: add sends POST to /api/add with event body
# Test: stats sends GET to /api/stats
# Test: getPendingEnrichments sends GET to /api/enrich
# Test: insertEnrichment sends POST to /api/enrich with body
# Test: getWatchedKeys sends GET to /api/watch
# Test: upsertWatchedKey sends POST to /api/watch with body
# Test: findEventByHash sends GET to /api/find-by-hash?hash=<hash>
# Test: getModelConfig sends GET to /api/model-config
```

### Auto-Refresh Tests

```
# Test: when request returns 401 and refreshToken exists, auto-refreshes and retries
# Test: when auto-refresh also returns 401, throws ApiError (no infinite loop)
# Test: when no refreshToken exists, 401 throws immediately without retry
```

---

## Section 5: Refactor Health Route

```
# Test: GET /api/health returns 200 with { status: "ok" } when db is reachable
# Test: GET /api/health returns 200 with { status: "degraded" } when db query fails
# Test: GET /api/health does not require auth
# Test: GET /api/health uses parameterized getAdminClient with server env vars
```

---

## Section 6: Rewrite smgr.ts (CLI)

### CLI Integration Tests

```
# Test: smgr login prompts for email/password, calls /api/auth/login, saves credentials
# Test: smgr query sends authenticated GET to /api/query
# Test: smgr show <id> sends authenticated GET to /api/show/<id>
# Test: smgr stats sends authenticated GET to /api/stats
# Test: smgr logout clears local credentials file
# Test: smgr whoami displays stored credentials
# Test: smgr <command> without login shows auth error with helpful message
# Test: smgr <command> with expired token shows re-login prompt (or auto-refreshes)
# Test: SMGR_API_URL configures the base URL for all requests
```

### cli-auth.ts Tests

```
# Test: resolveApiConfig is no longer exported (function deleted)
# Test: refreshSession is no longer exported (function deleted)
# Test: loadCredentials reads from ~/.sitemgr/credentials.json
# Test: saveCredentials writes to ~/.sitemgr/credentials.json with 0600 permissions
# Test: clearCredentials removes credentials file
# Test: cli-auth.ts no longer imports from @supabase/supabase-js
```

---

## Section 7: Update Agent Core and Server Actions

### Agent Core Tests

```
# Test: resolveUserId creates admin client from env vars and queries user_profiles
# Test: executeAction passes parameterized client to all db functions
# Test: getConversationHistory uses parameterized admin client
# Test: saveConversationHistory uses parameterized admin client
# Test: agent core does not import from cli-auth
# Test: encryption operations (encryptSecretVersioned, decryptSecretVersioned) unchanged
```

### Server Action Tests

```
# Test: sendMessage creates user client from env vars
# Test: sendMessage passes client to getStats
# Test: sendMessage does not import from cli-auth
```

---

## Section 8: Cleanup and Documentation

```
# Test: no files import from "@/lib/media" (barrel deleted)
# Test: no files in lib/media/ import from cli-auth
# Test: grep for "resolveApiConfig" returns zero results outside of test files
# Test: grep for "SMGR_API_KEY" returns zero results outside of test/doc files
```
