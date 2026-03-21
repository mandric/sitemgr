# Section 4: Create API Client Class

## Context

The CLI (`smgr.ts`) currently imports `db.ts` directly and talks to Supabase. After this decoupling work, the CLI becomes a pure HTTP client that calls the web API endpoints created in Sections 2 and 3. This section builds `SmgrApiClient` -- the single module the CLI uses for all server communication.

The client is a thin `fetch` wrapper. It handles:
- Base URL prefixing and JSON serialization/deserialization
- Bearer token injection on every request
- Typed error throwing (`ApiError`) on non-2xx responses
- Transparent token auto-refresh when a request gets a 401

The client is used **only** by the CLI. Agent core and server actions continue to use `db.ts` directly (Section 7).

### Dependencies

- **Section 3 (API endpoints)** must be defined first -- the client's methods mirror those endpoints.
- **Section 2 (auth endpoints)** defines `/api/auth/login` and `/api/auth/refresh` that the client calls.

---

## File to Create

**`web/lib/api/client.ts`**

---

## Types

```typescript
// ── Error class ────────────────────────────────────────────────

export class ApiError extends Error {
  status: number;
  details?: string;

  constructor(status: number, message: string, details?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

// ── Result types ───────────────────────────────────────────────

export interface LoginResult {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email: string;
  expires_at: number;
}

export interface QueryOpts {
  search?: string;
  type?: string;
  since?: string;
  until?: string;
  device?: string;
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  data: EventWithEnrichments[];
  count: number;
}

export interface EventWithEnrichments {
  id: string;
  timestamp: string;
  device_id: string;
  type: string;
  content_type: string | null;
  content_hash: string | null;
  local_path: string | null;
  remote_path: string | null;
  metadata: Record<string, unknown> | null;
  parent_id: string | null;
  bucket_config_id?: string | null;
  user_id: string;
  enrichment?: {
    description: string;
    objects: string[];
    context: string;
    tags: string[];
  } | null;
}

export interface EventInput {
  id: string;
  device_id: string;
  type: string;
  content_type?: string | null;
  content_hash?: string | null;
  local_path?: string | null;
  remote_path?: string | null;
  metadata?: Record<string, unknown> | null;
  parent_id?: string | null;
  bucket_config_id?: string | null;
  timestamp?: string | null;
}

export interface StatsResult {
  total_events: number;
  by_content_type: Record<string, number>;
  by_event_type: Record<string, number>;
  watched_s3_keys: number;
  enriched: number;
  pending_enrichment: number;
  device_id: string;
}

export interface PendingEnrichment {
  id: string;
  content_hash: string | null;
  content_type: string | null;
  local_path: string | null;
  remote_path: string | null;
  metadata: Record<string, unknown> | null;
}

export interface EnrichmentInput {
  description: string;
  objects: string[];
  context: string;
  suggested_tags: string[];
}

export interface WatchedKey {
  s3_key: string;
}

export interface WatchedKeyInput {
  s3_key: string;
  event_id: string | null;
  etag: string;
  size_bytes: number;
  bucket_config_id: string | null;
}

export interface ModelConfig {
  api_key: string;
  provider: string;
  model: string;
  [key: string]: unknown;
}

export interface HealthResult {
  status: "ok" | "degraded";
}
```

---

## Class Interface

```typescript
export class SmgrApiClient {
  private baseUrl: string;
  private token: string | undefined;
  private refreshToken: string | undefined;

  constructor(baseUrl: string, options?: {
    token?: string;
    refreshToken?: string;
  });

  // ── Auth ───────────────────────────────────────────────────
  login(email: string, password: string): Promise<LoginResult>;
  refresh(refreshToken: string): Promise<LoginResult>;

  // ── Data operations ────────────────────────────────────────
  // No userId params -- JWT identifies the user.
  query(opts?: QueryOpts): Promise<QueryResult>;
  show(id: string): Promise<EventWithEnrichments>;
  add(event: EventInput): Promise<void>;
  stats(): Promise<StatsResult>;
  getPendingEnrichments(): Promise<PendingEnrichment[]>;
  insertEnrichment(eventId: string, result: EnrichmentInput): Promise<void>;
  getWatchedKeys(): Promise<WatchedKey[]>;
  upsertWatchedKey(input: WatchedKeyInput): Promise<void>;
  findEventByHash(hash: string): Promise<{ id: string } | null>;
  getModelConfig(provider?: string): Promise<ModelConfig | null>;
  health(): Promise<HealthResult>;

  // ── Token management ───────────────────────────────────────
  setToken(token: string): void;
  setRefreshToken(refreshToken: string): void;

  // ── Internal ───────────────────────────────────────────────
  private request<T>(path: string, opts?: RequestInit): Promise<T>;
}
```

---

## Implementation Details

### Constructor

```typescript
constructor(baseUrl: string, options?: { token?: string; refreshToken?: string }) {
  // Strip trailing slash from baseUrl for consistent path joining
  this.baseUrl = baseUrl.replace(/\/+$/, "");
  this.token = options?.token;
  this.refreshToken = options?.refreshToken;
}
```

### `request<T>(path, opts)` -- Core Fetch Wrapper

This is the single point of contact with the network. Every public method delegates here.

1. Build full URL: `${this.baseUrl}${path}` (path always starts with `/`)
2. Build headers:
   - `Content-Type: application/json` for requests with a body
   - `Authorization: Bearer ${this.token}` when token is set
3. Call `fetch(url, { ...opts, headers })`
4. If response is 401 and `this.refreshToken` exists and this is not already a retry:
   - Call `this.refresh(this.refreshToken)` (see auto-refresh below)
   - Update `this.token` and `this.refreshToken` from the result
   - Retry the original request **once** (pass a flag to prevent infinite loops)
5. If response is not 2xx, read the JSON body and throw `ApiError(status, body.error, body.details)`
6. If response is 204 (no content), return `undefined as T`
7. Otherwise parse and return `response.json()` as `T`

**Key detail:** The retry flag is internal (not part of the public API). Use a boolean parameter `_isRetry = false` on the private method signature.

### Auto-Refresh on 401

```
request("/api/query", { method: "GET" })
  → fetch returns 401
  → refreshToken exists? Yes
  → POST /api/auth/refresh { refresh_token: this.refreshToken }
    → 200: update this.token, this.refreshToken
    → retry original request (with _isRetry = true)
  → refreshToken missing or refresh itself fails?
    → throw ApiError(401, "Unauthorized") immediately, no retry
```

This handles Supabase's 1-hour JWT expiry transparently. The CLI never needs to manage token lifecycle.

### `login(email, password)`

```typescript
async login(email: string, password: string): Promise<LoginResult> {
  const result = await this.request<LoginResult>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  // Auto-set tokens so subsequent requests are authenticated
  this.token = result.access_token;
  this.refreshToken = result.refresh_token;
  return result;
}
```

### `refresh(refreshToken)`

```typescript
async refresh(refreshToken: string): Promise<LoginResult> {
  // Call request directly without auto-refresh to avoid recursion.
  // Use a separate fetch call or pass _isRetry = true.
  const url = `${this.baseUrl}/api/auth/refresh`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || "Token refresh failed", body.details);
  }
  const result: LoginResult = await res.json();
  this.token = result.access_token;
  this.refreshToken = result.refresh_token;
  return result;
}
```

Note: `refresh()` calls `fetch` directly (not `this.request`) to avoid triggering auto-refresh recursion.

### Data Method Implementations

Each data method is a thin delegation to `request()`:

```typescript
async query(opts?: QueryOpts): Promise<QueryResult> {
  const params = new URLSearchParams();
  if (opts?.search) params.set("search", opts.search);
  if (opts?.type) params.set("type", opts.type);
  if (opts?.since) params.set("since", opts.since);
  if (opts?.until) params.set("until", opts.until);
  if (opts?.device) params.set("device", opts.device);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return this.request<QueryResult>(`/api/query${qs ? `?${qs}` : ""}`);
}

async show(id: string): Promise<EventWithEnrichments> {
  const { data } = await this.request<{ data: EventWithEnrichments }>(`/api/show/${id}`);
  return data;
}

async add(event: EventInput): Promise<void> {
  await this.request<void>("/api/add", {
    method: "POST",
    body: JSON.stringify(event),
  });
}

async stats(): Promise<StatsResult> {
  return this.request<StatsResult>("/api/stats");
}

async getPendingEnrichments(): Promise<PendingEnrichment[]> {
  const { data } = await this.request<{ data: PendingEnrichment[] }>("/api/enrich");
  return data;
}

async insertEnrichment(eventId: string, result: EnrichmentInput): Promise<void> {
  await this.request<void>("/api/enrich", {
    method: "POST",
    body: JSON.stringify({ event_id: eventId, ...result }),
  });
}

async getWatchedKeys(): Promise<WatchedKey[]> {
  const { data } = await this.request<{ data: WatchedKey[] }>("/api/watch");
  return data;
}

async upsertWatchedKey(input: WatchedKeyInput): Promise<void> {
  await this.request<void>("/api/watch", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

async findEventByHash(hash: string): Promise<{ id: string } | null> {
  const { data } = await this.request<{ data: { id: string } | null }>(
    `/api/find-by-hash?hash=${encodeURIComponent(hash)}`
  );
  return data;
}

async getModelConfig(provider?: string): Promise<ModelConfig | null> {
  const qs = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  const { data } = await this.request<{ data: ModelConfig | null }>(`/api/model-config${qs}`);
  return data;
}

async health(): Promise<HealthResult> {
  return this.request<HealthResult>("/api/health");
}
```

### `setToken` / `setRefreshToken`

```typescript
setToken(token: string): void {
  this.token = token;
}

setRefreshToken(refreshToken: string): void {
  this.refreshToken = refreshToken;
}
```

---

## TDD Test Stubs

**File:** `web/__tests__/api-client.test.ts`

All tests mock `globalThis.fetch`. No real HTTP calls.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SmgrApiClient, ApiError } from "@/lib/api/client";

// ── Helper ─────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown, headers?: Record<string, string>) {
  return vi.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(headers),
  });
}

let client: SmgrApiClient;

beforeEach(() => {
  client = new SmgrApiClient("https://app.example.com", {
    token: "test-token",
    refreshToken: "test-refresh-token",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Constructor ────────────────────────────────────────────────

describe("SmgrApiClient constructor", () => {
  it("sets baseUrl and optional token", () => {
    // Verify by making a request and checking the URL/headers
  });

  it("strips trailing slash from baseUrl", () => {
    // new SmgrApiClient("https://app.example.com/")
    // Verify request URL does not have double slash
  });

  it("setToken updates the Authorization header for subsequent requests", () => {
    // Call setToken, make a request, verify new header
  });

  it("setRefreshToken updates the stored refresh token", () => {
    // Call setRefreshToken, trigger 401 flow, verify new token used
  });
});

// ── request (internal, tested via public methods) ──────────────

describe("SmgrApiClient.request", () => {
  it("prepends baseUrl to path", () => {
    // Mock fetch, call client.health(), check fetch was called with full URL
  });

  it("includes Authorization header when token is set", () => {
    // Mock fetch, call any method, verify Authorization: Bearer test-token
  });

  it("omits Authorization header when no token is set", () => {
    // Create client without token, mock fetch, verify no Authorization header
  });

  it("includes Content-Type: application/json for POST requests", () => {
    // Mock fetch, call client.add(...), verify Content-Type header
  });

  it("parses JSON response on 2xx", () => {
    // Mock fetch returning 200 with JSON, verify parsed result
  });

  it("throws ApiError with status and message on 4xx", () => {
    // Mock fetch returning 400 with { error: "Bad Request" }
    // Verify ApiError thrown with status 400
  });

  it("throws ApiError with status and message on 5xx", () => {
    // Mock fetch returning 500 with { error: "Internal Server Error" }
    // Verify ApiError thrown with status 500
  });

  it("throws ApiError with details when response includes details field", () => {
    // Mock fetch returning 400 with { error: "Bad", details: "missing field x" }
    // Verify ApiError.details is set
  });
});

// ── Auth methods ───────────────────────────────────────────────

describe("SmgrApiClient auth methods", () => {
  it("login sends POST /api/auth/login with email and password", () => {
    // Mock fetch, call client.login("a@b.com", "pass"), verify URL + body
  });

  it("login returns LoginResult on success", () => {
    // Mock fetch returning 200 with full LoginResult shape
    // Verify all fields present in return value
  });

  it("login sets internal token and refreshToken on success", () => {
    // After login, make another call, verify new token is used in header
  });

  it("login throws ApiError on invalid credentials (401)", () => {
    // Mock fetch returning 401, verify ApiError thrown
  });

  it("refresh sends POST /api/auth/refresh with refresh_token", () => {
    // Mock fetch, call client.refresh("rt"), verify URL + body
  });

  it("refresh updates internal token on success", () => {
    // After refresh, make another call, verify new token used
  });

  it("refresh throws ApiError on expired refresh token (401)", () => {
    // Mock fetch returning 401, verify ApiError thrown
  });
});

// ── Data methods ───────────────────────────────────────────────

describe("SmgrApiClient data methods", () => {
  it("query sends GET /api/query with query params", () => {
    // Mock fetch, call client.query({ search: "cat", limit: 10 })
    // Verify URL includes ?search=cat&limit=10
  });

  it("query sends GET /api/query with no params when opts is empty", () => {
    // Mock fetch, call client.query()
    // Verify URL is /api/query with no query string
  });

  it("show sends GET /api/show/<id>", () => {
    // Mock fetch, call client.show("uuid-123")
    // Verify URL is /api/show/uuid-123
  });

  it("show returns unwrapped event data (not { data: ... } wrapper)", () => {
    // Mock fetch returning { data: { id: "uuid-123", ... } }
    // Verify client.show returns the inner object directly
  });

  it("add sends POST /api/add with event body", () => {
    // Mock fetch returning 201, call client.add({ id: "...", ... })
    // Verify POST method, correct body
  });

  it("stats sends GET /api/stats", () => {
    // Mock fetch, call client.stats(), verify URL
  });

  it("getPendingEnrichments sends GET /api/enrich", () => {
    // Mock fetch returning { data: [...] }
    // Verify returns unwrapped array
  });

  it("insertEnrichment sends POST /api/enrich with body", () => {
    // Mock fetch, call client.insertEnrichment("eid", { ... })
    // Verify body includes event_id and enrichment fields
  });

  it("getWatchedKeys sends GET /api/watch", () => {
    // Mock fetch returning { data: [{ s3_key: "..." }] }
    // Verify returns unwrapped array
  });

  it("upsertWatchedKey sends POST /api/watch with body", () => {
    // Mock fetch, call client.upsertWatchedKey({ s3_key: "...", ... })
    // Verify POST body
  });

  it("findEventByHash sends GET /api/find-by-hash?hash=<hash>", () => {
    // Mock fetch, call client.findEventByHash("abc123")
    // Verify URL includes ?hash=abc123
  });

  it("findEventByHash returns null when server returns { data: null }", () => {
    // Mock fetch returning { data: null }
    // Verify client.findEventByHash returns null
  });

  it("getModelConfig sends GET /api/model-config", () => {
    // Mock fetch, call client.getModelConfig(), verify URL
  });

  it("getModelConfig sends GET /api/model-config?provider=openai when provider given", () => {
    // Mock fetch, call client.getModelConfig("openai"), verify URL
  });

  it("health sends GET /api/health", () => {
    // Mock fetch, call client.health(), verify URL
  });
});

// ── Auto-refresh on 401 ───────────────────────────────────────

describe("SmgrApiClient auto-refresh", () => {
  it("when request returns 401 and refreshToken exists, auto-refreshes and retries", () => {
    // 1st fetch call: return 401 for /api/stats
    // 2nd fetch call: return 200 for /api/auth/refresh with new tokens
    // 3rd fetch call: return 200 for /api/stats (retry)
    // Verify: fetch called 3 times, final result is stats data
  });

  it("when auto-refresh succeeds, subsequent requests use the new token", () => {
    // Trigger auto-refresh, then make another call
    // Verify the new token appears in Authorization header
  });

  it("when auto-refresh itself returns 401, throws ApiError (no infinite loop)", () => {
    // 1st fetch call: return 401 for /api/stats
    // 2nd fetch call: return 401 for /api/auth/refresh
    // Verify: ApiError thrown with status 401, fetch called exactly 2 times
  });

  it("when no refreshToken exists, 401 throws immediately without retry", () => {
    // Create client without refreshToken
    // Mock fetch returning 401
    // Verify: ApiError thrown, fetch called exactly 1 time
  });

  it("auto-refresh does not trigger on non-401 errors", () => {
    // Mock fetch returning 403
    // Verify: ApiError thrown with 403, fetch called exactly 1 time (no refresh attempt)
  });
});
```

---

## Verification Steps

After implementing `web/lib/api/client.ts` and `web/__tests__/api-client.test.ts`:

1. **Type-check compiles:**
   ```bash
   cd web && npx tsc --noEmit --strict lib/api/client.ts
   ```

2. **Run client tests in isolation:**
   ```bash
   cd web && npx vitest run __tests__/api-client.test.ts
   ```

3. **Verify no imports of db.ts or supabase in client.ts:**
   ```bash
   grep -E "(db|supabase)" web/lib/api/client.ts
   # Should return nothing -- the client only uses fetch
   ```

4. **Verify ApiError is exported and usable:**
   ```bash
   # In the test file, confirm:
   # - ApiError can be instantiated
   # - ApiError.status, .message, .details are accessible
   # - instanceof ApiError works in catch blocks
   ```

5. **Run the full test suite to confirm no regressions:**
   ```bash
   cd web && npm test
   ```

6. **Verify the auto-refresh test covers the no-infinite-loop case:**
   The test "when auto-refresh itself returns 401, throws ApiError" must assert that `fetch` is called exactly 2 times (the original request + the refresh attempt), not 3+ times.
