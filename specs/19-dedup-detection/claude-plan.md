# Implementation Plan: Duplicate Detection & Hash Normalization

## Overview

This plan adds duplicate file detection to sitemgr. It has two parts:

1. **Hash normalization** — Fix the upload path so uploads and scans use the same hash algorithm (S3 ETag), making cross-source dedup possible.
2. **Dedup reporting** — Add an RPC function, API route, and CLI command that find and display duplicate file groups within a bucket.

The feature is report-only. No cleanup, no cross-bucket dedup, no fuzzy matching.

## Background

### The hash mismatch problem

Events in the `events` table have a `content_hash` column. Depending on how the event was created:

- **Scan events** store `etag:${md5}` — the ETag from S3's ListObjectsV2 response
- **Upload events** store `sha256:${hex}` — a SHA-256 hash computed from file bytes

These are different algorithms hashing the same content, so they never match. A file uploaded then scanned produces two events with different `content_hash` values.

### The fix

S3's PutObject response includes the ETag of the uploaded object. By capturing this ETag and storing `etag:${s3Etag}` as `content_hash` for uploads (matching what scans already do), both paths use the same hash space.

This is a pre-1.0 project, so backwards compatibility with existing `sha256:` hashes is not a concern. Old upload events won't participate in dedup — that's acceptable.

### Existing infrastructure

- `events.content_hash` column with `idx_events_content_hash` index — already exists
- `uploadS3Object()` in `web/lib/media/s3.ts` — currently returns `void`, needs to return ETag
- `bucket-service.ts` scan path — already stores `etag:${obj.etag}`, no changes needed
- RPC functions for tenant-isolated queries — established pattern (`search_events`, `stats_by_content_type`)
- API routes with Bearer token auth — established pattern (`authenticateRequest`)
- CLI commands with `apiGet()`/`resolveBucketId()` — established pattern

---

## Section 1: Hash Normalization — S3 Upload Returns ETag

### What changes

**`web/lib/media/s3.ts` — `uploadS3Object()`**

Change the return type from `Promise<void>` to `Promise<string>` (the ETag). Capture the response from `client.send(new PutObjectCommand(...))` and extract `response.ETag`. Strip surrounding quotes using `.replace(/"/g, "")` — the same approach used by `listS3Objects()` for consistency.

**Known limitation:** S3 multipart uploads produce ETags in the format `md5-N` (e.g., `abc123-3`), not plain MD5. Since `uploadS3Object` uses `PutObjectCommand` (single-part), this doesn't affect us now. If multipart upload support is added later, dedup will need to account for this.

**`web/app/api/buckets/[id]/upload/route.ts`**

- Capture the ETag returned by `uploadS3Object()`
- Store `etag:${returnedEtag}` as `content_hash` instead of `sha256Bytes(fileBuffer)`
- Remove the `sha256Bytes` import and the `contentHash` variable assignment (keep the function in utils.ts — other code may use it)
- Pass the actual ETag to `upsertWatchedKey()` (currently passes empty string `""`)
- Update the `s3Metadata(s3Key, fileBuffer.length, "")` call to pass the actual ETag as the third argument (currently passes empty string, should match what scans do)

### Why this design

Option (a) from the spec — cheapest path to unified hashes. S3 already computes the ETag during upload; we just capture it instead of discarding it. No extra computation, no extra storage, no migration.

---

## Section 2: Duplicate Detection RPC

### What changes

**New migration file** (e.g. `supabase/migrations/20260401000000_dedup_rpc.sql`)

Create an RPC function `find_duplicate_groups(p_user_id, p_bucket_config_id)` that:

1. Filters events to `type = 'create'` and `content_hash IS NOT NULL`
2. Filters by `p_user_id` (required, for tenant isolation)
3. Optionally filters by `p_bucket_config_id` (when provided)
4. Groups by `content_hash`
5. Returns only groups with `count(*) > 1`
6. For each group: `content_hash`, `copies` (count), `event_ids` (array), `paths` (array of `remote_path`)
7. Orders by `copies DESC`

Use `LANGUAGE sql STABLE` to match existing RPC patterns (`search_events`, `stats_by_content_type`). Do NOT use `SECURITY DEFINER` — the function must run as `SECURITY INVOKER` (the default) so that RLS on the `events` table enforces tenant isolation. The explicit `p_user_id` parameter provides an additional filter but RLS is the primary isolation mechanism.

At expected scale (under 10K events, under 100 duplicate groups), a sequential scan with RLS filtering is fast. No new indexes are needed — the existing `idx_events_content_hash` helps but the query planner may choose a sequential scan at small table sizes, which is fine.

**`web/lib/media/db.ts` — new function**

```typescript
findDuplicateGroups(
  client: SupabaseClient,
  userId: string,
  bucketConfigId?: string
): Promise<{ data: DuplicateGroup[] | null; error: unknown }>
```

Calls the RPC function via `client.rpc('find_duplicate_groups', { p_user_id, p_bucket_config_id })`. Returns `{ data, error }` — the Supabase shape, passed through without transformation (per CLAUDE.md coding principles).

Define a `DuplicateGroup` interface:

```typescript
interface DuplicateGroup {
  content_hash: string;
  copies: number;
  event_ids: string[];
  paths: string[];
}
```

---

## Section 3: Dedup API Route

### What changes

**New file: `web/app/api/dedup/route.ts`**

`GET /api/dedup?bucket_config_id=X`

- Authenticate via `authenticateRequest()` + `isAuthenticated()` guard (same as all other routes)
- Read `bucket_config_id` from query params — **required** (return 400 if missing)
- Call `findDuplicateGroups(auth.supabase, auth.user.id, bucketConfigId)`
- Return `{ data: { groups, total_duplicate_groups } }` on success
- Return `{ error }` with status 500 on failure

Response shape:

```json
{
  "data": {
    "groups": [
      {
        "content_hash": "etag:abc123",
        "copies": 3,
        "event_ids": ["evt-1", "evt-2", "evt-3"],
        "paths": ["s3://bucket/a.jpg", "s3://bucket/b.jpg", "s3://bucket/c.jpg"]
      }
    ],
    "total_duplicate_groups": 1
  }
}
```

No pagination — expected scale is under 100 groups.

---

## Section 4: CLI Dedup Command

### What changes

**`web/bin/smgr.ts` — new `cmdDedup()` function**

Subcommand: `smgr dedup <bucket-name>`

1. Parse the bucket name argument
2. Resolve bucket name to ID via `resolveBucketId(name)`
3. Call `apiGet(/api/dedup?bucket_config_id=${id})`
4. If no duplicates, print "No duplicates found." and exit 0
5. If duplicates found, display table:

```
Hash              Copies  Paths
─────────────────────────────────────────────────
etag:abc123       3       vacation/beach.jpg
                          exports/IMG_2023.jpg
                          backup/beach-copy.jpg
etag:def456       2       photos/sunset.jpg
                          archive/sunset-old.jpg

2 duplicate groups, 3 extra copies
```

The summary line computes extra copies as `sum(group.copies - 1)` across all groups — i.e., total duplicated files minus the one "original" per group.

The table strips the `s3://bucket-name/` prefix from paths for readability (the bucket context is already known from the command argument).

Register `dedup` in the command dispatch (the `switch` or `if/else` chain in the main CLI entry point).

### Error handling

- Bucket not found → `cliError("Bucket not found: ${name}")` with exit code 1 (USER)
- API error → `cliError(errorMessage)` with exit code 2 (SERVICE)

---

## File Change Summary

| File | Change Type | What |
|------|-------------|------|
| `web/lib/media/s3.ts` | Modify | `uploadS3Object` returns ETag string |
| `web/app/api/buckets/[id]/upload/route.ts` | Modify | Use ETag as content_hash, pass to watchedKey |
| `supabase/migrations/20260401000000_dedup_rpc.sql` | Create | RPC function `find_duplicate_groups` |
| `web/lib/media/db.ts` | Modify | Add `findDuplicateGroups()`, `DuplicateGroup` interface |
| `web/app/api/dedup/route.ts` | Create | GET endpoint for duplicate groups |
| `web/bin/smgr.ts` | Modify | Add `cmdDedup()` command + table output |

---

## What's NOT Changing

- **Scan path** (`bucket-service.ts`) — already stores `etag:${obj.etag}`, no changes
- **Events schema** — `content_hash` column and index already exist
- **Other CLI commands** — no impact
- **`sha256Bytes` utility** — stays in `utils.ts`, just no longer imported by upload route
