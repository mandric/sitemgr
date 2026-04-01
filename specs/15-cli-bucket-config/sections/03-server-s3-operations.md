# Section 03: Server-Side S3 Operation Routes

## Goal

Create API routes for scan, upload, and enrich operations that run server-side. The server fetches bucket credentials from DB, performs S3 operations, and returns results. The CLI never touches S3 directly.

## Files to Create

### `web/app/api/buckets/[id]/scan/route.ts`

**POST /api/buckets/[id]/scan** — Scan bucket for new objects, create events.
- Auth: `authenticateRequest` pattern
- Fetch bucket config via `getBucketConfig(supabase, user.id, params.id)`
- If not found: 404
- Create S3 client via `createS3ClientFromConfig(config)`
- Call `scanBucket(supabase, s3, config, user.id, opts)` from bucket-service
- Body params: `{ prefix?, batch_size?, auto_enrich?, device_id? }`
  - `device_id` defaults to `"api"` if not provided
- Response: `{ data: ScanResult }` — includes `total_objects`, `already_indexed`, `new_objects`, `created_events`, `per_object[]`
- Status 200

### `web/app/api/buckets/[id]/upload/route.ts`

**POST /api/buckets/[id]/upload** — Upload a file to S3 via the server.
- Auth: `authenticateRequest` pattern
- Fetch bucket config via `getBucketConfig`
- Accept multipart form data: file + optional `prefix` field
- Read file from form data (`request.formData()`)
- Create S3 client, upload to S3 via `uploadS3Object`
- Compute content hash (`sha256Bytes`), detect content type
- Insert event with `bucket_config_id` set
- Upsert watched key
- Response: `{ data: { event_id, s3_key, content_type } }` with status 201

**Implementation notes for multipart:**
- Use `request.formData()` — Next.js supports this natively
- Get file as `File` object from form data, convert to `Buffer` via `arrayBuffer()`
- Don't set `Content-Type: application/json` header (it's multipart)
- The `apiFetch` helper in the CLI will need adjustment for this route (see section 04)

### `web/app/api/buckets/[id]/enrich/route.ts`

**POST /api/buckets/[id]/enrich** — Enrich unenriched images in this bucket.
- Auth: `authenticateRequest` pattern
- Fetch bucket config via `getBucketConfig`
- Create S3 client
- Call `enrichBucketPending(supabase, s3, config, user.id, opts)` from bucket-service
- Body params: `{ event_id?, concurrency?, dry_run? }`
  - `event_id` — enrich a single event (optional)
  - `concurrency` — max parallel enrichment calls (default 3)
  - `dry_run` — list what would be enriched without doing it
- Response: `{ data: EnrichResult }` — `{ enriched, failed, skipped, total }`

**Enrichment flow (in bucket-service, called by this route):**
1. Query events for this `bucket_config_id` that have no enrichment row
2. For each: download from S3, call `enrichImage`, insert enrichment
3. Model config: load from `model_configs` table for the user (same pattern as CLI's `apiGet("/api/model-config")`, but server-side — query directly)

## Files to Modify

### `web/lib/media/bucket-service.ts` (from section 01)

If not already complete, ensure `scanBucket` and `enrichBucketPending` handle:
- `scanBucket`: respects `batch_size` (default 100), `prefix`, `auto_enrich`, `device_id`
- `enrichBucketPending`: respects `event_id` (single), `concurrency` (via p-limit), `dry_run`
- Both set `bucket_config_id` on inserted rows

## Tests to Write

### `web/__tests__/bucket-operations-api.test.ts`

Mock auth, Supabase, and bucket-service functions.

1. `POST /api/buckets/[id]/scan` — calls scanBucket, returns result
2. `POST /api/buckets/[id]/scan` — returns 404 when bucket not found
3. `POST /api/buckets/[id]/scan` — returns 401 when unauthenticated
4. `POST /api/buckets/[id]/upload` — accepts file, uploads to S3, creates event
5. `POST /api/buckets/[id]/upload` — returns 400 when no file provided
6. `POST /api/buckets/[id]/enrich` — calls enrichBucketPending, returns counts
7. `POST /api/buckets/[id]/enrich` — dry_run returns pending count without enriching
8. `POST /api/buckets/[id]/enrich` — single event_id mode

## Acceptance Criteria

- [ ] All 3 routes exist and handle auth correctly
- [ ] Scan creates events with `bucket_config_id` set
- [ ] Upload handles multipart, stores in S3, creates event
- [ ] Enrich downloads from S3 server-side, calls model API server-side
- [ ] No S3 credentials or model API keys exposed to client
- [ ] Unit tests pass
- [ ] `npm run typecheck` passes
