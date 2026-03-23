# TDD Plan — Fix Content Type Filtering

Testing framework: **Vitest** with integration tests against local Supabase.
Test location: `web/__tests__/integration/`
Existing test files: `media-lifecycle.test.ts`, `smgr-cli.test.ts`

---

## Section 1: Export Content Type Label Constants

No tests needed for this section — it's pure constant definitions. The constants are validated indirectly by all tests in Sections 2-4 that use them.

---

## Section 2: Fix getEnrichStatus() Missing Filter

### Existing Tests to Update

The test in `media-lifecycle.test.ts` → `"should show correct pending and enriched counts"` already exercises `getEnrichStatus()`. After the fix:

- Test: `getEnrichStatus()` returns only photo events in `total_media` (video events excluded)
- Test: `pending` is correctly computed as `Math.max(0, total - enriched)` — never negative
- Test: `total_media === enriched + pending` identity holds

### New Test Stubs

- Test: `getEnrichStatus()` with explicit `contentType` param filters to that type only
- Test: `getEnrichStatus()` with default param (no `contentType` arg) filters to photos

These can be added as new `it()` blocks in the existing `"when checking enrichment progress"` describe block, or verified by the updated existing test.

---

## Section 3: Fix Test Fixtures — Content Type Values

### Existing Tests to Update

- Test: `"should return correct counts by content type"` — assertion key changes from `"image/jpeg"` to `CONTENT_TYPE_PHOTO`
- Test: `"should show correct pending and enriched counts"` — expected counts change (2 photos total, 2 enriched, 0 pending)

### Verification Stubs

- Test: `seedUserData()` creates events with `content_type` matching production labels (not MIME types)
- Test: `by_content_type` stats keys match the constants from `constants.ts`

These are covered by the updated existing tests — no new test files needed.

---

## Section 4: Verification — Run Tests Locally

This section IS the test execution step. No test stubs — just run:

```bash
npx vitest run web/__tests__/integration/media-lifecycle.test.ts
npx vitest run web/__tests__/integration/smgr-cli.test.ts
```

And verify no MIME-type strings remain in fixtures:
```bash
grep -rn '"image/jpeg"\|"video/mp4"\|"audio/mpeg"' web/__tests__/integration/ --include='*.ts'
```
