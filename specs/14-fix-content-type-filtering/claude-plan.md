# Implementation Plan — Fix Content Type Filtering

## Background

PR #47 introduced media enrichment features to sitemgr. During code review, two content_type filtering bugs were identified in `web/lib/media/db.ts`. A third function was flagged as potentially wrong but is actually correct.

The root cause of the confusion: PR #47's planning documents called for `.like("content_type", "image/%")` filtering (MIME type patterns), but the production code path (`detectContentType()` → `CONTENT_TYPE_MAP`) stores simple labels (`"photo"`, `"video"`, `"audio"`, `"file"`). The plan was aspirational; the simple label approach is the correct one.

Several integration test fixtures compound the confusion by inserting events with MIME types (`"image/jpeg"`) instead of the simple labels that production code produces.

## Architecture Context

### Content Type Flow (Production)

```
File upload → detectContentType(filename)
            → mime-types lookup → "image/jpeg"
            → CONTENT_TYPE_MAP[major] → "photo"
            → stored in events.content_type column
```

**CONTENT_TYPE_MAP** (in `web/lib/media/constants.ts`):
```typescript
{ image: "photo", video: "video", audio: "audio" }
```

Anything not in the map falls back to `"file"`.

### Affected Functions in `web/lib/media/db.ts`

| Function | Purpose | Current Filter | Status |
|----------|---------|---------------|--------|
| `getEnrichStatus()` | Counts total media + pending enrichments | None (counts everything) | **BUG — needs fix** |
| `getStats()` | Computes `pending_enrichment` stat | `contentTypeCounts["photo"]` | Correct for production data |
| `getPendingEnrichments()` | Returns unenriched photo events | `.eq("content_type", "photo")` | Correct for production data |

### Related RPC Functions

- `stats_by_content_type()` — Groups events by content_type, returns `{content_type, count}` rows. No filtering; returns whatever labels are in the DB.
- `search_events()` — Accepts optional `content_type_filter` for exact string matching.

## Section 1: Fix getEnrichStatus() Missing Filter

### What Changed

`getEnrichStatus()` builds an events query to count total media items and pending enrichments. The PR removed the old `.eq("content_type", "photo")` filter but did not replace it. The query now counts all `type = "create"` events regardless of content type, inflating `total_media` and `pending` counts.

### What to Do

Add an optional `contentType` parameter to `getEnrichStatus()` (default `"photo"`), and apply it as a `.eq("content_type", contentType)` filter on the events query. The current signature is:

```typescript
export async function getEnrichStatus(client: SupabaseClient, userId?: string)
```

Change to:

```typescript
export async function getEnrichStatus(client: SupabaseClient, userId?: string, contentType = "photo")
```

Then add `.eq("content_type", contentType)` to the events query after the `.eq("type", "create")` filter. All existing callers pass no `contentType` and get `"photo"` by default, so this is backwards-compatible. Future callers can pass `"video"` or `"audio"` when enrichment expands.

Additionally, wrap the `pending` calculation with `Math.max(0, ...)` to guard against edge cases where enrichment counts could exceed total (matching the pattern already used in `getStats()` at line 254). Change `pending: total - enriched` to `pending: Math.max(0, total - enriched)`.

### Why Not `.like("content_type", "image/%")`

Production data stores `"photo"`, not `"image/jpeg"`. Using `.like("content_type", "image/%")` would match zero rows in production. The original PR #47 plan docs were wrong about this approach.

## Section 2: Fix Test Fixtures — Content Type Values

### Problem

Several integration test files insert events with MIME types (`"image/jpeg"`, `"video/mp4"`) instead of the simple labels that `detectContentType()` produces. This causes tests to exercise a different data shape than production, masking bugs and creating false failures.

### Files to Fix

**`web/__tests__/integration/setup.ts`** — `seedUserData()` function (~line 176):
- Change `content_type: "image/jpeg"` to `content_type: "photo"`

**`web/__tests__/integration/media-lifecycle.test.ts`**:
- ~Line 124: Change `content_type: "image/jpeg"` to `content_type: "photo"`
- ~Line 176: Change `content_type: "image/jpeg"` to `content_type: "photo"`
- ~Line 189: Change `content_type: "video/mp4"` to `content_type: "video"`
- ~Line 218: Change assertion `by_content_type["image/jpeg"]` to `by_content_type["photo"]` (the stats RPC key changes when fixtures change)

**`web/__tests__/integration/media-lifecycle.test.ts`** — Enrichment count expectations (~lines 236-239):

After Section 1's filter change, `getEnrichStatus()` counts only photo events. The test creates 3 events (2 photos + 1 video), but now only 2 photos count toward `total_media`. Both photos are enriched, so `pending` = 0. Update:
- The comment to reflect "2 photo events, 2 enriched"
- `expect(data!.pending).toBeGreaterThanOrEqual(1)` → `expect(data!.pending).toBe(0)` (or adjust fixture to create an unenriched photo if a non-zero pending is preferred for coverage)
- `expect(data!.enriched).toBeGreaterThanOrEqual(2)` remains valid
- `expect(data!.total_media).toBe(data!.enriched + data!.pending)` remains valid (2 = 2 + 0)

**`web/__tests__/integration/smgr-cli.test.ts`**:
- Lines ~234, ~347: Already use `content_type: "photo"` — verify only, no changes needed.

### Why This Matters

`getStats()` uses `contentTypeCounts["photo"]` to look up photo counts from the `stats_by_content_type()` RPC. If test fixtures store `"image/jpeg"`, the RPC returns `{ content_type: "image/jpeg", count: N }`, and the `"photo"` key lookup returns `undefined` (→ 0). This makes `pending_enrichment` always zero in tests, even though it works correctly in production.

## Section 3: Verification — Run Tests Locally

### What to Verify

After making the changes in Sections 1 and 2:

1. **Integration tests pass locally:**
   - `media-lifecycle.test.ts` — particularly "should show correct pending and enriched counts"
   - `smgr-cli.test.ts` — full test run

2. **No test fixtures use `"image/jpeg"` or `"video/mp4"` as content_type values** — search the `web/__tests__/integration/` directory for these strings to confirm none remain.

3. **Push to branch and monitor CI** as backup verification.

### Test Commands

Run from project root. The test runner is Vitest. Integration tests require local Supabase to be running (`supabase start`).

```bash
# Run specific test file
npx vitest run web/__tests__/integration/media-lifecycle.test.ts

# Run CLI integration tests
npx vitest run web/__tests__/integration/smgr-cli.test.ts

# Verify no MIME-type content_type values remain in test fixtures
grep -rn '"image/jpeg"\|"video/mp4"\|"audio/mpeg"' web/__tests__/integration/ --include='*.ts'
```

## What We Are NOT Changing

- **`getStats()` logic** — `contentTypeCounts["photo"]` is correct for production data. Once test fixtures are fixed, tests will also pass.
- **`getPendingEnrichments()` filter** — `.eq("content_type", "photo")` is already correct.
- **`detectContentType()` or `CONTENT_TYPE_MAP`** — The simple label approach is intentional.
- **Database schema or migrations** — The `content_type` TEXT column stores whatever the application writes; no schema change needed.
- **RPC functions** — `stats_by_content_type()` and `search_events()` work correctly with any string values.

## Risk Assessment

**Risk: Low.** One filter addition to a Supabase query and string value changes in test fixtures. No schema changes, no new dependencies, no behavior changes for non-photo content types.

**Rollback:** Revert the commit. The only production-affecting change is the added `.eq("content_type", "photo")` filter on `getEnrichStatus()`.
