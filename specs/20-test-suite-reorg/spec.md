# 20: Test Suite Reorganization

## Problem

The integration and E2E test suites have overlapping concerns. `smgr-cli.test.ts` and `smgr-e2e.test.ts` both spawn CLI subprocesses, both require the Next.js dev server, and both test overlapping commands (query, stats, enrich). The distinction between them is unclear, leading to:

- Tests in the wrong tier (CLI argument parsing tests that need a running server)
- Missing coverage for new API routes (bucket CRUD, test, scan have no direct tests)
- Expensive infrastructure requirements for tests that could run cheaper
- Confusion about where to add new tests

## Current State

| Suite | What it tests | Requires |
|-------|--------------|----------|
| Unit (`npm run test`) | Pure logic, mocked deps | Nothing |
| `smgr-cli.test.ts` | CLI commands via subprocess → API → Supabase | Supabase + Next.js + credentials |
| `smgr-e2e.test.ts` | Full pipeline: S3 upload → watch → enrich → search | Supabase + Next.js + S3 + Ollama |
| DB integration tests | Schema, RLS, tenant isolation, lifecycle | Supabase only |
| `media-storage.test.ts` | S3 client operations directly | Supabase (S3 storage) |

The problem: `smgr-cli.test.ts` tests things like "stats returns JSON" and "query filters by device" — these are really testing the API route, not the CLI. The CLI is just a pass-through HTTP client. Testing it via subprocess adds CLI startup time, credential file setup, and dev server dependency for what's fundamentally an API test.

## Goal

Clear test tiers where each test runs at the cheapest level that validates the behavior:

1. **Unit tests** — pure logic, mocked deps (unchanged)
2. **API route tests** — test HTTP routes directly against running Next.js + Supabase. No CLI, no S3 for CRUD routes.
3. **CLI tests** — test CLI-specific behavior only (arg parsing, help text, exit codes, output formatting). Mock API calls.
4. **DB integration tests** — schema, RLS, tenant isolation (unchanged)
5. **E2E pipeline test** — full happy path with real S3 + enrichment (keep `smgr-e2e.test.ts`, trim to one pipeline test)

## Key Changes

### 1. New: API route integration tests

Create `__tests__/integration/api-routes.test.ts` (or split by domain):

**Bucket CRUD:**
- `POST /api/buckets` — create bucket config, verify no secrets in response
- `GET /api/buckets` — list buckets
- `DELETE /api/buckets/[id]` — remove bucket
- `POST /api/buckets/[id]/test` — test connectivity (needs S3)
- 401 on all routes without auth

**Bucket operations:**
- `POST /api/buckets/[id]/scan` — scan with real S3
- `POST /api/buckets/[id]/upload` — multipart upload with real S3
- 404 when bucket doesn't exist

**Events/Stats filtering:**
- `GET /api/events?bucket_config_id=X` — filters correctly
- `GET /api/stats?bucket_config_id=X` — filters correctly

These tests call `fetch()` directly against the dev server with a Bearer token. No CLI subprocess overhead.

### 2. Slim down `smgr-cli.test.ts`

Keep only CLI-specific tests:
- Help text and usage (no server needed — these already work without auth)
- Exit codes for missing credentials
- `--verbose` flag behavior
- Output formatting (table vs JSON) — can mock the API response

Move to API route tests:
- "stats returns valid JSON" → test the route directly
- "query filters by device" → test the route directly
- "show returns event" → test the route directly
- "enrich --status returns counts" → test the route directly

### 3. Slim down `smgr-e2e.test.ts`

Keep as the one expensive pipeline test:
- Upload fixtures to S3
- Create bucket config
- `watch --once` discovers images
- `enrich --pending` processes images
- FTS search finds enriched content
- Stats reflect final state

Remove anything that's covered by API route tests (individual command behavior).

### 4. Test infrastructure helpers

Create `__tests__/integration/helpers/api-client.ts`:
```typescript
/** Authenticated fetch against the running dev server */
export async function apiFetch(path: string, opts?: RequestInit): Promise<Response>
export async function apiGet<T>(path: string): Promise<T>
export async function apiPost<T>(path: string, body: unknown): Promise<T>
```

This mirrors the CLI's `apiFetch` but runs in the test process — no subprocess, no credential file, faster.

## Out of Scope

- Changing the test runner (vitest stays)
- Changing CI pipeline structure
- Adding new test infrastructure (Playwright, etc.)
- Changing how DB integration tests work

## Dependencies

- Spec 15 (bucket API routes) — done
- Running Supabase + Next.js dev server for API route tests
- Existing test user creation helpers in `setup.ts`
