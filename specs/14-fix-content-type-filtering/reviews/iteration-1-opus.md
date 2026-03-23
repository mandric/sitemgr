# Opus Review

**Model:** claude-opus-4
**Generated:** 2026-03-23T00:00:00Z

---

## Plan Review: Fix Content Type Filtering

### Overall Assessment

The plan is well-scoped, correctly diagnosed, and low-risk. The two changes (add the missing filter, fix test fixtures) are both clearly needed. That said, there are a few gaps and one missed test assertion fix.

### 1. Missed Test Assertion Fix (Line 218 of media-lifecycle.test.ts)

The plan lists three fixture value changes in `media-lifecycle.test.ts` (lines 124, 175, 189) but does not mention the assertion on **line 218**:

```typescript
expect(Number(data!.by_content_type["image/jpeg"])).toBeGreaterThanOrEqual(2);
```

Once fixtures change from `"image/jpeg"` to `"photo"`, this assertion will fail because the key in `by_content_type` will now be `"photo"`, not `"image/jpeg"`. The plan must include changing this assertion to:

```typescript
expect(Number(data!.by_content_type["photo"])).toBeGreaterThanOrEqual(2);
```

This is a concrete bug in the plan -- the test will break after the fixture changes if this line is not updated.

### 2. The `pending` Calculation Can Go Negative

In `getEnrichStatus()` at line 294 of `web/lib/media/db.ts`:

```typescript
pending: total - enriched,
```

After adding the `.eq("content_type", "photo")` filter to the events query, `total` will count only photos. But the `enrichmentsQuery` still counts **all** enrichments (no content_type filter on the enrichments table). If enrichments exist for non-photo events, `enriched` could exceed `total`, producing a negative `pending` value.

The `getStats()` function handles this with `Math.max(0, ...)` at line 254. Consider applying the same guard here.

### 3. Enrichments Query Should Also Be Scoped to Photos

`getEnrichStatus()` counts enrichments with no content_type constraint. If the system later adds video enrichments, this function will silently count them too. The plan should explicitly state whether the enrichments query should also be filtered, or why it is safe to leave unfiltered.

### 4. No Mention of the `search_events` RPC `content_type_filter` Parameter

The `search_events()` SQL function uses exact string matching on `content_type`. If any caller passes `"image/jpeg"` as a filter value, it will match zero rows. The plan should verify that no callers pass MIME-type strings.

### 5. Existing Production Data Not Addressed

The plan does not address whether any production data might already contain MIME-type strings. Confirm no production data exists yet, or include a data audit step.

### 6. Test Count Expectations May Be Fragile

After the fix, `getEnrichStatus` will only count photo events. The comment says "3 create events" but one is a video. So `total_media` will be 2, not 3. With 2 photos and 2 enrichments, `pending` will be 0, and `expect(data!.pending).toBeGreaterThanOrEqual(1)` will **fail**. The plan must address this.

### 7. Missing Verification: `getStats()` `pending_enrichment` Test

The plan claims `getStats()` will work correctly once fixtures are fixed, but does not point to a specific test assertion that validates `pending_enrichment`.

### 8. Minor: Section 3 Has No Actual Test Commands

Section 3 says "Test Commands" but has no commands listed. Include the actual vitest invocations.

### Summary of Required Plan Amendments

| Priority | Issue | Action |
|----------|-------|--------|
| **Must fix** | Line 218 assertion uses `"image/jpeg"` key | Add to Section 2: change to `"photo"` |
| **Must fix** | Test expectations for enrichment counts will break | Update expected values in test after filter scopes to photos only |
| **Should fix** | `pending` can go negative in `getEnrichStatus` | Add `Math.max(0, ...)` or document why not needed |
| **Should fix** | No verification that `search_events` callers use correct labels | Add a grep-and-verify step |
| **Nice to have** | Production data audit | Confirm no MIME-type strings exist in production |
| **Nice to have** | Enrichments query unscoped | Document as acceptable for v1, flag for future |
| **Nice to have** | Missing test commands in Section 3 | Fill in the actual vitest invocations |
