# Section 01: Extract Shared Bucket Service

## Goal

Extract bucket config lookup, decryption, S3 client creation, scan, and enrich logic from `lib/agent/core.ts` into a reusable `lib/media/bucket-service.ts`. The agent core becomes a thin caller; API routes and future consumers use the same helpers.

## Files to Create

### `web/lib/media/bucket-service.ts`

Extract and generalize the following from `lib/agent/core.ts`:

**Types (exported):**
- `BucketConfig` — the row shape with decrypted `secret_access_key` (matches existing private type in core.ts)
- `BucketConfigResult` — `{ exists, config?, error? }` (same as existing)
- `ScanResult` — `{ total_objects, already_indexed, new_objects, created_events, per_object[] }`
- `EnrichResult` — `{ enriched, failed, skipped, total }`

**Functions (exported):**

1. `getBucketConfig(supabase, userId, bucketNameOrId)` — Fetch bucket config by name or UUID, decrypt secret, lazy-migrate if needed. Generalized from existing `getBucketConfig` which takes `phoneNumber` (remove phone dependency). Accept either bucket_name or bucket id (UUID format detection).

2. `createS3ClientFromConfig(config: BucketConfig)` — Create an S3Client from a decrypted BucketConfig. Thin wrapper around `createS3Client` from `lib/media/s3.ts`.

3. `testBucketConnectivity(s3, bucketName)` — Try ListObjectsV2 (then v1 fallback) with MaxKeys=1. Return `{ success, has_objects, message }`. Extracted from `verifyBucketConfig` in core.ts.

4. `scanBucket(supabase, s3, config, userId, opts)` — Scan S3 for new objects, insert events + watched_keys. Extracted from `indexBucket` in core.ts. `opts` includes `prefix`, `batch_size`, `auto_enrich`, `device_id`.

5. `enrichBucketPending(supabase, s3, config, userId, opts)` — Download unenriched images from this bucket, call enrichment, save results. `opts` includes `event_id` (single), `concurrency`, `dry_run`. Uses model config from DB (not env var).

**Key differences from current core.ts code:**
- No `phoneNumber` parameter — use `userId` directly (API routes already have userId from auth)
- No JSON.stringify of results — return typed objects, callers decide serialization
- No `errorResponse()` calls — throw typed errors or return result objects
- `scanBucket` should call `insertEvent` and `upsertWatchedKey` from `lib/media/db.ts` with `bucket_config_id` set
- `enrichBucketPending` should query events for this bucket that lack enrichments, then process them

## Files to Modify

### `web/lib/agent/core.ts`

- Remove the private functions: `getBucketConfig`, `requireS3Client`, `verifyBucketConfig`, `listObjects`, `countObjects`, `indexBucket`, and all their associated private types (`BucketConfig`, `BucketConfigResult`, `S3ClientResult`)
- Import from `lib/media/bucket-service.ts` instead
- Update `addBucket`, `removeBucket`, `listBuckets` to remain in core.ts (they are WhatsApp-specific wrappers that stringify results)
- Update `executeAction` cases (`test_bucket`, `list_objects`, `count_objects`, `index_bucket`) to call bucket-service functions and stringify the results
- Remove `ListObjectsV2Command`, `ListObjectsCommand` imports (moved to bucket-service)

## Tests to Write

### `web/__tests__/bucket-service.test.ts`

Mock Supabase client and S3 client. Test:

1. `getBucketConfig` — happy path (fetches, decrypts, returns config)
2. `getBucketConfig` — bucket not found returns `{ exists: false }`
3. `getBucketConfig` — decryption failure returns `{ exists: true, error }`
4. `getBucketConfig` — lazy migration fires when `needsMigration` returns true
5. `getBucketConfig` — accepts bucket name or UUID
6. `createS3ClientFromConfig` — creates client with correct params
7. `testBucketConnectivity` — success with v2
8. `testBucketConnectivity` — fallback to v1
9. `testBucketConnectivity` — failure returns error message
10. `scanBucket` — finds new objects, inserts events + watched_keys, skips already-indexed
11. `scanBucket` — with auto_enrich, enriches images
12. `enrichBucketPending` — enriches pending images, returns counts

Follow existing test patterns: use `vi.mock`, `vi.stubEnv` for `ENCRYPTION_KEY_CURRENT`, mock `@supabase/supabase-js` and `@aws-sdk/client-s3`.

## Acceptance Criteria

- [ ] `bucket-service.ts` exports all 5 functions with proper TypeScript types
- [ ] `agent/core.ts` compiles and all existing agent tests pass (no behavior change)
- [ ] New unit tests for bucket-service pass
- [ ] No circular dependencies introduced
- [ ] `npm run typecheck` passes
- [ ] `npm run test` passes (unit tests)
