# Specification: Full API Abstraction — DB/CLI Auth Decoupling

## Problem Statement

`web/lib/media/db.ts` unconditionally imports `cli-auth.ts`, which pulls in `node:fs`, `node:os`, `node:readline` and calls `homedir()` at module scope. Every web consumer of db.ts (API routes, Server Actions, agent core) breaks at import time in the Vercel runtime because these Node-native modules and CLI env vars (`SMGR_API_URL`, `SMGR_API_KEY`) are unavailable.

Beyond the immediate import bug, the architecture conflates two distinct runtime contexts: the **web app** (Vercel) that owns Supabase directly, and the **CLI** (`smgr`) that should treat the web app as an abstraction layer rather than reaching around it to hit Supabase directly.

## Vision

**Only the web API knows about Supabase.** The CLI is an HTTP client to the web API. Agent core calls the same API endpoints. `db.ts` becomes a server-only data access layer (DAL) consumed exclusively by API route handlers.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Web API (Vercel)                                          │
│                                                          │
│  /api/auth/login  ─┐                                    │
│  /api/query        │                                    │
│  /api/show/[id]    ├──→ db.ts (server DAL) ──→ Supabase │
│  /api/add          │                                    │
│  /api/stats        │                                    │
│  /api/enrich       │                                    │
│  /api/watch        │                                    │
│  /api/health       ─┘                                    │
│                                                          │
└──────────────────────┬───────────────────────────────────┘
                       │ HTTP (fetch)
          ┌────────────┴────────────┐
          │                         │
    ┌─────┴─────┐            ┌──────┴──────┐
    │   CLI      │            │ Agent Core  │
    │ (smgr.ts)  │            │ (core.ts)   │
    │            │            │             │
    │ ApiClient  │            │ ApiClient   │
    └────────────┘            └─────────────┘
```

## Scope

### In Scope
1. **Create command-oriented API endpoints** — `/api/auth/login`, `/api/query`, `/api/show/[id]`, `/api/add`, `/api/stats`, `/api/enrich`, `/api/watch`, `/api/health` (refactored)
2. **Create a custom API client class** — Thin fetch wrapper handling auth headers, base URL, error parsing
3. **Rewrite `smgr.ts`** — Replace all db.ts imports with API client calls
4. **Rewrite `lib/agent/core.ts`** — Replace all db.ts imports with API client calls
5. **Rewrite `components/agent/actions.ts`** — Replace db.ts import with API client call
6. **Refactor `db.ts`** — Remove cli-auth import; client factories accept config as parameter; becomes server-only DAL
7. **Remove barrel export** — Delete `lib/media/index.ts`; consumers import from `db.ts` directly (only API routes now)
8. **CLI auth flow** — `/api/auth/login` accepts email/password, returns JWT. CLI stores JWT, sends as Bearer token.
9. **Update all tests** — Unit tests mock API client instead of db.ts. Integration tests hit API endpoints.

### Out of Scope
- Env var unification (SMGR_API_URL vs NEXT_PUBLIC_SUPABASE_URL) — only web API routes need Supabase env vars now
- Offline/local-first support
- BYO S3 storage
- New CLI commands or features

## API Endpoints

### Authentication
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Email/password → JWT. Body: `{ email, password }`. Returns: `{ access_token, refresh_token, user_id, email, expires_at }` |

### Data Operations
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/query` | GET | Query events. Query params: `limit`, `offset`, `after`, `before`, `enriched`, `userId` |
| `/api/show/[id]` | GET | Get single event with enrichments |
| `/api/add` | POST | Insert event. Body: event data |
| `/api/stats` | GET | Get statistics (total, enriched, etc.) |
| `/api/enrich` | GET/POST | GET: pending enrichments. POST: insert enrichment |
| `/api/watch` | GET/POST/PUT | GET: list watched keys. POST: upsert watched key |
| `/api/health` | GET | Health check (refactored, still checks Supabase connectivity) |

### Request/Response Pattern
- **Auth:** Bearer token in `Authorization` header (except `/api/auth/login` and `/api/health`)
- **Success:** HTTP 200 with JSON body
- **Errors:** Standard HTTP status codes (400, 401, 403, 404, 500) with JSON body `{ error: string, details?: string }`

## API Client Class

```typescript
// lib/api/client.ts (used by CLI and agent core)
class SmgrApiClient {
  constructor(baseUrl: string, token?: string)

  // Auth
  async login(email: string, password: string): Promise<LoginResult>

  // Data operations (mirrors API endpoints)
  async query(opts: QueryOpts): Promise<EventResult[]>
  async show(id: string): Promise<EventWithEnrichments>
  async add(event: EventInput): Promise<Event>
  async stats(userId?: string): Promise<Stats>
  async enrich(enrichment: EnrichmentInput): Promise<Enrichment>
  async getPendingEnrichments(userId?: string): Promise<Enrichment[]>
  async watch(key: WatchedKeyInput): Promise<WatchedKey>
  async getWatchedKeys(userId?: string): Promise<WatchedKey[]>
  async health(): Promise<HealthStatus>

  // Internal
  private async request<T>(path: string, opts?: RequestInit): Promise<T>
  // Handles: base URL resolution, auth headers, JSON parsing, error extraction
}
```

## db.ts Refactoring

**Current:** db.ts has hardcoded env var reads via `resolveApiConfig()` from cli-auth.

**After:** Client factories accept config as parameter.

```typescript
// Before
export function getAdminClient() {
  const { url } = resolveApiConfig(); // cli-auth dependency
  const key = process.env.SUPABASE_SECRET_KEY;
  return createSupabaseClient(url, key);
}

// After
export function getAdminClient(config: { url: string; serviceKey: string }) {
  return createSupabaseClient(config.url, config.serviceKey);
}
```

API route handlers provide config from their own env vars:

```typescript
// In an API route
const client = getAdminClient({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
});
```

## CLI Auth Flow

1. User runs `smgr login`
2. CLI prompts for email/password
3. CLI POST /api/auth/login with `{ email, password }`
4. API route uses Supabase Auth to verify, returns JWT
5. CLI stores JWT in `~/.sitemgr/credentials.json` (same location, different flow)
6. Subsequent CLI commands send JWT as `Authorization: Bearer <token>`
7. API routes verify JWT via Supabase Auth (middleware or per-route)

## Migration Strategy

**Big bang** — all changes in one PR. No intermediate states or backwards compatibility.

### Files to Create
| File | Purpose |
|------|---------|
| `app/api/auth/login/route.ts` | Auth endpoint |
| `app/api/query/route.ts` | Event query endpoint |
| `app/api/show/[id]/route.ts` | Single event endpoint |
| `app/api/add/route.ts` | Event creation endpoint |
| `app/api/stats/route.ts` | Statistics endpoint |
| `app/api/enrich/route.ts` | Enrichment endpoint |
| `app/api/watch/route.ts` | Watched keys endpoint |
| `lib/api/client.ts` | API client class |

### Files to Modify
| File | Change |
|------|--------|
| `lib/media/db.ts` | Remove cli-auth import; parameterize client factories; keep as server-only DAL |
| `lib/auth/cli-auth.ts` | Remove `resolveApiConfig()` (no longer needed). Keep credential storage functions. Update `login()` to call API endpoint instead of Supabase directly. |
| `bin/smgr.ts` | Replace all db.ts imports with API client calls |
| `lib/agent/core.ts` | Replace all db.ts imports with API client calls |
| `components/agent/actions.ts` | Replace db.ts import with API client call |
| `app/api/health/route.ts` | Refactor to use parameterized getAdminClient |

### Files to Delete
| File | Reason |
|------|--------|
| `lib/media/index.ts` | Barrel export no longer needed |

## Testing Strategy

### Unit Tests
- **API routes:** Mock db.ts functions, test HTTP status codes and response shapes
- **API client:** Mock fetch, test request construction and error handling
- **db.ts:** Mock Supabase createClient, test with parameterized config (no env var stubs needed)

### Integration Tests
- **CLI → API → DB:** Start local server, CLI makes real HTTP requests, API hits local Supabase
- **smgr-cli.test.ts:** Rewrite to spawn CLI against running dev server instead of direct db.ts calls

### Smoke Tests
- Deploy to preview, verify `/api/health` returns 200
- Run `smgr stats` against preview deployment

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Performance: CLI adds HTTP hop | Local dev: negligible. Production: CLI calls Vercel which is in same region as Supabase. Accept ~50ms overhead. |
| Auth token expiry | API client handles 401 → refresh token flow automatically |
| Breaking all tests at once | Big bang is chosen; run full test suite before merging. No partial states. |
| Agent core latency (server → HTTP → server) | Agent core runs on same Vercel instance; localhost calls are fast. Could optimize later with direct imports if needed. |
| getAuthenticatedClient stays in db.ts but needs refreshSession | Keep it for now; it's only used by API routes that handle CLI auth tokens. The route handler calls it, not the CLI directly. |
