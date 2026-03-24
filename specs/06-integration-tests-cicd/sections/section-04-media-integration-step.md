# Section 04: Add Media Integration Test Step

## Context

The media pipeline integration tests (`media-db.test.ts`, `media-s3.test.ts`, `media-pipeline.test.ts`) validate the full media workflow: S3 storage, database operations, and the combined pipeline. They require a running local Supabase instance with a storage bucket.

Unlike the DB tests, the media tests have **no `skipIf` guard** — they will throw on missing `SUPABASE_SECRET_KEY` (from `setup.ts`'s `getAdminClient()`). However, an empty `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` creates a client with empty auth that produces cryptic errors rather than a clear failure.

## Implementation

### Add a new step to the `integration-tests` job

**File:** `.github/workflows/ci.yml`
**Position:** After "Run DB integration tests", before "FTS smoke test"

```yaml
- name: Run media integration tests (S3, DB, pipeline)
  run: cd web && npm run test:media-integration
```

### What this runs:

`npm run test:media-integration` → `vitest run --config vitest.media-integration.config.ts`

Which executes:
- **`media-db.test.ts`** — Event insertion, enrichment CRUD, full-text search queries, watched keys operations, multi-user isolation
- **`media-s3.test.ts`** — S3 upload via Supabase Storage API, list objects, retrieve objects, bucket operations
- **`media-pipeline.test.ts`** — Full pipeline combining S3 upload + DB event creation + mocked enrichment

Timeout: 60 seconds per test.

### S3 credential note:

The `setup.ts` helper uses the Supabase service role key as both S3 `accessKeyId` and `secretAccessKey`. This works with local Supabase Storage's S3-compatible API. The CI job also extracts proper S3 credentials (`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`), but the media tests don't use them. This divergence is acceptable for local testing.

### Prerequisites in the CI job:

The "Create storage bucket" step (already in the job) creates the `media` bucket needed by these tests. The env vars are set by Section 01 and verified by Section 02.

## Tests

```bash
# Verify locally:
# 1. supabase start
# 2. Create media bucket: curl -X POST "http://127.0.0.1:54321/storage/v1/bucket" \
#      -H "Authorization: Bearer <service_role_key>" \
#      -H "Content-Type: application/json" \
#      -d '{"id":"media","name":"media","public":false}'
# 3. Export NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY
# 4. cd web && npm run test:media-integration
# 5. Verify non-zero pass count
# 6. Run both suites sequentially to verify no interference:
#    cd web && npm run test:integration && npm run test:media-integration
```

## Acceptance Criteria

- [ ] New step runs `cd web && npm run test:media-integration`
- [ ] Positioned after "Run DB integration tests"
- [ ] Positioned before "FTS smoke test"
- [ ] Storage bucket created before tests run (existing step)
- [ ] Tests pass with correct env vars and running Supabase
