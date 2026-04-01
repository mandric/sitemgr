# 19: Duplicate Detection & Cleanup

## Problem

Users accumulate duplicate files across devices, folders, and imports. The same photo might exist at `vacation/beach.jpg`, `exports/IMG_2023.jpg`, and `backup/beach-copy.jpg`. Today there's no way to find or manage these duplicates.

The system already captures content hashes on every event — `sha256:...` for uploads, `etag:...` for scans — but doesn't expose duplicate detection to users.

## Design Principle: Mirror First, Dedup Later

Upload and scan are **faithful mirrors** of the source filesystem. Every file gets its own event and S3 object, preserving the original path structure. Dedup is never implicit — it's an explicit user action after the fact.

This means:
- Uploading the same content from two paths creates two events and two S3 objects
- The S3 bucket mirrors the device filesystem (user-friendly, predictable)
- Users run dedup when they want to, on their terms

## Current State

- `events.content_hash` stores `sha256:...` (upload) or `etag:...` (scan) per event
- `watched_keys.etag` stores S3 etag per key
- `findEventByHash` in `db.ts` finds one event by hash (used for by-hash API lookup)
- No duplicate detection, reporting, or cleanup exists

## Goal

Add a dedup detection and cleanup flow:

1. **Detect** — query for events sharing the same content hash
2. **Report** — show duplicate groups with paths, sizes, dates
3. **Clean up** — user picks which to keep; others are soft-deleted or removed

## Key Changes

### 1. Normalize content hashes

Scan events use `etag:${md5}`, upload events use `sha256:${hex}`. These are different hash algorithms for the same content, so they won't match across scan vs upload.

Options (pick one):
- **a)** On upload, also store the etag from S3 PutObject response (S3 returns it). Use etag as the canonical dedup hash since scan already has it.
- **b)** On scan, also compute sha256 by downloading the object. Expensive — defeats the purpose of lightweight scanning.
- **c)** Accept that scan-vs-upload dedup won't work. Dedup only within scan results (etag) or within upload results (sha256) separately.

Recommendation: **(a)** — store etag from S3 PutObject response as a second field or as the canonical `content_hash`. Cheap, and unifies the hash space.

### 2. Duplicate detection query

New DB function or RPC:

```sql
SELECT content_hash, count(*) as copies, 
       array_agg(id) as event_ids,
       array_agg(remote_path) as paths
FROM events
WHERE user_id = $1 AND type = 'create' AND content_hash IS NOT NULL
GROUP BY content_hash
HAVING count(*) > 1
ORDER BY count(*) DESC
```

Optionally filter by `bucket_config_id`.

### 3. API route

`GET /api/dedup?bucket_config_id=X` — returns duplicate groups:
```json
{
  "data": {
    "groups": [
      {
        "content_hash": "etag:abc123",
        "copies": 3,
        "events": [
          { "id": "...", "remote_path": "s3://bucket/vacation/beach.jpg", "timestamp": "..." },
          { "id": "...", "remote_path": "s3://bucket/exports/IMG_2023.jpg", "timestamp": "..." },
          { "id": "...", "remote_path": "s3://bucket/backup/beach-copy.jpg", "timestamp": "..." }
        ],
        "total_size_bytes": 15360
      }
    ],
    "total_duplicate_groups": 42,
    "total_wasted_bytes": 1048576
  }
}
```

### 4. CLI command

`smgr dedup <bucket>` — report duplicate groups
`smgr dedup <bucket> --cleanup` — interactive: for each group, pick which to keep (future, may need TUI)

MVP is report-only. Cleanup can be a follow-up.

### 5. Web UI (optional, future)

Buckets page shows a "N duplicates found" badge. Click through to see groups with thumbnails. Select which to keep.

## Out of Scope

- Automatic dedup on upload (by design — mirror first)
- Fuzzy/perceptual dedup (similar but not identical images)
- Cross-bucket dedup
- Dedup cleanup (deleting S3 objects + events) — report-only in v1

## Dependencies

- Spec 15 (server-side S3 ops) — bucket API routes exist
- `events.content_hash` column — exists
- S3 PutObject etag response — available from AWS SDK
