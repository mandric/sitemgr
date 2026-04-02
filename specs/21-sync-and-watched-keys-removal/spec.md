# Spec 21: One-Way Sync, watched_keys Removal & Event Op Rename

## Problem

### events.type is ambiguous

The `events.type` column stores `"create"` for every event — uploads, scans, everything. The name is vague: does "create" mean "the file was created", "the event was created", or "the S3 object was created"? There are no other type values in use anywhere in the codebase.

Replace with `events.op` using namespaced operation strings that describe what actually happened:

| op | Meaning |
|---|---|
| `s3:put` | Object uploaded/synced to S3 |

This is extensible to future operations (`s3:delete`, `enrich:complete`, etc.) but for now `s3:put` is the only op. Events are only created when something actually changes — not when we observe something that already exists.

### watched_keys is redundant

The `watched_keys` table is a materialized cache of "which S3 keys have we already processed." It stores `s3_key`, `etag`, `event_id`, `size_bytes` per object. The scan loop queries it to skip already-seen keys.

This information already exists in the `events` table — every processed S3 object has an event with `remote_path` and `content_hash` (containing the ETag). `watched_keys` is a denormalized copy that:

1. **Can drift from events.** The event insert and watched_key upsert aren't transactional. If one succeeds and the other fails, they're out of sync.
2. **Doesn't detect modifications.** If a file at the same S3 key is edited (new ETag), `watched_keys` still has the old entry. Scan skips it. The change is invisible.
3. **Conflates two concerns.** "What's in S3" (source of truth: S3 itself) and "what have we recorded" (source of truth: events table) are collapsed into a third table that's authoritative for neither.

### Scan creates noisy events

Today, scan creates `type='create'` events for every S3 object it discovers. But discovering an object that was already in S3 is not something that *happened* — it's an observation. Creating events for observations pollutes the event stream with "I looked at this" records that don't represent state changes.

Events should only be created when something changes: a file is uploaded, synced, modified, or deleted.

### No local-to-remote sync exists

There's no command to sync a local directory to an S3 bucket. Users can upload files one at a time via `smgr add <bucket> <file>`, but there's no way to say "make this S3 bucket mirror this local directory."

The current `smgr watch` scans S3 for new objects and indexes them into events, but it doesn't upload anything — it's S3→events, not local→S3.

## Goal

1. **Rename `events.type` → `events.op`** — use namespaced operation strings (`s3:put`) instead of ambiguous `"create"`
2. **Remove `watched_keys`** — no longer needed
3. **Redefine scan** — scan becomes a read-only diff tool that reports what's in S3 vs what has events, without creating events itself
4. **Add `smgr sync <local-dir> <bucket>`** — one-way sync from local directory to S3, creating `s3:put` events for each upload
5. **Fix change detection** — sync detects modified files by comparing local hashes against S3 ETags

## Design Principles

### S3 is source of truth for remote state

The S3 listing (keys + ETags) tells you exactly what's in the bucket right now. Don't maintain a shadow copy in Postgres.

### Events record state changes only

Events record that something *happened*: a file was uploaded, modified, deleted. Not that something was *observed*. This keeps the event stream meaningful and queryable. All events have `op='s3:put'` (for now) — every event in the table represents a write to S3.

### Sync is the write path, scan is the read path

- **Sync** = local→S3. Compare local directory against S3 listing, upload what's new or changed, create `s3:put` events.
- **Scan** = read-only diff. Compare S3 listing against events, report what's untracked or modified. No events created — the user decides what to do with the information.

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

### What scan does today (will change)

```
1. listS3Objects(bucket)  →  all S3 objects
2. getWatchedKeys(userId)  →  all processed keys  
3. diff: S3 keys NOT in watched_keys  →  "new" objects
4. For each new object:
   a. insertEvent(type='create', content_hash=etag:xxx)   ← will be removed
   b. upsertWatchedKey(key, etag, eventId)                ← will be removed
```

## Proposed changes

### Phase 1: Rename events.type → events.op

**Migration:**
1. Rename column: `ALTER TABLE events RENAME COLUMN type TO op`
2. Update values: `UPDATE events SET op = 's3:put' WHERE op = 'create'`
3. Update indexes: `DROP INDEX idx_events_type`, create new `idx_events_op`
4. Update partial index from spec 19: recreate `idx_events_dedup` with `WHERE op = 's3:put'`
5. Update all RPC functions that filter on `type = 'create'` to filter on `op = 's3:put'`

**Code changes:**
- `EventRow` interface in `db.ts`: rename `type` field to `op`
- All queries filtering `.eq("type", "create")` → `.eq("op", "s3:put")`
- All RPC functions in migrations: `e.type = 'create'` → `e.op = 's3:put'`
- Upload route: `type: "create"` → `op: "s3:put"`
- Scan in bucket-service.ts: `type: "create"` → `op: "s3:put"` (temporarily, until scan is rewritten in phase 2)
- Frontend components filtering on type
- All test fixtures and assertions

**Where `type` is currently used (code + SQL):**
- `db.ts`: `queryEvents`, `findEventByHash`, `findDuplicateGroups`, `getPendingEnrichments` — all filter `type = 'create'`
- `bucket-service.ts`: inserts `type: "create"` for scan events
- `upload/route.ts`: inserts `type: "create"` for upload events
- `components/media/actions.ts`: filters `type = 'create'`
- RPC functions: `search_events`, `stats_by_content_type`, `stats_by_event_type`, `find_duplicate_groups` — all reference `type`
- Tests: fixtures use `type: "create"`, assertions check `type`

### Phase 2: Rewrite scan as read-only diff

Change `scanBucket()` from "create events for new S3 objects" to "report what's in S3 vs what has events." Scan no longer writes to the database.

**New scan behavior:**
```
1. listS3Objects(bucket)  →  all S3 objects (key, etag, size)
2. Query events: SELECT remote_path, content_hash 
   WHERE user_id=$1 AND bucket_config_id=$2 AND op = 's3:put'
3. Build a map: remote_path → latest content_hash
4. For each S3 object:
   - Build remote_path = s3://{bucket}/{key}
   - If remote_path not in events → report as "untracked"
   - If remote_path in events but etag differs → report as "modified"
   - If remote_path in events and etag matches → report as "synced"
5. Return the diff report (no events created, no watched_keys upserted)
```

**Scan output:**
```
Bucket: my-photos
  Synced:     847 files
  Untracked:  12 files (not yet uploaded via sync)
  Modified:   3 files (S3 content changed since last sync)

Untracked:
  photos/new-vacation/IMG_001.jpg (4.2 MB)
  photos/new-vacation/IMG_002.jpg (3.8 MB)
  ...

Modified:
  photos/beach.jpg (etag changed)
  ...
```

This gives the user actionable information. They can then run `smgr sync` to upload local files, or investigate modifications.

### Phase 3: Remove watched_keys from upload and scan

1. Remove `upsertWatchedKey()` call from upload route
2. Remove `upsertWatchedKey()` and `getWatchedKeys()` calls from `scanBucket()`
3. The event created during upload is the only record needed

### Phase 4: Add smgr sync command

New CLI command: `smgr sync <local-dir> <bucket> [--prefix path/] [--dry-run]`

```
1. List local files recursively (path, size; compute MD5 for change detection)
2. listS3Objects(bucket, prefix)  →  remote state
3. Diff:
   - Local file not in S3 → needs upload
   - Local file in S3 but different hash/size → needs upload (overwrite)
   - S3 object not local → ignore (one-way sync, don't delete)
4. Upload each file via POST /api/buckets/{id}/upload (creates s3:put events)
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

- Update `/api/buckets/[id]/scan/route.ts` to return the diff report instead of creating events
- Remove `watched-keys` from CLI if directly referenced
- Update help text

## Out of scope

- **Two-way sync** (S3→local). One-way (local→S3) only for now.
- **File deletion sync** (delete from S3 when deleted locally). Ignore for v1.
- **Watch rules / subscriptions** (auto-sync on interval with filters). Future spec — the concept of "watch this bucket + prefix" is configuration, not state. Separate table, separate spec.
- **Conflict resolution** for concurrent edits. Not relevant for one-way sync.
- **Large file / multipart upload support.** Current `uploadS3Object` uses single-part PutObject. Fine for now.
- **Importing pre-existing S3 objects.** Files already in S3 that weren't uploaded via sitemgr have no events. A future `smgr import` command could create `s3:put` events for them. Out of scope for this spec.

## Migration notes

- The `DROP TABLE watched_keys` migration must run **after** the code changes are deployed (code stops writing to the table first, then table is dropped). In practice, since we're pre-1.0 and the table has no critical data, this can be a single deploy.
- No data migration needed — `watched_keys` data is fully derivable from events + S3 listings.
- The `type` → `op` column rename and value update can be a single migration since we're pre-1.0.

## Dependencies

- Spec 19 (dedup detection) should merge first — it modifies the upload route and content_hash format. This spec builds on that.
