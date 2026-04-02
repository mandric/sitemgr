# Spec 21: One-Way Sync, watched_keys Removal & Event Op Rename

## Problem

### events.type is ambiguous

The `events.type` column stores `"create"` for every event — uploads, scans, everything. The name is vague: does "create" mean "the file was created", "the event was created", or "the S3 object was created"? There are no other type values in use anywhere in the codebase.

Replace with `events.op` using namespaced operation strings that describe what actually happened:

| op | Meaning |
|---|---|
| `s3:put` | Object uploaded to S3 (via upload route or sync) |
| `s3:scan` | Object discovered via S3 listing (already existed) |

This is extensible to future operations: `s3:delete`, `enrich:complete`, etc. The `s3:put` vs `s3:scan` distinction preserves provenance — "I uploaded this" vs "I found this already there" are meaningfully different.

### watched_keys is redundant

The `watched_keys` table is a materialized cache of "which S3 keys have we already processed." It stores `s3_key`, `etag`, `event_id`, `size_bytes` per object. The scan loop queries it to skip already-seen keys.

This information already exists in the `events` table — every processed S3 object has an event with `remote_path` and `content_hash` (containing the ETag). `watched_keys` is a denormalized copy that:

1. **Can drift from events.** The event insert and watched_key upsert aren't transactional. If one succeeds and the other fails, they're out of sync.
2. **Doesn't detect modifications.** If a file at the same S3 key is edited (new ETag), `watched_keys` still has the old entry. Scan skips it. The change is invisible.
3. **Conflates two concerns.** "What's in S3" (source of truth: S3 itself) and "what have we recorded" (source of truth: events table) are collapsed into a third table that's authoritative for neither.

### No local-to-remote sync exists

There's no command to sync a local directory to an S3 bucket. Users can upload files one at a time via `smgr add <bucket> <file>`, but there's no way to say "make this S3 bucket mirror this local directory."

The current `smgr watch` scans S3 for new objects and indexes them into events, but it doesn't upload anything — it's S3→events, not local→S3.

## Goal

1. **Rename `events.type` → `events.op`** — use namespaced operation strings (`s3:put`, `s3:scan`) instead of ambiguous `"create"`
2. **Remove `watched_keys`** — replace its scan-time role with a direct diff of S3 listing vs events
3. **Add `smgr sync <local-dir> <bucket>`** — one-way sync from local directory to S3, creating events for each upload
4. **Fix scan to detect modified files** — compare ETags, not just key existence

## Design Principles

### S3 is source of truth for remote state

The S3 listing (keys + ETags) tells you exactly what's in the bucket right now. Don't maintain a shadow copy in Postgres.

### Events are the append-only log of what happened

Events record that something happened: a file was uploaded, a file was detected via scan, a file was enriched. Events are immutable. They're the basis for all downstream processing (enrichment, dedup, analytics).

### Sync and scan are separate operations

- **Sync** = local→S3. Compare local directory against S3 listing, upload what's new or changed.
- **Scan** = S3→events. Compare S3 listing against events, create events for anything not yet recorded (or modified since last recording).

Both use the S3 listing as their reference point. Neither needs `watched_keys`.

## Current state

### watched_keys table

```sql
CREATE TABLE watched_keys (
    s3_key      TEXT PRIMARY KEY,
    first_seen  TIMESTAMPTZ NOT NULL,
    event_id    TEXT REFERENCES events(id),
    etag        TEXT,
    size_bytes  BIGINT,
    bucket_config_id UUID,
    user_id     UUID
);
```

### Where watched_keys is used

| Location | Usage |
|----------|-------|
| `bucket-service.ts` scanBucket() | Queries watched_keys to find "new" objects, upserts after creating event |
| `upload/route.ts` | Upserts watched_key after upload |
| `db.ts` | `upsertWatchedKey()`, `getWatchedKeys()` functions |
| `/api/watched-keys/route.ts` | GET/POST API endpoints |
| `smgr.ts` | CLI uses `/api/watched-keys` (indirectly via scan) |
| Integration tests | Cleanup in `setup.ts`, assertions in lifecycle/tenant tests |

### What scan does today

```
1. listS3Objects(bucket)  →  all S3 objects
2. getWatchedKeys(userId)  →  all processed keys  
3. diff: S3 keys NOT in watched_keys  →  "new" objects
4. For each new object:
   a. insertEvent(type='create', content_hash=etag:xxx)   ← will become op='s3:scan'
   b. upsertWatchedKey(key, etag, eventId)                ← will be removed
```

## Proposed changes

### Phase 1: Rename events.type → events.op

**Migration:**
1. Rename column: `ALTER TABLE events RENAME COLUMN type TO op`
2. Update values: `UPDATE events SET op = 's3:put' WHERE op = 'create'`
3. Update indexes: `DROP INDEX idx_events_type`, create new `idx_events_op`
4. Update partial index from spec 19: recreate `idx_events_dedup` with `WHERE op = 's3:put'` (or broader if needed)
5. Update all RPC functions that filter on `type = 'create'` to filter on `op` instead

**Code changes:**
- `EventRow` interface in `db.ts`: rename `type` field to `op`
- All queries filtering `.eq("type", "create")` → `.eq("op", "s3:put")` or `.eq("op", "s3:scan")` as appropriate
- All RPC functions in migrations: `e.type = 'create'` → `e.op IN ('s3:put', 's3:scan')` (both represent indexable content)
- Upload route: `type: "create"` → `op: "s3:put"`
- Scan in bucket-service.ts: `type: "create"` → `op: "s3:scan"`
- Frontend components filtering on type
- All test fixtures and assertions

**Where `type` is currently used (code + SQL):**
- `db.ts`: `queryEvents`, `findEventByHash`, `findDuplicateGroups`, `getPendingEnrichments` — all filter `type = 'create'`
- `bucket-service.ts`: inserts `type: "create"` for scan events
- `upload/route.ts`: inserts `type: "create"` for upload events
- `components/media/actions.ts`: filters `type = 'create'`
- RPC functions: `search_events`, `stats_by_content_type`, `stats_by_event_type`, `find_duplicate_groups` — all reference `type`
- Tests: fixtures use `type: "create"`, assertions check `type`

### Phase 2: Replace watched_keys in scan with events-based diff

Change `scanBucket()` to diff against events instead of watched_keys:

```
1. listS3Objects(bucket)  →  all S3 objects (key, etag, size)
2. Query events: SELECT remote_path, content_hash 
   WHERE user_id=$1 AND bucket_config_id=$2 AND op IN ('s3:put', 's3:scan')
3. Build a map: remote_path → latest content_hash
4. For each S3 object:
   - Build remote_path = s3://{bucket}/{key}
   - If remote_path not in events → new, create event (op='s3:scan')
   - If remote_path in events but etag differs → modified, create new event (op='s3:scan')
   - If remote_path in events and etag matches → already indexed, skip
5. No upsertWatchedKey call
```

This also **fixes the modified file detection gap** — scan will now notice when a file changes.

For the "modified" case, the new event should reference the previous event via `parent_id`, creating an edit chain. This is what `parent_id` was designed for.

### Phase 3: Remove watched_keys from upload

The upload route currently calls `upsertWatchedKey()` after uploading. Remove this call. The event created during upload is sufficient — the next scan will see the event's `remote_path` and skip the file.

### Phase 4: Add smgr sync command

New CLI command: `smgr sync <local-dir> <bucket> [--prefix path/] [--dry-run]`

```
1. List local files recursively (path, size; compute ETag-compatible hash for change detection)
2. listS3Objects(bucket, prefix)  →  remote state
3. Diff:
   - Local file not in S3 → needs upload
   - Local file in S3 but different size/hash → needs upload (overwrite)
   - S3 object not local → ignore (one-way sync, don't delete)
4. Upload each file via POST /api/buckets/{id}/upload
5. Report: N uploaded, M skipped, K errors
```

The `--dry-run` flag shows what would be uploaded without doing it.

**ETag compatibility note:** S3 ETags for single-part uploads are MD5 hashes of the file content. To compare local files against S3 without uploading, compute MD5 locally. This avoids unnecessary uploads when the file hasn't changed.

### Phase 5: Delete watched_keys

1. Remove `watched_keys` table (new migration: `DROP TABLE watched_keys`)
2. Remove `upsertWatchedKey()`, `getWatchedKeys()` from `db.ts`
3. Remove `/api/watched-keys` route
4. Remove watched_keys references from integration test setup/teardown
5. Remove watched_keys from test assertions

### Phase 6: Update API and CLI

- Update `/api/buckets/[id]/scan/route.ts` to use the new scan logic
- Remove `watched-keys` from CLI if directly referenced
- Update help text

## Out of scope

- **Two-way sync** (S3→local). One-way (local→S3) only for now.
- **File deletion sync** (delete from S3 when deleted locally). Ignore for v1.
- **Watch rules / subscriptions** (auto-sync on interval with filters). Future spec — the concept of "watch this bucket + prefix" is configuration, not state. Separate table, separate spec.
- **Conflict resolution** for concurrent edits. Not relevant for one-way sync.
- **Large file / multipart upload support.** Current `uploadS3Object` uses single-part PutObject. Fine for now.

## Migration notes

- The `DROP TABLE watched_keys` migration must run **after** the code changes are deployed (code stops writing to the table first, then table is dropped). In practice, since we're pre-1.0 and the table has no critical data, this can be a single deploy.
- No data migration needed — `watched_keys` data is fully derivable from events + S3 listings.

## Dependencies

- Spec 19 (dedup detection) should merge first — it modifies the upload route and content_hash format. This spec builds on that.
