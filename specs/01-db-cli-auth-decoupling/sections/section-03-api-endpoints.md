# Section 3: Create Data API Endpoints

## Prerequisites

- **Section 1 complete**: `db.ts` is parameterized -- all data functions accept `SupabaseClient` as first parameter, `getAdminClient(config)` accepts `SupabaseConfig`
- **Section 2 complete**: `requireAuth(request)` exists in `web/lib/api/auth.ts`, returns `{ userId: string }` or a 401 `NextResponse`

## Context

The CLI currently imports `db.ts` directly, pulling in Node-native modules that break Vercel. The fix: expose every data operation the CLI needs as an HTTP endpoint. Each route authenticates via JWT (Section 2's `requireAuth`), creates a parameterized Supabase client, calls the corresponding `db.ts` function, and translates Supabase's `{ data, error }` shape into standard HTTP responses.

The existing `app/api/health/route.ts` is the reference pattern for Next.js route handlers in this project.

## Files to Create

| # | File | HTTP Methods | db.ts functions called |
|---|------|-------------|----------------------|
| 1 | `web/lib/api/errors.ts` | (shared helper) | - |
| 2 | `web/app/api/query/route.ts` | GET | `queryEvents` |
| 3 | `web/app/api/show/[id]/route.ts` | GET | `showEvent` |
| 4 | `web/app/api/add/route.ts` | POST | `insertEvent` |
| 5 | `web/app/api/stats/route.ts` | GET | `getStats`, `getEnrichStatus` |
| 6 | `web/app/api/enrich/route.ts` | GET, POST | `getPendingEnrichments`, `insertEnrichment` |
| 7 | `web/app/api/watch/route.ts` | GET, POST | `getWatchedKeys`, `upsertWatchedKey` |
| 8 | `web/app/api/find-by-hash/route.ts` | GET | `findEventByHash` |
| 9 | `web/app/api/model-config/route.ts` | GET | `getModelConfig` |
| 10 | `web/__tests__/api/errors.test.ts` | - | - |
| 11 | `web/__tests__/api/query.test.ts` | - | - |
| 12 | `web/__tests__/api/show.test.ts` | - | - |
| 13 | `web/__tests__/api/add.test.ts` | - | - |
| 14 | `web/__tests__/api/stats.test.ts` | - | - |
| 15 | `web/__tests__/api/enrich.test.ts` | - | - |
| 16 | `web/__tests__/api/watch.test.ts` | - | - |
| 17 | `web/__tests__/api/find-by-hash.test.ts` | - | - |
| 18 | `web/__tests__/api/model-config.test.ts` | - | - |

No existing files are modified in this section.

---

## 1. Error Mapping Helper

### File: `web/lib/api/errors.ts`

```typescript
/**
 * Maps Supabase/PostgREST error codes to HTTP status codes.
 * Used by all data API routes to translate db errors to HTTP responses.
 */
export function mapSupabaseError(error: unknown): { status: number; message: string } {
  const code = (error as Record<string, unknown>)?.code as string | undefined;
  const msg = (error as Record<string, unknown>)?.message as string | undefined;

  switch (code) {
    case "23505":
      return { status: 409, message: msg ?? "Conflict: duplicate record" };
    case "23503":
      return { status: 400, message: msg ?? "Bad request: foreign key violation" };
    case "42501":
      return { status: 403, message: msg ?? "Forbidden" };
    case "PGRST301":
    case "PGRST302":
      return { status: 404, message: msg ?? "Not found" };
    default:
      return { status: 500, message: msg ?? "Internal server error" };
  }
}
```

### Shared Config Helper

All route files use this inline helper to build the Supabase config from env vars:

```typescript
import { getAdminClient } from "@/lib/media/db";
import type { SupabaseConfig } from "@/lib/media/db";

function getServerConfig(): SupabaseConfig {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}
```

Each route creates the client per-request: `const client = getAdminClient(getServerConfig());`

---

## 2. Query Endpoint

### File: `web/app/api/query/route.ts`

**Request:**
```
GET /api/query?limit=20&offset=0&type=photo&since=2024-01-01&until=2024-12-31&search=sunset&device=iphone
Authorization: Bearer <token>
```

All query parameters are optional. Defaults: `limit=20`, `offset=0`.

**Success Response (200):**
```json
{
  "data": [{ "id": "...", "timestamp": "...", "enrichment": {...}, ... }],
  "count": 42
}
```

**Error Responses:**
| Status | Condition |
|--------|-----------|
| 401 | Missing/invalid Bearer token |
| 500 | Database error |

**Implementation:**
```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/auth";
import { getAdminClient, queryEvents } from "@/lib/media/db";
import { mapSupabaseError } from "@/lib/api/errors";

function getServerConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const params = request.nextUrl.searchParams;
  const client = getAdminClient(getServerConfig());

  const { data, count, error } = await queryEvents(client, {
    userId: auth.userId,
    search: params.get("search") ?? undefined,
    type: params.get("type") ?? undefined,
    since: params.get("since") ?? undefined,
    until: params.get("until") ?? undefined,
    device: params.get("device") ?? undefined,
    limit: params.has("limit") ? Number(params.get("limit")) : undefined,
    offset: params.has("offset") ? Number(params.get("offset")) : undefined,
  });

  if (error) {
    const mapped = mapSupabaseError(error);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  return NextResponse.json({ data, count });
}
```

---

## 3. Show Endpoint

### File: `web/app/api/show/[id]/route.ts`

**Request:**
```
GET /api/show/<event-id>
Authorization: Bearer <token>
```

**Success Response (200):**
```json
{
  "data": { "id": "...", "timestamp": "...", "enrichment": {...}, ... }
}
```

**Error Responses:**
| Status | Condition |
|--------|-----------|
| 401 | Missing/invalid Bearer token |
| 404 | Event not found (or not owned by user) |
| 500 | Database error |

**Implementation:**
```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/auth";
import { getAdminClient, showEvent } from "@/lib/media/db";
import { mapSupabaseError } from "@/lib/api/errors";

function getServerConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const client = getAdminClient(getServerConfig());
  const { data, error } = await showEvent(client, id, auth.userId);

  if (error) {
    const mapped = mapSupabaseError(error);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ data });
}
```

---

## 4. Add Endpoint

### File: `web/app/api/add/route.ts`

**Request:**
```
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
  "timestamp": "ISO8601" | null
}
```

Required fields: `id`, `device_id`, `type`.

**Success Response (201):**
```json
{}
```

**Error Responses:**
| Status | Condition |
|--------|-----------|
| 400 | Missing required fields (`id`, `device_id`, `type`) or foreign key violation |
| 401 | Missing/invalid Bearer token |
| 409 | Duplicate event (Supabase code `23505`) |
| 500 | Database error |

**Implementation:**
```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/auth";
import { getAdminClient, insertEvent } from "@/lib/media/db";
import { mapSupabaseError } from "@/lib/api/errors";

function getServerConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  if (!body || !body.id || !body.device_id || !body.type) {
    return NextResponse.json(
      { error: "Missing required fields: id, device_id, type" },
      { status: 400 },
    );
  }

  const client = getAdminClient(getServerConfig());
  const { error } = await insertEvent(client, {
    ...body,
    user_id: auth.userId,
  });

  if (error) {
    const mapped = mapSupabaseError(error);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  return NextResponse.json({}, { status: 201 });
}
```

---

## 5. Stats Endpoint

### File: `web/app/api/stats/route.ts`

**Request:**
```
GET /api/stats
GET /api/stats?include=enrich_status
Authorization: Bearer <token>
```

**Success Response (200):**
```json
{
  "total_events": 150,
  "by_content_type": { "photo": 100, "video": 30, "note": 20 },
  "by_event_type": { "create": 140, "delete": 10 },
  "watched_s3_keys": 80,
  "enriched": 60,
  "pending_enrichment": 40,
  "device_id": "web"
}
```

When `?include=enrich_status`, the response also includes:
```json
{
  "enrich_status": {
    "total_media": 100,
    "enriched": 60,
    "pending": 40
  }
}
```

**Error Responses:**
| Status | Condition |
|--------|-----------|
| 401 | Missing/invalid Bearer token |
| 500 | Database error |

**Implementation:**
```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/auth";
import { getAdminClient, getStats, getEnrichStatus } from "@/lib/media/db";
import { mapSupabaseError } from "@/lib/api/errors";

function getServerConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const client = getAdminClient(getServerConfig());
  const { data, error } = await getStats(client, {
    userId: auth.userId,
    deviceId: "web",
  });

  if (error) {
    const mapped = mapSupabaseError(error);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  const include = request.nextUrl.searchParams.get("include");
  if (include === "enrich_status") {
    const { data: enrichData, error: enrichError } = await getEnrichStatus(client, auth.userId);
    if (enrichError) {
      const mapped = mapSupabaseError(enrichError);
      return NextResponse.json({ error: mapped.message }, { status: mapped.status });
    }
    return NextResponse.json({ ...data, enrich_status: enrichData });
  }

  return NextResponse.json(data);
}
```

---

## 6. Enrich Endpoint

### File: `web/app/api/enrich/route.ts`

### GET -- List Pending Enrichments

**Request:**
```
GET /api/enrich
Authorization: Bearer <token>
```

**Success Response (200):**
```json
{
  "data": [
    { "id": "uuid", "content_hash": "...", "content_type": "photo", "local_path": "...", "remote_path": "...", "metadata": {} }
  ]
}
```

### POST -- Insert Enrichment Result

**Request:**
```
POST /api/enrich
Authorization: Bearer <token>
Content-Type: application/json

{
  "event_id": "uuid",
  "description": "A sunset over the ocean",
  "objects": ["sun", "ocean", "clouds"],
  "context": "outdoor landscape photo",
  "suggested_tags": ["sunset", "nature"]
}
```

Required fields: `event_id`, `description`, `objects`, `context`, `suggested_tags`.

**Success Response (201):**
```json
{}
```

**Error Responses (both methods):**
| Status | Condition |
|--------|-----------|
| 400 | POST: missing required fields |
| 401 | Missing/invalid Bearer token |
| 500 | Database error |

**Implementation:**
```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/auth";
import { getAdminClient, getPendingEnrichments, insertEnrichment } from "@/lib/media/db";
import { mapSupabaseError } from "@/lib/api/errors";

function getServerConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const client = getAdminClient(getServerConfig());
  const { data, error } = await getPendingEnrichments(client, auth.userId);

  if (error) {
    const mapped = mapSupabaseError(error);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  if (
    !body ||
    !body.event_id ||
    !body.description ||
    !body.objects ||
    !body.context ||
    !body.suggested_tags
  ) {
    return NextResponse.json(
      { error: "Missing required fields: event_id, description, objects, context, suggested_tags" },
      { status: 400 },
    );
  }

  const client = getAdminClient(getServerConfig());
  const { error } = await insertEnrichment(client, body.event_id, {
    description: body.description,
    objects: body.objects,
    context: body.context,
    suggested_tags: body.suggested_tags,
  }, auth.userId);

  if (error) {
    const mapped = mapSupabaseError(error);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  return NextResponse.json({}, { status: 201 });
}
```

---

## 7. Watch Endpoint

### File: `web/app/api/watch/route.ts`

### GET -- List Watched Keys

**Request:**
```
GET /api/watch
Authorization: Bearer <token>
```

**Success Response (200):**
```json
{
  "data": [{ "s3_key": "photos/2024/sunset.jpg" }]
}
```

### POST -- Upsert Watched Key

**Request:**
```
POST /api/watch
Authorization: Bearer <token>
Content-Type: application/json

{
  "s3_key": "photos/2024/sunset.jpg",
  "event_id": "uuid" | null,
  "etag": "abc123",
  "size_bytes": 1048576,
  "bucket_config_id": "uuid" | null
}
```

Required fields: `s3_key`, `etag`, `size_bytes`.

**Success Response (200):**
```json
{}
```

**Error Responses (both methods):**
| Status | Condition |
|--------|-----------|
| 400 | POST: missing required fields |
| 401 | Missing/invalid Bearer token |
| 500 | Database error |

**Implementation:**
```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/auth";
import { getAdminClient, getWatchedKeys, upsertWatchedKey } from "@/lib/media/db";
import { mapSupabaseError } from "@/lib/api/errors";

function getServerConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const client = getAdminClient(getServerConfig());
  const { data, error } = await getWatchedKeys(client, auth.userId);

  if (error) {
    const mapped = mapSupabaseError(error);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  if (!body || !body.s3_key || !body.etag || body.size_bytes === undefined) {
    return NextResponse.json(
      { error: "Missing required fields: s3_key, etag, size_bytes" },
      { status: 400 },
    );
  }

  const client = getAdminClient(getServerConfig());
  const { error } = await upsertWatchedKey(
    client,
    body.s3_key,
    body.event_id ?? null,
    body.etag,
    body.size_bytes,
    auth.userId,
    body.bucket_config_id ?? undefined,
  );

  if (error) {
    const mapped = mapSupabaseError(error);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  return NextResponse.json({});
}
```

---

## 8. Find-by-Hash Endpoint

### File: `web/app/api/find-by-hash/route.ts`

**Request:**
```
GET /api/find-by-hash?hash=<content_hash>
Authorization: Bearer <token>
```

**Success Response (200) -- found:**
```json
{ "data": { "id": "uuid" } }
```

**Success Response (200) -- not found:**
```json
{ "data": null }
```

**Error Responses:**
| Status | Condition |
|--------|-----------|
| 400 | Missing `hash` query parameter |
| 401 | Missing/invalid Bearer token |
| 500 | Database error |

**Implementation:**
```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/auth";
import { getAdminClient, findEventByHash } from "@/lib/media/db";
import { mapSupabaseError } from "@/lib/api/errors";

function getServerConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const hash = request.nextUrl.searchParams.get("hash");
  if (!hash) {
    return NextResponse.json({ error: "Missing required query parameter: hash" }, { status: 400 });
  }

  const client = getAdminClient(getServerConfig());
  const { data, error } = await findEventByHash(client, hash, auth.userId);

  if (error) {
    const mapped = mapSupabaseError(error);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  return NextResponse.json({ data });
}
```

---

## 9. Model Config Endpoint

### File: `web/app/api/model-config/route.ts`

**Request:**
```
GET /api/model-config
GET /api/model-config?provider=openai
Authorization: Bearer <token>
```

**Success Response (200) -- config found:**
```json
{
  "data": {
    "id": "uuid",
    "user_id": "uuid",
    "provider": "openai",
    "base_url": null,
    "model": "gpt-4",
    "api_key": "sk-...",
    "is_active": true,
    "created_at": "...",
    "updated_at": "..."
  }
}
```

Note: `api_key_encrypted` is decrypted server-side and returned as `api_key`. The encrypted field is stripped from the response.

**Success Response (200) -- no config:**
```json
{ "data": null }
```

**Error Responses:**
| Status | Condition |
|--------|-----------|
| 401 | Missing/invalid Bearer token |
| 500 | Database error or decryption failure |

**Implementation:**
```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/auth";
import { getAdminClient, getModelConfig } from "@/lib/media/db";
import { decryptSecretVersioned } from "@/lib/crypto/encryption-versioned";
import { mapSupabaseError } from "@/lib/api/errors";

function getServerConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const provider = request.nextUrl.searchParams.get("provider") ?? undefined;
  const client = getAdminClient(getServerConfig());
  const { data, error } = await getModelConfig(client, auth.userId, provider);

  if (error) {
    const mapped = mapSupabaseError(error);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  if (!data) {
    return NextResponse.json({ data: null });
  }

  // Decrypt api_key_encrypted, return as api_key
  let apiKey: string | null = null;
  if (data.api_key_encrypted) {
    try {
      apiKey = await decryptSecretVersioned(data.api_key_encrypted);
    } catch (e) {
      console.error("[model-config] decryption failed:", e instanceof Error ? e.message : e);
      return NextResponse.json({ error: "Failed to decrypt API key" }, { status: 500 });
    }
  }

  const { api_key_encrypted, ...rest } = data;
  return NextResponse.json({ data: { ...rest, api_key: apiKey } });
}
```

---

## Error Mapping Reference

All endpoints use the same `mapSupabaseError` helper. Complete mapping:

| Supabase/PostgREST Code | HTTP Status | Meaning |
|--------------------------|-------------|---------|
| `23505` | 409 Conflict | Unique constraint violation (duplicate) |
| `23503` | 400 Bad Request | Foreign key violation |
| `42501` | 403 Forbidden | Insufficient privilege |
| `PGRST301` | 404 Not Found | Embedded resource not found |
| `PGRST302` | 404 Not Found | Embedded resource not found |
| (any other) | 500 Internal Server Error | Unexpected database error |

---

## TDD Test Stubs

All tests use Vitest. Mock `@/lib/media/db` at module level. Mock `@/lib/api/auth` to control auth. Use `NextRequest` constructor to build requests.

### Shared test setup pattern

Every test file follows this structure:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock auth -- default: authenticated
vi.mock("@/lib/api/auth", () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: "test-user-id" }),
}));

// Mock db -- default: success
vi.mock("@/lib/media/db", () => ({
  getAdminClient: vi.fn().mockReturnValue({}),
  // ... mock the specific db function(s) for this endpoint
}));

// Import after mocks
import { requireAuth } from "@/lib/api/auth";
```

Helper to build `NextRequest`:

```typescript
function buildRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}
```

---

### `web/__tests__/api/errors.test.ts`

```typescript
// Test: mapSupabaseError maps 23505 to 409 Conflict
// Test: mapSupabaseError maps 23503 to 400 Bad Request
// Test: mapSupabaseError maps 42501 to 403 Forbidden
// Test: mapSupabaseError maps PGRST301 to 404 Not Found
// Test: mapSupabaseError maps PGRST302 to 404 Not Found
// Test: mapSupabaseError maps unknown code to 500
// Test: mapSupabaseError handles error with no code as 500
// Test: mapSupabaseError preserves original message from error object
```

### `web/__tests__/api/query.test.ts`

```typescript
// Test: GET /api/query with valid auth returns 200 with events array and count
// Test: GET /api/query passes userId from JWT to queryEvents (not from query params)
// Test: GET /api/query forwards search, type, since, until, limit, offset, device params
// Test: GET /api/query without auth returns 401
// Test: GET /api/query when db returns error returns 500
```

### `web/__tests__/api/show.test.ts`

```typescript
// Test: GET /api/show/[id] with valid auth returns 200 with event data
// Test: GET /api/show/[id] scopes to authenticated userId
// Test: GET /api/show/[id] returns 404 when event not found (data is null)
// Test: GET /api/show/[id] without auth returns 401
// Test: GET /api/show/[id] when db returns error returns mapped HTTP status
```

### `web/__tests__/api/add.test.ts`

```typescript
// Test: POST /api/add with valid event body returns 201
// Test: POST /api/add sets user_id from JWT, not from request body
// Test: POST /api/add with duplicate content_hash returns 409 (code 23505)
// Test: POST /api/add with missing required fields (id, device_id, type) returns 400
// Test: POST /api/add with malformed JSON body returns 400
// Test: POST /api/add without auth returns 401
```

### `web/__tests__/api/stats.test.ts`

```typescript
// Test: GET /api/stats returns 200 with stats object
// Test: GET /api/stats passes userId from JWT to getStats
// Test: GET /api/stats passes deviceId "web" to getStats
// Test: GET /api/stats?include=enrich_status includes enrichment status in response
// Test: GET /api/stats without auth returns 401
// Test: GET /api/stats when db returns error returns 500
```

### `web/__tests__/api/enrich.test.ts`

```typescript
// Test: GET /api/enrich returns 200 with pending enrichments array
// Test: GET /api/enrich scopes to userId from JWT
// Test: POST /api/enrich with valid enrichment data returns 201
// Test: POST /api/enrich passes userId from JWT to insertEnrichment
// Test: POST /api/enrich with missing event_id returns 400
// Test: POST /api/enrich with missing description returns 400
// Test: GET /api/enrich without auth returns 401
// Test: POST /api/enrich without auth returns 401
```

### `web/__tests__/api/watch.test.ts`

```typescript
// Test: GET /api/watch returns 200 with watched keys array
// Test: GET /api/watch scopes to userId from JWT
// Test: POST /api/watch with valid data returns 200
// Test: POST /api/watch passes userId from JWT to upsertWatchedKey
// Test: POST /api/watch with missing s3_key returns 400
// Test: POST /api/watch with missing etag returns 400
// Test: POST /api/watch with missing size_bytes returns 400
// Test: GET /api/watch without auth returns 401
// Test: POST /api/watch without auth returns 401
```

### `web/__tests__/api/find-by-hash.test.ts`

```typescript
// Test: GET /api/find-by-hash?hash=abc returns 200 with event id when found
// Test: GET /api/find-by-hash?hash=abc returns 200 with null data when not found
// Test: GET /api/find-by-hash scopes to userId from JWT
// Test: GET /api/find-by-hash without hash param returns 400
// Test: GET /api/find-by-hash without auth returns 401
// Test: GET /api/find-by-hash when db returns error returns 500
```

### `web/__tests__/api/model-config.test.ts`

```typescript
// Test: GET /api/model-config returns 200 with decrypted config
// Test: GET /api/model-config?provider=openai filters by provider
// Test: GET /api/model-config returns 200 with null data when no config exists
// Test: GET /api/model-config decrypts api_key_encrypted to api_key in response
// Test: GET /api/model-config strips api_key_encrypted from response
// Test: GET /api/model-config returns 500 when decryption fails
// Test: GET /api/model-config without auth returns 401
```

---

## Verification Steps

Run these after all files are created:

### 1. Type check

```bash
cd web && npx tsc --noEmit
```

All new route files and test files must compile without errors.

### 2. Run tests

```bash
cd web && npx vitest run __tests__/api/
```

All test files listed above must pass.

### 3. Verify route structure

```bash
# Each route file must export the correct HTTP method handlers
grep -r "export async function GET\|export async function POST" web/app/api/query web/app/api/show web/app/api/add web/app/api/stats web/app/api/enrich web/app/api/watch web/app/api/find-by-hash web/app/api/model-config
```

Expected: one `GET` each for query, show, stats, find-by-hash, model-config; one `POST` for add; both `GET` and `POST` for enrich and watch.

### 4. Verify no direct Supabase client creation in routes

```bash
# Routes must NOT call createClient directly -- they use getAdminClient from db.ts
grep -r "createClient\|createSupabaseClient" web/app/api/query web/app/api/show web/app/api/add web/app/api/stats web/app/api/enrich web/app/api/watch web/app/api/find-by-hash web/app/api/model-config
```

Expected: zero matches.

### 5. Verify all routes use requireAuth

```bash
grep -r "requireAuth" web/app/api/query web/app/api/show web/app/api/add web/app/api/stats web/app/api/enrich web/app/api/watch web/app/api/find-by-hash web/app/api/model-config
```

Expected: one match per route handler function (8 routes, some with two handlers = ~10 matches).

### 6. Verify error mapping is used

```bash
grep -r "mapSupabaseError" web/app/api/query web/app/api/show web/app/api/add web/app/api/stats web/app/api/enrich web/app/api/watch web/app/api/find-by-hash web/app/api/model-config
```

Expected: at least one match per route file.

### 7. Existing tests still pass

```bash
cd web && npx vitest run
```

No regressions in existing test suites. This section adds files only -- it does not modify existing code.
