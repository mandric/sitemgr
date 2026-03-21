# Section 06: Media Lifecycle Test Suite

## Overview

Create `web/__tests__/integration/media-lifecycle.test.ts` — merges `media-db.test.ts` and `media-pipeline.test.ts` into a single end-to-end suite organized around the user journey from upload to search.

## Context

The project has a media pipeline: S3 upload → event creation → enrichment (AI description) → full-text search. The existing tests cover these operations across two separate files with different setup patterns. This suite unifies them with BDD naming and shared seed data.

**Current test files being replaced:**
- `web/__tests__/integration/media-db.test.ts` (294 lines) — FTS search, RLS isolation, stats, watched_keys upsert
- `web/__tests__/integration/media-pipeline.test.ts` (156 lines) — E2E pipeline: S3 upload → list → DB event → search

**Key functions used (from `web/lib/media/`):**
- `db.ts`: `insertEvent()`, `insertEnrichment()`, `upsertWatchedKey()`, `queryEvents()`, `getStats()`, `getEnrichStatus()`
- `s3.ts`: `uploadObject()`, `listObjects()`
- These functions use the Supabase client internally

**Prerequisites from earlier sections:**
- Section 02: `globalSetup.ts` validates Supabase connectivity
- Section 03: `seedUserData()`, `createTestUser()`, `cleanupUserData()`, `getAdminClient()`, `getS3Config()`, `TINY_JPEG` from setup.ts

## What to Build

### File: `web/__tests__/integration/media-lifecycle.test.ts`

### Setup

**`beforeAll`:**
1. Create primary test user via `createTestUser()` → `{ userId, client }`
2. Get admin client via `getAdminClient()`
3. Create S3 test bucket with dynamic name: `test-lifecycle-${Date.now()}`
   - Use Supabase Storage admin API: `admin.storage.createBucket(bucketName, { public: false })`
4. Seed bucket config for the user via admin insert into `bucket_configs`
5. Create second user (User B) for isolation test via `createTestUser()` and `seedUserData()`
6. Initialize `uploadedKeys: string[]` array to track S3 objects for cleanup

**`afterAll`:**
1. Remove all tracked S3 objects: `admin.storage.from(bucketName).remove(uploadedKeys)`
2. Delete test bucket: `admin.storage.deleteBucket(bucketName)`
3. Clean up User A's data via admin deletes
4. Clean up User B's data via `cleanupUserData()`
5. Delete both auth users

### Test Group 1: Upload and search

```
describe('when uploading and searching for media', () => {
  it('should find uploaded photo via full-text search matching enrichment description')
    // 1. Upload TINY_JPEG to S3 bucket
    // 2. Insert event record for the upload (type: 'photo', content_type: 'image/jpeg')
    // 3. Insert enrichment with description: "sunset over mountains"
    // 4. Call search_events RPC with query "sunset" → assert result contains the event
    // 5. Track uploaded key for cleanup

  it('should not return results for non-matching search query')
    // Call search_events with query "cat" → assert empty results
    // (using same data seeded in previous test or shared beforeAll)
})
```

### Test Group 2: Filtered search

```
describe('when filtering search results', () => {
  it('should return only matching content type when filtering by content_type')
    // Seed: 2 photo events + 1 video event, all with enrichments
    // Search with content_type filter 'photo' → assert only photos returned

  it('should return only events within date range when filtering by date')
    // Seed: events with different timestamps
    // Search with date range → assert only events within range returned
})
```

### Test Group 3: Stats

```
describe('when requesting statistics', () => {
  it('should return correct counts by content type')
    // Given: 2 photos and 1 video (seeded in this group's beforeAll or shared)
    // Call stats_by_content_type RPC → assert photo=2, video=1

  it('should return correct counts by event type')
    // Call stats_by_event_type RPC → assert counts match seeded data
})
```

### Test Group 4: Enrichment status

```
describe('when checking enrichment progress', () => {
  it('should show correct pending and enriched counts')
    // Seed: 3 events, create enrichment for only 1
    // Query enrich status → assert pending=2, enriched=1
})
```

### Test Group 5: Watched key upsert

```
describe('when re-scanning a watched key', () => {
  it('should update etag on re-scan without creating duplicate')
    // 1. Upsert watched key with s3_key="test/photo.jpg", etag="abc"
    // 2. Upsert same s3_key with etag="def"
    // 3. Query watched_keys for that s3_key
    // 4. Assert: exactly 1 row, etag === "def"
})
```

### Test Group 6: Cross-user isolation

```
describe('when another user has media', () => {
  it('should not include other user\'s events in query results')
    // User A queries events → User B's events not present
    // Assert: all returned events have user_id === userAId
})
```

### Timeout

This suite needs 60s timeout due to S3 upload/list operations and multiple DB round-trips.

### Data Strategy

Some test groups can share seed data (Group 1 seeds data that Group 2 and 3 also query). Consider using a shared `beforeAll` at the top describe level that seeds a comprehensive dataset, then individual groups assert against different aspects of it. This reduces S3 operations and speeds up the suite.

Alternatively, each group can have its own `beforeAll`/`afterAll` for isolation. The trade-off is speed vs. test independence.

## Files to Create/Modify

| File | Action |
|------|--------|
| `web/__tests__/integration/media-lifecycle.test.ts` | CREATE |

## Acceptance Criteria

1. All 6 test groups pass against a fresh `supabase start`
2. FTS search correctly finds events by enrichment description
3. Stats and enrichment status reflect actual seeded data
4. Watched key upsert updates (not duplicates) on re-scan
5. Cross-user isolation prevents User A from seeing User B's media
6. S3 objects and test data cleaned up in afterAll
7. No `describe.skipIf` — relies on globalSetup
8. BDD naming throughout
9. Suite completes within 60s timeout
