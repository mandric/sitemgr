# Codebase Research: Duplicate Detection (Spec 19)

## Content Hash Storage

### Uploads (`web/app/api/buckets/[id]/upload/route.ts`)
- Uses `sha256Bytes(fileBuffer)` → stores `sha256:${hex}` in `events.content_hash`
- `uploadS3Object()` in `s3.ts` returns `void` — the S3 PutObject ETag is **discarded**
- ETag passed as empty string `""` to `upsertWatchedKey`

### Scans (`web/lib/media/bucket-service.ts`)
- Stores `etag:${obj.etag}` in `events.content_hash` (line 261)
- ETag extracted from `listS3Objects()` which cleans it: `(obj.ETag ?? "").replace(/"/g, "")`
- Also passed to `upsertWatchedKey()`

### Problem
Upload (`sha256:...`) and scan (`etag:...`) use incompatible hash algorithms — same content won't match across them.

### Fix
Modify `uploadS3Object()` to return the ETag from PutObject response, then store `etag:${s3Etag}` as `content_hash` for uploads (matching scan behavior). Optionally stash sha256 in `metadata.sha256`.

## Database Layer (`web/lib/media/db.ts`)

### EventRow Interface
```typescript
export interface EventRow {
  id: string; timestamp: string; device_id: string; type: string;
  content_type: string | null; content_hash: string | null;
  local_path: string | null; remote_path: string | null;
  metadata: Record<string, unknown> | null; parent_id: string | null;
  bucket_config_id?: string | null; user_id: string;
}
```

### Key Functions
- `findEventByHash(client, hash, userId?)` — finds one event by exact hash match, filters `type: "create"`
- `queryEvents(client, opts)` — supports search, type, since, until, device, bucketConfigId, limit/offset
- `getStats(client, userId, bucketConfigId?)` — uses RPC for aggregate counts
- `insertEvent(client, event)` — inserts with `withRetryDb` wrapper
- All functions return `{ data, error }` (Supabase shape, passed through per CLAUDE.md)

### Schema
- `events.content_hash` — TEXT column with `idx_events_content_hash` index (already exists)
- `watched_keys.etag` — TEXT column storing S3 ETag per key
- RPC functions take explicit `p_user_id UUID` for tenant isolation

## API Route Patterns

### Auth
```typescript
const auth = await authenticateRequest(request);
if (!isAuthenticated(auth)) return auth;
// auth.supabase, auth.user.id available
```

### Response Format
- Success: `NextResponse.json({ data })` or `{ data, count }`
- Error: `NextResponse.json({ error }, { status: 500 })`
- Creation: `NextResponse.json({ data }, { status: 201 })`

### Query Params
```typescript
const params = request.nextUrl.searchParams;
const bucketConfigId = params.get("bucket_config_id") ?? undefined;
```

## CLI Patterns (`web/bin/smgr.ts`)

### API Helpers
- `apiFetch(path, options)` — adds Bearer token, calls `SMGR_WEB_URL`
- `apiGet<T>(path)` — GET + parse JSON, throws on error
- `apiPost<T>(path, body)` — POST + parse JSON

### Bucket Resolution
```typescript
async function resolveBucketId(name: string): Promise<string>
// Fetches /api/buckets, finds by bucket_name
```

### Command Pattern
- Parse args with `parseArgs()`, build URLSearchParams, call `apiGet()`
- Output as JSON (`--json`) or formatted table

### Exit Codes
- 0: SUCCESS, 1: USER, 2: SERVICE, 3: INTERNAL

## Testing Patterns

### Integration Tests
- `createTestUser()` → returns `{ userId, client }`
- Cleanup in reverse dependency order (enrichments → watched_keys → events → bucket_configs → ...)
- Tests call db functions directly against real Supabase

### CLI E2E Tests
- `runCli(args, extraEnv)` → `{ stdout, stderr, exitCode }`
- Uses `tsx` to run `bin/smgr.ts` as subprocess
- Sets `SMGR_WEB_URL` to local dev server
