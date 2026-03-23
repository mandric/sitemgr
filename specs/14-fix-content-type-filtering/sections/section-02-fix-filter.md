I have all the context I need. Here is the section content:

# Section 2: Fix getEnrichStatus() Missing Filter

## Overview

`getEnrichStatus()` in `web/lib/media/db.ts` (line 263) counts total media items and pending enrichments. The function currently queries all `type = "create"` events regardless of content type, which inflates `total_media` and `pending` counts by including video, audio, and file events that enrichment does not process.

This section adds a content type filter to the query so only relevant events are counted. It also adds a `Math.max(0, ...)` guard on the `pending` calculation.

**Depends on:** Section 1 (constants must be exported from `web/lib/media/constants.ts` first).

## File to Modify

`/home/user/sitemgr/web/lib/media/db.ts`

## Tests First

Tests live in two files. The unit tests in `web/__tests__/db-operations.test.ts` mock Supabase and verify the function's logic. The integration tests in `web/__tests__/integration/media-lifecycle.test.ts` run against local Supabase (covered in Section 3).

### Unit Tests to Update: `web/__tests__/db-operations.test.ts`

The existing `getEnrichStatus` describe block (line 476) has three tests that use a mock chain. After the fix, the events query chain will include an additional `.eq("content_type", "photo")` call. The mock chain already uses `headChain.eq = vi.fn().mockReturnValue(headChain)` which handles any number of `.eq()` calls, so these tests should continue to pass without mock changes.

However, the tests should be updated to verify the new behavior:

1. **Verify the content type filter is applied** -- After calling `getEnrichStatus(client)`, assert that `headChain.eq` was called with `"content_type"` and `CONTENT_TYPE_PHOTO` (the default). Import `CONTENT_TYPE_PHOTO` from `@/lib/media/constants`.

2. **Verify explicit contentType parameter** -- Add a test that calls `getEnrichStatus(client, undefined, CONTENT_TYPE_VIDEO)` and asserts that `.eq` was called with `"content_type"` and `CONTENT_TYPE_VIDEO`.

3. **Verify Math.max(0, ...) guard on pending** -- Add a test where `enriched > total` (e.g., total=3, enriched=5) and assert that `pending` is `0`, not `-2`. This covers the edge case where enrichment records exist for events that have since been deleted or filtered out.

### New Test Stub

Add to the existing `getEnrichStatus` describe block in `web/__tests__/db-operations.test.ts`:

```typescript
it("applies content_type filter with default CONTENT_TYPE_PHOTO", async () => {
  // Setup mock chain as in existing tests
  // Call getEnrichStatus(mockSupabaseClient as never) with no contentType arg
  // Assert headChain.eq was called with ("content_type", CONTENT_TYPE_PHOTO)
});

it("applies explicit contentType parameter", async () => {
  // Setup mock chain
  // Call getEnrichStatus(mockSupabaseClient as never, undefined, CONTENT_TYPE_VIDEO)
  // Assert headChain.eq was called with ("content_type", CONTENT_TYPE_VIDEO)
});

it("pending never goes negative (Math.max guard)", async () => {
  // Setup mock chain where events count=3, enrichments count=5
  // Call getEnrichStatus(mockSupabaseClient as never)
  // Assert result.data!.pending === 0 (not -2)
});
```

## Implementation Details

### Current Signature (line 263)

```typescript
export async function getEnrichStatus(client: SupabaseClient, userId?: string)
```

### New Signature

```typescript
export async function getEnrichStatus(client: SupabaseClient, userId?: string, contentType = CONTENT_TYPE_PHOTO)
```

Import `CONTENT_TYPE_PHOTO` from `@/lib/media/constants` at the top of `db.ts` (it may already be imported after Section 1 updates `CONTENT_TYPE_MAP` references -- just ensure it is in the import list).

### Query Change

Add `.eq("content_type", contentType)` to the events query. The current query (lines 264-267):

```typescript
let eventsQuery = client
  .from("events")
  .select("*", { count: "exact", head: true })
  .eq("type", "create");
```

Becomes:

```typescript
let eventsQuery = client
  .from("events")
  .select("*", { count: "exact", head: true })
  .eq("type", "create")
  .eq("content_type", contentType);
```

The enrichments query (lines 268-270) remains unchanged -- it counts all enrichments for the user, which is correct since enrichments only exist for enrichable content types.

### Pending Calculation Change

The current calculation (line 294):

```typescript
pending: total - enriched,
```

Becomes:

```typescript
pending: Math.max(0, total - enriched),
```

This guards against edge cases where `enriched > total` (e.g., if events were deleted but enrichments remain, or if a future content type filter excludes some events that have enrichments).

### Backwards Compatibility

All existing callers pass no `contentType` argument:
- `web/bin/smgr.ts` line 251: `getEnrichStatus(client, userId)`
- `web/lib/agent/core.ts` line 249: `getEnrichStatus(client, userId ?? undefined)`
- `web/__tests__/integration/media-lifecycle.test.ts` line 232: `getEnrichStatus(admin, userId)`

They all get the default `CONTENT_TYPE_PHOTO`, which matches the current intended behavior. No caller changes are needed.

### Mock in agent-core tests

The mock in `web/__tests__/agent-core.test.ts` (line 19) mocks the entire `getEnrichStatus` function and does not call the real implementation, so it is unaffected by this change:

```typescript
getEnrichStatus: vi.fn().mockResolvedValue({ data: { total_media: 0, enriched: 0, pending: 0 }, error: null }),
```

### Phone migration test

The test in `web/__tests__/phone-migration-app.test.ts` (line 170) tests that `userId` is passed through. After this change, it should also verify that `.eq` is called with `"content_type"` and the default value. The existing mock chain pattern (`eq: vi.fn().mockReturnThis()`) handles the additional `.eq()` call without breaking.

## Summary of Changes

| File | Change |
|------|--------|
| `web/lib/media/db.ts` | Add `contentType` param with default, add `.eq("content_type", contentType)` filter, add `Math.max(0, ...)` guard |
| `web/__tests__/db-operations.test.ts` | Add tests for content type filter and Math.max guard |