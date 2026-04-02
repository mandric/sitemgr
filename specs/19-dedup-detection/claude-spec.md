# Spec 19: Duplicate Detection — Complete Specification

## Problem

Users accumulate duplicate files across devices, folders, and imports. The same photo might exist at `vacation/beach.jpg`, `exports/IMG_2023.jpg`, and `backup/beach-copy.jpg`. The system already captures content hashes on every event but doesn't expose duplicate detection.

Additionally, uploads and scans use different hash algorithms (`sha256:...` vs `etag:...`), making cross-source dedup impossible.

## Goal

1. **Normalize content hashes** — uploads store `etag:${s3Etag}` (matching scans) instead of `sha256:${hex}`
2. **Detect duplicates** — query for events sharing the same content hash within a bucket
3. **Report** — CLI command showing duplicate groups with paths and copy counts

Report-only for v1. No cleanup, no cross-bucket dedup, no fuzzy matching.

## Design Principle

**Mirror first, dedup later.** Upload and scan faithfully mirror the source filesystem. Every file gets its own event and S3 object. Dedup is an explicit user action after the fact — never implicit.

## Changes Required

### 1. Hash Normalization — Upload Path

**Current state:** `uploadS3Object()` returns `void`, discarding the S3 PutObject response. The upload route computes `sha256Bytes(fileBuffer)` and stores `sha256:${hex}` as `content_hash`.

**Change:**
- `uploadS3Object()` returns the ETag from the PutObject response (S3 always returns it)
- Upload route stores `etag:${s3Etag}` as `content_hash` instead of `sha256:${hex}`
- Remove `sha256Bytes` import from the upload route (function stays in utils.ts — may be used elsewhere)
- Update `upsertWatchedKey` call to pass the actual etag (currently passes `""`)

**No backwards compatibility concern** — pre-1.0 decision. Old `sha256:` hashes won't participate in dedup; that's acceptable.

### 2. Duplicate Detection RPC

**New Supabase migration** with an RPC function:

```sql
CREATE FUNCTION find_duplicate_groups(
  p_user_id UUID,
  p_bucket_config_id UUID DEFAULT NULL
) RETURNS TABLE (
  content_hash TEXT,
  copies BIGINT,
  event_ids TEXT[],
  paths TEXT[]
)
```

Groups events by `content_hash` where `type = 'create'` and `content_hash IS NOT NULL`, filtered by user_id and optionally bucket_config_id. Returns groups with count > 1, ordered by count DESC.

**Existing index:** `idx_events_content_hash` on `events(content_hash)` — already covers this query.

### 3. Database Layer

**New function in `db.ts`:**

```typescript
findDuplicateGroups(client, userId, bucketConfigId?)
  → { data, error }
```

Calls the RPC function. Returns `{ data, error }` (Supabase shape, passed through per CLAUDE.md coding principles).

### 4. API Route

**`GET /api/dedup?bucket_config_id=X`**

- Authenticated via `authenticateRequest()` (Bearer token)
- `bucket_config_id` is required (dedup is per-bucket)
- Returns `{ data: { groups: [...], total_duplicate_groups: N } }`
- Each group: `{ content_hash, copies, event_ids, paths }`
- No pagination (expected < 100 groups)

### 5. CLI Command

**`smgr dedup <bucket>`**

- Resolves bucket name → bucket_config_id via `resolveBucketId()`
- Calls `GET /api/dedup?bucket_config_id=X`
- Displays table output:
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
- No `--json` flag for MVP
- No `--cleanup` for MVP

## Out of Scope

- Automatic dedup on upload (by design — mirror first)
- Fuzzy/perceptual dedup (similar but not identical images)
- Cross-bucket dedup
- Dedup cleanup (deleting S3 objects + events) — report-only in v1
- File sizes / wasted bytes in report — skip for MVP
- Pagination — not needed at expected scale
- Web UI — future

## Dependencies

- `events.content_hash` column — exists with index
- S3 PutObject returns ETag — available from AWS SDK
- Existing API auth pattern — `authenticateRequest()`
- Existing CLI helpers — `apiGet()`, `resolveBucketId()`
