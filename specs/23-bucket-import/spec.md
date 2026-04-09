# Spec 23: `sitemgr import` — ingest pre-existing S3 objects

## Problem

After spec 21, `sitemgr enrich --pending` walks the `events` table to find media that needs enrichment. Events are created as a side effect of `sitemgr sync` uploading files. This leaves a gap: **S3 objects that already exist but were never uploaded via sitemgr have no event, so they're invisible to `enrich`.**

Concretely, if a user already has a bucket with thousands of photos and wants to enrich them without re-uploading, they have no path to do so. `sync` only works local → S3. `scan` is read-only. The spec-21 doc explicitly flagged this as out of scope and named a future `sitemgr import` command as the expected solution.

## Goal

Add a one-way command that walks an existing S3 bucket, identifies objects that have no matching event, and creates one `s3:put` event per untracked object so that `enrich --pending` can process them.

```
sitemgr import <bucket> [--prefix path/] [--dry-run] [--concurrency N]
```

After `import` runs, `enrich --pending` works unchanged — the pre-existing S3 objects are now represented in the events table.

Typical flow on a bucket that already holds media:

```
sitemgr scan my-photos                   # diagnostic: see what's untracked
sitemgr import my-photos                 # create s3:put events for untracked
sitemgr enrich my-photos --pending       # enrich the newly-tracked events
```

## Design

### Import composes on top of scan

`scanBucket` already produces exactly the data import needs. Its `.untracked` array contains `{key, remote_path, size, etag}` for every S3 object with no matching event. **Import does not re-implement the S3↔events diff** — it calls `scanBucket(...)`, takes `.untracked`, and inserts events for each entry. Scan stays single-purpose; import is the write-side counterpart of the same diff.

```
1. scanBucket(s3, config, userId, { prefix })   → { untracked: [...] }
2. For each untracked object:
     { op: "s3:put", content_hash: `etag:${etag}`,
       remote_path, metadata: { ..., source: "s3-import" },
       bucket_config_id, user_id }
3. Batched INSERT into events
4. Return { imported: N, skipped: M, errors: K }
```

### Event shape — reuse `s3:put` with provenance metadata

Imported events use `op: "s3:put"`, matching the existing upload and sync paths. The op value is "this path now has an event at this hash"; the provenance lives in `metadata.source`.

- Upload via `POST /api/buckets/[id]/upload`: `metadata.source = "api-upload"`
- Sync via `sitemgr sync`: `metadata.source = "api-upload"` (goes through the upload route)
- **Import via `sitemgr import`**: `metadata.source = "s3-import"` *(new)*

Why not a new op like `s3:indexed`?

- Enrich (`db.ts:getPendingEnrichments`, `db.ts:getEnrichStatus`) filters on `op = 's3:put'`. A new op would require updating every filter across the codebase plus the spec-19 partial index `idx_events_dedup` (which has `WHERE op = 's3:put'` in its predicate). That's a migration + wide code sweep for a semantic nuance.
- Dedup already works correctly with `content_hash = 'etag:<etag>'` — an imported event and a sync event pointing at the same S3 object naturally collide in the dedup check.
- The `source` metadata field already exists for exactly this purpose (distinguishing origins).

The op stays clean; the source is where you look for "who wrote this."

### Content hash uses `etag:<etag>`

Same format as sync and upload. For single-part PutObject uploads the ETag is MD5, so dedup works correctly when an imported object matches content sitemgr already knows about. For multipart uploads the ETag is `<md5>-<N>` — still a unique key, but won't collide with single-part hashes of the same content. Same caveat as sync; acceptable for v1.

### Content type detection

Import doesn't download objects, so content type has to come from the key alone. Use the existing `detectContentType(key)` + `getMimeType(key)` helpers (the same ones upload and the old scanBucket pre-spec-21 used). Objects with unknown extensions get `content_type: "file"`.

### No download during import

Import does not download any S3 content. It only needs what `listS3Objects` returns: `{key, size, etag, lastModified}`. Downloading would:
- Be slow (N requests, one per object)
- Require enrichment-level compute during import (content hashing, etc.)
- Defeat the purpose of keeping enrich as a separate step users opt into

Content hashing via SHA256 of the actual bytes is an enrichment concern, not an import concern. Import uses the ETag-based hash, same as sync and the old scanBucket.

### Batched inserts for efficiency

The naive `for obj in untracked: insertEvent(obj)` does one HTTP round-trip per object. For 10k+ untracked objects this is painfully slow. Import batches inserts in chunks of **500 rows per request** (PostgREST accepts arrays; a single `.insert([...])` call inserts the whole batch in one transaction). With `p-limit(3)` wrapping the batch calls, this gives bounded concurrency on the insert side without hammering the database.

For a 100k-object bucket: ~200 batches, ~67 network round-trips with concurrency 3. Acceptable.

### Idempotency

Running `import` twice on the same bucket must be safe. The second run:
1. `scanBucket` re-queries events, sees the events from the first run, classifies those objects as `synced` (not `untracked`)
2. The `.untracked` set is empty
3. Zero inserts

So idempotency falls out of reusing scan — no dedup logic needed in import itself.

Edge case: if a file changes between the first and second run (new ETag), scan classifies it as `modified` (not `untracked`). Import currently skips modified — those need sync (or a future `import --update` flag) to pick up. **This spec explicitly does not handle modified objects.** Import is strictly "fill in events for untracked objects."

## API

### New route: `POST /api/buckets/[id]/import`

Request body:

```json
{
  "prefix": "photos/",      // optional, forwarded to scanBucket
  "dry_run": false,          // optional, default false
  "batch_size": 500          // optional, default 500
}
```

Response (success):

```json
{
  "data": {
    "bucket": "my-photos",
    "untracked_count": 1234,   // from scan
    "imported": 1234,          // actually inserted
    "skipped": 0,              // reserved for future (e.g. size-too-large)
    "errors": 0,
    "dry_run": false
  }
}
```

If `dry_run: true`: return the counts without writing anything.

Response (error): standard `{ error: "..." }` shape at the relevant HTTP status.

### Auth

Same pattern as every other bucket-scoped route: `authenticateRequest` + `getBucketConfig`. Tenant isolation is enforced by `bucket_config_id` + `user_id` on the inserted rows, which RLS on `events` checks.

## CLI

### New command: `sitemgr import <bucket> [--prefix path/] [--dry-run] [--concurrency N]`

```
$ sitemgr import my-photos --dry-run
Scanning bucket "my-photos"...
Found 8472 total objects
  Already tracked: 412
  Untracked:       8060
  Modified:        0 (not imported — use 'sitemgr sync' or delete+re-import)

Dry run — would import 8060 events.

$ sitemgr import my-photos
Scanning bucket "my-photos"...
Found 8472 total objects
Importing 8060 events (batch size: 500)...
[500/8060] 6.2%
[1000/8060] 12.4%
...
[8060/8060] 100%

Imported: 8060  Skipped: 0  Errors: 0
```

- `--dry-run` short-circuits before the inserts, prints the count, exits 0
- `--concurrency N` controls the in-flight insert batches (default 3)
- Exit code 2 if any insert batch errors (partial progress is kept)

Add `import` to the `commands` map, help text, and CLI entry point.

## Code changes

### New migration?

**No migration required.** Import only writes to `events` (existing table, existing columns, existing op value). No schema changes, no new indexes, no RPC updates.

### `web/lib/media/bucket-service.ts`

Add a new exported function:

```ts
export type ImportResult = {
  bucket: string;
  untracked_count: number;
  imported: number;
  skipped: number;
  errors: number;
  dry_run: boolean;
};

export async function importBucket(
  client: SupabaseClient,
  s3: S3Client,
  config: BucketConfig,
  userId: string,
  opts: {
    prefix?: string;
    dry_run?: boolean;
    batch_size?: number;
    concurrency?: number;
  } = {},
): Promise<ImportResult>
```

Implementation:
1. Call `scanBucket(client, s3, config, userId, { prefix: opts.prefix })` → get the untracked array
2. If `opts.dry_run`, return counts without inserting
3. Build event rows for each untracked object (use `newEventId`, `detectContentType`, `getMimeType`, `s3Metadata` from `lib/media/utils`)
4. Chunk into batches of `opts.batch_size ?? 500`
5. Insert each batch via `client.from("events").insert(batch)` under `pLimit(opts.concurrency ?? 3)`
6. Count successes vs failures per batch; log each batch failure
7. Return `ImportResult`

### `web/app/api/buckets/[id]/import/route.ts` *(new)*

POST handler: authenticate, load bucket config, create S3 client, call `importBucket`, return JSON. Mirror the existing `scan` route structure.

### `web/bin/sitemgr.ts`

Add `cmdImport(args)`:
- `parseArgs` for `--prefix`, `--dry-run`, `--concurrency`, `--verbose`
- Resolve bucket ID, POST to `/api/buckets/{id}/import`
- Print progress from the response (no streaming — the request is synchronous, CLI just displays the final counts)

Register `import` in the `commands` map and update the help block.

## Tests

### Integration test: `web/__tests__/integration/bucket-import.test.ts` *(new)*

Scenarios:
1. **Import an untracked bucket creates N events.** Upload 3 fixtures directly to S3 (bypass sitemgr), call `importBucket`, verify 3 events exist with `op = 's3:put'` and `metadata.source = 's3-import'`.
2. **Import is idempotent.** Run import twice; second run imports 0.
3. **Import with prefix only imports matching objects.** Upload 3 objects under `foo/`, 3 under `bar/`, call import with `prefix: "foo/"`, verify exactly 3 events.
4. **Import with `dry_run: true` makes no writes.** Verify event count is unchanged after a dry-run call.
5. **Modified objects are skipped.** Seed an event with an old ETag, upload a new version to S3, run import, verify the modified object is NOT imported (still has only the original event).
6. **Imported events are compatible with `enrich`.** Seed an untracked image, run import, then verify `getPendingEnrichments` returns it.

### E2E CLI test: extend `sitemgr-pipeline.test.ts`

The pipeline test currently uses `sitemgr sync` to upload fixtures. Add a complementary test that exercises the import path: upload fixtures to a fresh prefix directly via the admin S3 client (simulating pre-existing content), call `sitemgr import <bucket> --prefix newprefix/`, verify stats.total_events bumps and the events show up in `query --format json`.

### Unit tests

None needed — import is thin glue over existing functions; the logic under test is integration-level (SQL writes, scan reuse, batching).

## Out of scope

- **Importing modified objects** (S3 content changed since last event). Current spec only handles untracked. A future `--update` flag could insert a new `s3:put` event for the new ETag, but that's a different command (and overlaps with what sync does).
- **Deleting events for objects no longer in S3.** Reverse direction, out of scope.
- **Importing with content hashing.** Import only uses ETag-based hashes. Real content hashes (SHA256) would require downloading objects, which belongs to enrichment.
- **Filters beyond `--prefix`.** No `--content-type` / `--size` / `--modified-since` filters. Add later if needed.
- **Parallel scans across prefixes.** Import is sequential across a single prefix. Users can run multiple imports with different prefixes in parallel if they need it.
- **Resumability.** If import fails partway through, the user re-runs it; idempotency (via scan's re-classification as `synced`) ensures no duplicates.

## Dependencies

- Spec 21 (sync + watched_keys removal + events.op rename) must be merged first. This spec builds directly on `scanBucket`'s diff-report output and the `source` metadata pattern.
