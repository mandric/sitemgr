# TDD Plan: Duplicate Detection & Hash Normalization

Companion to `claude-plan.md`. Defines what tests to write before implementing each section.

**Testing conventions** (from CLAUDE.md and codebase research):
- **Unit tests**: Vitest, for pure logic (no I/O). File pattern: `web/__tests__/unit/*.test.ts`
- **Integration tests**: Vitest, against real Supabase/S3. File pattern: `web/__tests__/integration/*.test.ts`
- **CLI E2E tests**: Vitest, runs `smgr` as subprocess. File pattern: `web/__tests__/integration/smgr-*.test.ts`
- **No mock-heavy unit tests** — if it touches Supabase or S3, write an integration test

---

## Section 1: Hash Normalization — S3 Upload Returns ETag

### Unit Tests

```
# Test: uploadS3Object returns a string (the ETag)
# Test: uploadS3Object strips surrounding quotes from ETag (S3 returns "abc" → abc)
```

Note: `uploadS3Object` talks to S3, so this is really an integration test against the local S3 (Supabase Storage). Per CLAUDE.md test philosophy, don't mock S3 — test against real local S3.

### Integration Tests

```
# Test: upload a file via POST /api/buckets/[id]/upload, verify the event's content_hash starts with "etag:" (not "sha256:")
# Test: upload a file, then scan the same bucket — the uploaded file's event and scan event have matching content_hash values
# Test: upload a file, verify the watched_key row has a non-empty etag
```

The upload-then-scan matching test is the key validation — it proves the hash normalization works end-to-end.

---

## Section 2: Duplicate Detection RPC

### Integration Tests (against real Supabase)

```
# Test: insert 3 events with the same content_hash, call find_duplicate_groups — returns 1 group with copies=3
# Test: insert events with unique content_hashes — find_duplicate_groups returns empty array
# Test: insert events across two users with same hash — each user only sees their own duplicates (tenant isolation)
# Test: insert events across two buckets, call with bucket_config_id filter — only returns duplicates from that bucket
# Test: events with NULL content_hash are excluded from results
# Test: events with type != 'create' are excluded from results
```

### db.ts Function Tests

```
# Test: findDuplicateGroups returns { data, error } shape
# Test: findDuplicateGroups with no duplicates returns empty array (not null)
# Test: findDuplicateGroups with bucket filter narrows results correctly
```

---

## Section 3: Dedup API Route

### Integration Tests (against running Next.js dev server)

```
# Test: GET /api/dedup?bucket_config_id=X with valid auth returns { data: { groups, total_duplicate_groups } }
# Test: GET /api/dedup without bucket_config_id returns 400
# Test: GET /api/dedup without auth returns 401
# Test: GET /api/dedup with bucket_config_id belonging to different user returns empty results (not an error — RLS handles isolation)
```

---

## Section 4: CLI Dedup Command

### CLI E2E Tests (subprocess)

```
# Test: `smgr dedup <bucket>` with no duplicates prints "No duplicates found." and exits 0
# Test: `smgr dedup <bucket>` with duplicates prints table with hash, copies, paths columns
# Test: `smgr dedup <nonexistent>` prints bucket not found error and exits 1
# Test: `smgr dedup` with no arguments prints usage help
```
