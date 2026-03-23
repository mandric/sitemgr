# 14-fix-content-type-filtering — Spec

## Overview

Fix two content_type filtering bugs in `web/lib/media/db.ts` that were identified during code review of PR #47. Both bugs stem from inconsistent handling of content types — some functions filter on MIME types (`image/jpeg`), while others use the legacy semantic type (`"photo"`) or no filter at all. The result is inflated counts and permanently-zero `pending_enrichment`.

PR #47's planning docs (`claude-plan.md` Section 4) called for `.like("content_type", "image/%")` across all three media-counting functions, but two of the three were not correctly updated.

**Origin:** [PR #47 code review comment](https://github.com/mandric/sitemgr/pull/47#issuecomment-4107208895)

---

## Bug 1 — `getEnrichStatus()` missing content_type filter

**Affected function:** `getEnrichStatus()` at `web/lib/media/db.ts:263-267`

### Problem

The PR removed the `.eq("content_type", "photo")` filter but did not replace it with `.like("content_type", "image/%")`. The events query now counts **all** `type = "create"` events (video, audio, documents), inflating both `total_media` and `pending` counts.

This is inconsistent with:
- `getPendingEnrichments()` (line 405) — filters `.eq("content_type", "photo")` (also wrong, but at least filters)
- `getStats()` (line 245) — uses `contentTypeCounts["photo"]` (also wrong, see Bug 2)

### Current Code

```typescript
let eventsQuery = client
  .from("events")
  .select("*", { count: "exact", head: true })
  .eq("type", "create");
  // ← no content_type filter — counts all media types
```

### Fix

Add `.like("content_type", "image/%")` to the events query:

```typescript
let eventsQuery = client
  .from("events")
  .select("*", { count: "exact", head: true })
  .eq("type", "create")
  .like("content_type", "image/%");
```

### Key Files
- `web/lib/media/db.ts` (lines 263-267, `getEnrichStatus()`)

---

## Bug 2 — `getStats()` looks up `"photo"` key instead of summing `image/*` entries

**Affected function:** `getStats()` at `web/lib/media/db.ts:244-254`

### Problem

`getStats()` computes `pending_enrichment` using `contentTypeCounts["photo"]`, but real data and test fixtures store events with MIME types (`"image/jpeg"`, `"image/png"`), not `"photo"`. The `contentTypeCounts` map is keyed by actual `content_type` values from the database, so `contentTypeCounts["photo"]` always returns `undefined` (falling back to `0`), making `pending_enrichment` permanently zero.

### Current Code

```typescript
const photoCount = contentTypeCounts["photo"] ?? 0;

return {
  data: {
    // ...
    pending_enrichment: Math.max(0, photoCount - enriched),
  },
  error: null,
};
```

### Fix

Sum all `image/*` entries from the content type counts:

```typescript
const imageCount = Object.entries(contentTypeCounts)
  .filter(([key]) => key.startsWith("image/"))
  .reduce((sum, [, count]) => sum + count, 0);

return {
  data: {
    // ...
    pending_enrichment: Math.max(0, imageCount - enriched),
  },
  error: null,
};
```

### Key Files
- `web/lib/media/db.ts` (lines 244-254, `getStats()`)

---

## Additional Consistency Fix — `getPendingEnrichments()` still uses `"photo"`

**Affected function:** `getPendingEnrichments()` at `web/lib/media/db.ts:405`

### Problem

While not explicitly called out in the PR review, `getPendingEnrichments()` still filters with `.eq("content_type", "photo")`, which suffers from the same MIME-type mismatch. Since real events use `"image/jpeg"` etc., this function returns zero pending enrichments.

### Current Code

```typescript
.eq("content_type", "photo")
```

### Fix

```typescript
.like("content_type", "image/%")
```

### Key Files
- `web/lib/media/db.ts` (line 405, `getPendingEnrichments()`)

---

## Test Data Alignment

**Files:** `web/__tests__/integration/smgr-cli.test.ts`

Any test fixtures that insert events with `content_type: "photo"` should be updated to use MIME types (`"image/jpeg"`) to match the production watch command and `seedUserData()` helper.

Verify these locations:
- FTS test `beforeAll` insert
- Dry-run test `beforeAll` insert

---

## Verification

After applying all fixes:

1. `getEnrichStatus()`, `getStats()`, and `getPendingEnrichments()` all consistently filter on `image/%` MIME types
2. Integration test `media-lifecycle.test.ts` — "should show correct pending and enriched counts" passes
3. `smgr-e2e.test.ts` — "final stats show all enriched" returns correct counts
4. No test fixtures use the legacy `"photo"` content type value

## Risk

Low. These are query filter corrections — no schema changes, no migrations, no new dependencies. The fixes align the code with its own planning docs and with the data format used by the production watch command.
