# Section 05: API Filters, Env Var Cleanup, and Integration Tests

## Goal

Add bucket filtering to existing API routes, clean up obsolete env vars, and ensure integration tests pass without S3 credentials on the CLI side.

## Files to Modify

### `web/app/api/events/route.ts`

**GET /api/events** — Add optional `bucket_config_id` query param:
```typescript
const bucketConfigId = params.get("bucket_config_id") ?? undefined;
// ... add to query
if (bucketConfigId) query = query.eq("bucket_config_id", bucketConfigId);
```

Also update the `queryEvents` function in `lib/media/db.ts` to accept `bucket_config_id` in `QueryOptions` and filter by it.

### `web/app/api/stats/route.ts`

**GET /api/stats** — Add optional `bucket_config_id` query param:
```typescript
const bucketConfigId = params.get("bucket_config_id") ?? undefined;
```

Also update `getStats` in `lib/media/db.ts` to accept and use `bucket_config_id`.

### `web/lib/media/db.ts`

- Add `bucketConfigId?: string` to `QueryOptions`
- In `queryEvents`: add `.eq("bucket_config_id", opts.bucketConfigId)` when present
- In `getStats`: accept optional `bucketConfigId` parameter, filter counts by it

### Env Var Cleanup

**Remove from `.env.example`** (if it exists):
- `SMGR_S3_BUCKET`
- `SMGR_S3_ENDPOINT`
- `SMGR_S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `SMGR_AUTO_ENRICH`
- `ANTHROPIC_API_KEY` (for CLI usage — server still needs this)

**Keep in `scripts/lib.sh`**: S3 vars are still used for integration test setup.

**Update `web/lib/media/s3.ts`**: The `createS3Client` function still falls back to `process.env.SMGR_S3_ENDPOINT` etc. This is fine for the media proxy and server-side usage, but document that CLI no longer uses these. No code change needed here — the env fallbacks are harmless and used by server-side code.

### Integration Test Updates

**`web/__tests__/integration/smgr-cli.test.ts`:**
- Remove any `SMGR_S3_*` or `S3_*` env vars from the subprocess env
- CLI tests that use `watch` or `add` should use the bucket API flow:
  1. Create a bucket config via API first
  2. Then `smgr watch <bucket-name> --once`
  3. Then `smgr add <bucket-name> <file>`
- If these tests don't exist yet or are too tightly coupled to direct S3, mark them with a TODO for the E2E suite

**`web/__tests__/integration/smgr-e2e.test.ts`:**
- Same: all S3 operations go through the web API
- Ensure bucket is created before scan/upload tests

### Run Full Test Suite

After all changes:
```bash
cd web
npm run typecheck
npm run lint
npm run test
npm run test:integration
npm run build
```

Fix any failures before completing this section.

## Tests to Write/Update

### Update `web/__tests__/db-operations.test.ts`

- Add test for `queryEvents` with `bucketConfigId` filter
- Add test for `getStats` with `bucketConfigId` filter

### Ensure existing tests still pass

- `web/__tests__/agent-actions.test.ts` — agent core still works after refactor
- `web/__tests__/agent-core.test.ts` — same
- `web/__tests__/s3-client.test.ts` — S3 client unchanged
- `web/__tests__/s3-actions.test.ts` — if this tests core.ts actions, verify still passes

## Acceptance Criteria

- [ ] `GET /api/events?bucket_config_id=X` filters events by bucket
- [ ] `GET /api/stats?bucket_config_id=X` returns per-bucket stats
- [ ] `.env.example` no longer has CLI S3 vars
- [ ] Integration tests pass without S3 env vars in CLI subprocess
- [ ] Full test suite passes: typecheck, lint, unit, integration, build
- [ ] No regressions in existing agent functionality
