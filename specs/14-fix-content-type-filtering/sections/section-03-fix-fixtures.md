Now I have all the context needed.

# Section 3: Fix Test Fixtures -- Content Type Values

## Background

Integration test fixtures currently insert events with MIME type strings (`"image/jpeg"`, `"video/mp4"`) in the `content_type` column. In production, the `detectContentType()` function maps MIME types to simple labels via `CONTENT_TYPE_MAP`, so the database always contains `"photo"`, `"video"`, `"audio"`, or `"file"`. This mismatch means tests exercise a different data shape than production, masking filtering bugs and causing false results in stats lookups (e.g., `contentTypeCounts["photo"]` returns `undefined` when the DB contains `"image/jpeg"`).

This section updates all fixture `content_type` values to use the named constants introduced in Section 1, and adjusts test assertions to match the new (correct) counts.

## Dependencies

- **Section 1 (constants)** must be completed first -- this section imports `CONTENT_TYPE_PHOTO` and `CONTENT_TYPE_VIDEO` from `web/lib/media/constants.ts`.
- **Section 2 (fix filter)** must be completed first -- the enrichment count expectations below assume `getEnrichStatus()` now filters to photo-only events.

## Files to Modify

1. `/home/user/sitemgr/web/__tests__/integration/setup.ts`
2. `/home/user/sitemgr/web/__tests__/integration/media-lifecycle.test.ts`
3. `/home/user/sitemgr/web/__tests__/integration/smgr-cli.test.ts` (verify only -- already uses `"photo"`)

## Tests (Updated Existing Tests)

No new test files are created. The existing tests in `media-lifecycle.test.ts` serve as the validation. The changes below describe what the updated assertions should look like after fixtures are fixed.

### Test: "should return correct counts by content type"

Currently at ~line 218 in `media-lifecycle.test.ts`, the assertion reads:

```typescript
expect(Number(data!.by_content_type["image/jpeg"])).toBeGreaterThanOrEqual(2);
```

After fixing fixtures, the stats RPC will return keys matching the simple labels. Update the assertion key to use the constant:

```typescript
expect(Number(data!.by_content_type[CONTENT_TYPE_PHOTO])).toBeGreaterThanOrEqual(2);
```

### Test: "should show correct pending and enriched counts"

Currently at ~lines 236-239. After Section 2's filter fix, `getEnrichStatus()` counts only photo events. The test creates 3 total events (2 photos from the search test + stats `evtPhoto2`, plus 1 video `evtVideo`). With photo-only filtering, `total_media` = 2, both are enriched, so `pending` = 0. Update:

```typescript
// We have 2 photo "create" events, both enriched
expect(data!.enriched).toBeGreaterThanOrEqual(2);
expect(data!.pending).toBe(0);
expect(data!.total_media).toBe(data!.enriched + data!.pending);
```

## Implementation Details

### 1. Add import to `setup.ts`

At the top of `/home/user/sitemgr/web/__tests__/integration/setup.ts`, add the import:

```typescript
import { CONTENT_TYPE_PHOTO } from "../../lib/media/constants";
```

### 2. Fix `seedUserData()` in `setup.ts`

In the `seedUserData()` function (~line 176), change the event insertion from:

```typescript
content_type: "image/jpeg",
```

to:

```typescript
content_type: CONTENT_TYPE_PHOTO,
```

This is the only fixture value in `setup.ts` that needs changing. The function creates `eventCount` events, all as photos. The enrichments created for those events do not have a `content_type` field, so they need no change.

### 3. Add import to `media-lifecycle.test.ts`

At the top of `/home/user/sitemgr/web/__tests__/integration/media-lifecycle.test.ts`, add the constants import:

```typescript
import { CONTENT_TYPE_PHOTO, CONTENT_TYPE_VIDEO } from "../../lib/media/constants";
```

### 4. Fix event insertions in `media-lifecycle.test.ts`

Three `insertEvent()` calls need updating:

**~Line 124** (search test event): Change `content_type: "image/jpeg"` to `content_type: CONTENT_TYPE_PHOTO`

**~Line 176** (stats photo2 event): Change `content_type: "image/jpeg"` to `content_type: CONTENT_TYPE_PHOTO`

**~Line 189** (stats video event): Change `content_type: "video/mp4"` to `content_type: CONTENT_TYPE_VIDEO`

### 5. Fix stats assertion in `media-lifecycle.test.ts`

**~Line 218**: Change `data!.by_content_type["image/jpeg"]` to `data!.by_content_type[CONTENT_TYPE_PHOTO]`

### 6. Fix enrichment count expectations in `media-lifecycle.test.ts`

**~Lines 236-239**: Update the comment and `pending` assertion as described in the Tests section above. The key change is `pending` goes from `toBeGreaterThanOrEqual(1)` to `toBe(0)` because after Section 2's filter fix, only 2 photo events are counted and both have enrichments.

### 7. Verify `smgr-cli.test.ts` (no changes expected)

Check `/home/user/sitemgr/web/__tests__/integration/smgr-cli.test.ts` at ~lines 234 and 347. These should already use `content_type: "photo"`. If they do, no changes are needed. If they use MIME type strings, apply the same constant replacement.

## Why This Matters

The `getStats()` function computes `pending_enrichment` by looking up `contentTypeCounts["photo"]` from the `stats_by_content_type()` RPC result. When test fixtures store `"image/jpeg"`, the RPC returns `{ content_type: "image/jpeg", count: N }`, and the `"photo"` key lookup returns `undefined` (coerced to 0). This makes `pending_enrichment` always zero in tests regardless of actual enrichment state, hiding real bugs. Fixing fixtures to use production-matching labels ensures tests catch the same issues that would occur in production.