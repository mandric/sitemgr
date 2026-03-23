# Interview Transcript — Fix Content Type Filtering

## Q1: Direction for the fix — "photo" labels vs MIME types?

**Context:** Codebase research found that production code (`detectContentType` in `utils.ts`) maps MIME types to simple labels via `CONTENT_TYPE_MAP`: image→"photo", video→"video", audio→"audio". The spec proposes `.like("content_type", "image/%")` which wouldn't match "photo".

**Answer:** Keep "photo" labels, fix consistently. Add `.eq("content_type", "photo")` to `getEnrichStatus()`, keep existing filters in other functions, fix test fixtures that incorrectly use MIME types.

## Q2: Was PR #47's intent to store MIME types?

**Context:** The spec mentions PR #47's planning docs called for `.like("content_type", "image/%")`. Was `detectContentType()` supposed to be updated too?

**Answer:** Plan docs had the wrong approach. The code correctly stores "photo" — the plan was aspirational but the simple label approach is correct.

## Q3: Enrichment scope — photos only or all media?

**Context:** For `getEnrichStatus()`, should we filter to photos only or include video/audio?

**Answer:** Photos only. Use `.eq("content_type", "photo")`. Enrichment is only for images right now.

## Q4: Test fixture scope

**Context:** `seedUserData()` and `media-lifecycle.test.ts` use MIME types ("image/jpeg", "video/mp4") instead of simple labels.

**Answer:** Just fix tests in `web/__tests__/integration/`. That's where all relevant tests live.

## Q5: Test verification approach

**Context:** Should we run tests locally or leave to CI?

**Answer:** Try to run tests locally, and as backup monitor CI after push to branch.

## Summary of Decisions

1. **Direction:** Keep simple labels ("photo", "video", "audio", "file"), do NOT migrate to MIME types
2. **getEnrichStatus():** Add `.eq("content_type", "photo")` filter
3. **getStats():** Keep `contentTypeCounts["photo"]` — it's correct for production data
4. **getPendingEnrichments():** Keep `.eq("content_type", "photo")` — it's already correct
5. **Test fixtures:** Change "image/jpeg" → "photo", "video/mp4" → "video" in integration tests
6. **Verification:** Run tests locally, monitor CI as backup
