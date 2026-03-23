# Integration Notes — Opus Review Feedback

## Integrating

### 1. Missed Test Assertion Fix (Line 218) — INTEGRATING
The reviewer correctly identified that `by_content_type["image/jpeg"]` on line 218 must change to `by_content_type["photo"]` after fixtures are updated. This is a clear miss in the original plan.

### 2. Test Count Expectations Will Break (Lines 236-238) — INTEGRATING
With `.eq("content_type", "photo")` added to `getEnrichStatus()`, only 2 photo events will be counted (not 3 total). Both photos are enriched, so `pending` = 0, not >=1. The test expectations and comment need updating.

### 3. `pending` Can Go Negative — INTEGRATING
Adding `Math.max(0, ...)` guard to match `getStats()` pattern. Low effort, prevents edge case.

### 4. Missing Test Commands in Section 3 — INTEGRATING
Adding actual vitest command to Section 3.

## Not Integrating

### 5. Enrichments Query Scoped to Photos — NOT INTEGRATING
The enrichments table only has entries for photos in v1. Adding a join to filter by content_type adds query complexity for no current benefit. Will address when video/audio enrichments are added.

### 6. `search_events` Callers Verification — NOT INTEGRATING
Out of scope for this fix. The `search_events` RPC works correctly — it just needs correct caller input. If callers pass wrong values, that's a separate bug. Not blocking this PR.

### 7. Production Data Audit — NOT INTEGRATING
This is a pre-launch system. No production data exists yet. Moot point.

### 8. `getStats()` pending_enrichment Test — NOT INTEGRATING
The existing test on line 218 (`by_content_type`) indirectly validates that stats work. Adding a dedicated `pending_enrichment` assertion is nice-to-have but not required for this bug fix.
