# Section 04: CLI Updates

## Goal

Update `web/bin/smgr.ts` to use the new bucket API routes. Remove all direct S3 access, enrichment imports, and S3-related env vars/flags. The CLI becomes a pure HTTP client.

## Files to Modify

### `web/bin/smgr.ts`

**Add `bucket` subcommand group:**

Add a `cmdBucket` dispatcher that routes to sub-handlers:

```
smgr bucket add       -> POST /api/buckets
smgr bucket list      -> GET /api/buckets
smgr bucket remove <name> -> resolve name to id, DELETE /api/buckets/[id]
smgr bucket test <name>   -> resolve name to id, POST /api/buckets/[id]/test
```

- `bucket add`: Collect fields via flags (`--bucket-name`, `--endpoint-url`, `--region`, `--access-key-id`, `--secret-access-key`). If any required flag is missing, error with usage message. Call `apiPost("/api/buckets", body)`. Print result.
- `bucket list`: Call `apiGet("/api/buckets")`. Print as table (name, region, endpoint, created_at).
- `bucket remove <name>`: Call `apiGet("/api/buckets")` to resolve name to id. Then `apiFetch("/api/buckets/${id}", { method: "DELETE" })`. Confirm removal.
- `bucket test <name>`: Resolve name to id. Call `apiPost("/api/buckets/${id}/test", {})`. Print connectivity result.

**Helper: `resolveBucketId(name)`**
- Call `GET /api/buckets`, find the bucket with matching `bucket_name`
- If not found, `cliError("Bucket not found: <name>")`
- Return the bucket's `id`

**Update `cmdWatch`:**
- Remove all S3 options (`s3Options`, `resolveS3Args`)
- First positional arg is `<bucket>` (bucket name)
- Resolve bucket name to id via `resolveBucketId`
- Each scan cycle: `apiPost("/api/buckets/${id}/scan", { prefix, batch_size, auto_enrich, device_id })`
- Print scan results (new objects found, events created)
- Poll loop stays in CLI (interval, max-errors, SIGINT handling)
- `--once` calls scan once and exits

**Update `cmdAdd`:**
- First positional is `<bucket>`, second is `<file>`
- Resolve bucket name to id
- Read file locally
- Upload via multipart POST to `/api/buckets/${id}/upload`
- Use `FormData` with `Blob` for the file, optional `prefix` field
- Adjust `apiFetch` to NOT set `Content-Type: application/json` when body is `FormData`
- Print created event id

**Update `cmdEnrich`:**
- First positional is `<bucket>` (required for `--pending` mode)
- Resolve bucket name to id
- `--pending`: `apiPost("/api/buckets/${id}/enrich", { concurrency })`
- `--dry-run`: `apiPost("/api/buckets/${id}/enrich", { dry_run: true })`
- `--status`: keep existing `apiGet("/api/enrichments/status")` (not bucket-specific)
- Single event: `apiPost("/api/buckets/${id}/enrich", { event_id })`
- Remove all S3 download + local enrichment logic
- Remove `enrichImage` import
- Remove `modelConfig` loading at startup (server handles model config)

**Update `cmdQuery`:**
- Add optional `--bucket <name>` flag
- If provided, resolve to `bucket_config_id` and add to query params

**Update `cmdStats`:**
- Add optional `--bucket <name>` flag
- If provided, resolve to `bucket_config_id` and add to query params

**Remove from smgr.ts:**
- `s3Options` object
- `resolveS3Args()` function
- All imports: `createS3Client`, `listS3Objects`, `downloadS3Object`, `uploadS3Object`
- `enrichImage` import and `ModelConfig` type import
- `pLimit` import
- `sha256Bytes` import (hash computed server-side now)
- `readFileSync`, `statSync` imports — replace with file read for upload only (keep `readFileSync` for that)
- `s3Metadata`, `isMediaKey` imports (used server-side now)
- `S3ErrorType` import and `exitCodeForS3Error` function
- `modelConfig` variable and startup loading block
- All `SMGR_S3_*`, `S3_*`, `ANTHROPIC_API_KEY` env var references

**Update help text:**
- Remove "S3 flags" section
- Update command descriptions to show bucket-first UX
- Update "Environment" section to only show `SMGR_WEB_URL`
- Update usage examples

**Update `apiFetch`:**
- When `options.body` is a `FormData` instance, do NOT set `Content-Type` header (browser/node sets multipart boundary automatically)

**Update command registry:**
- Add `bucket` command
- Keep `login`, `logout`, `whoami`, `query`, `show`, `stats`, `enrich`, `watch`, `add`

## Tests to Write

### `web/__tests__/smgr-cli-bucket.test.ts`

Unit tests for the new CLI bucket commands. Mock `apiFetch`/`apiGet`/`apiPost` or mock `fetch` globally.

1. `bucket list` — calls GET /api/buckets, prints table
2. `bucket add` — calls POST /api/buckets with correct body
3. `bucket add` — errors on missing required flags
4. `bucket remove <name>` — resolves name, calls DELETE
5. `bucket test <name>` — resolves name, calls POST test
6. `watch <bucket>` — resolves bucket, calls scan API
7. `add <bucket> <file>` — reads file, uploads via multipart
8. `enrich <bucket> --pending` — calls enrich API

### Update `web/__tests__/integration/smgr-cli.test.ts`

- Remove S3 env vars from test subprocess environment
- Tests that use `watch`/`add` should work through the API (requires running Next.js dev server + Supabase)

## Acceptance Criteria

- [ ] `smgr bucket list/add/remove/test` commands work
- [ ] `smgr watch <bucket>` scans via API, no local S3 access
- [ ] `smgr add <bucket> <file>` uploads via API
- [ ] `smgr enrich <bucket> --pending` enriches via API
- [ ] No S3 SDK imports remain in `smgr.ts`
- [ ] No `enrichImage` import remains in `smgr.ts`
- [ ] No `ANTHROPIC_API_KEY`, `SMGR_S3_*`, `S3_*` env var references remain
- [ ] Help text is updated
- [ ] `npm run typecheck` passes
- [ ] Unit tests pass
