# Section 03: Stats RPC Guard Hardening

## Overview

Remove `if (data && data.length > 0)` silent-pass guards from `stats_by_content_type` and `stats_by_event_type` tests in `web/__tests__/integration/tenant-isolation.test.ts`. Add explicit non-empty assertions to match the pattern already applied to `search_events`.

## File to Modify

**`web/__tests__/integration/tenant-isolation.test.ts`**

## Current Code

### stats_by_content_type (lines 215-227)

```typescript
it("should return only Alice's stats when Alice calls stats_by_content_type", async () => {
  const { data, error } = await aliceClient.rpc("stats_by_content_type", {
    p_user_id: aliceId,
  });
  expect(error).toBeNull();
  if (data && data.length > 0) {
    const total = data.reduce(
      (sum: number, r: { count: number }) => sum + Number(r.count),
      0,
    );
    expect(total).toBe(2);
  }
});
```

### stats_by_event_type (lines 229-241)

```typescript
it("should return only Alice's stats when Alice calls stats_by_event_type", async () => {
  const { data, error } = await aliceClient.rpc("stats_by_event_type", {
    p_user_id: aliceId,
  });
  expect(error).toBeNull();
  if (data && data.length > 0) {
    const total = data.reduce(
      (sum: number, r: { count: number }) => sum + Number(r.count),
      0,
    );
    expect(total).toBe(2);
  }
});
```

## Required Changes

For BOTH tests, apply the same pattern:

1. Remove `if (data && data.length > 0) {` guard line
2. Add `expect(data!.length).toBeGreaterThan(0);` assertion after the `expect(error).toBeNull()` line
3. Remove the closing `}` of the if block
4. Keep the `reduce` and `expect(total).toBe(2)` assertions unchanged

### stats_by_content_type — after fix:

```typescript
it("should return only Alice's stats when Alice calls stats_by_content_type", async () => {
  const { data, error } = await aliceClient.rpc("stats_by_content_type", {
    p_user_id: aliceId,
  });
  expect(error).toBeNull();
  expect(data!.length).toBeGreaterThan(0);
  const total = data!.reduce(
    (sum: number, r: { count: number }) => sum + Number(r.count),
    0,
  );
  expect(total).toBe(2);
});
```

### stats_by_event_type — after fix:

Same pattern — replace `if` guard with `expect(data!.length).toBeGreaterThan(0)` and un-indent the reduce block.

## Why This Change

The `if` guard means: if the RPC returns empty data, skip the assertions entirely. The test "passes" but proves nothing. This is the exact bug pattern that was already fixed for `search_events` (at lines 200-204 in the same file). Both tests seed Alice with 2 events, so both stats RPCs should return non-empty results with a total count of 2.

## Reference: Correct Pattern (search_events at lines 195-205)

```typescript
it("should return only Alice's events when Alice calls search_events", async () => {
  const { data, error } = await aliceClient.rpc("search_events", {
    p_user_id: aliceId,
    query_text: "Test enrichment",
  });
  expect(error).toBeNull();
  expect(data!.length).toBeGreaterThan(0);
  expect(
    data!.every((r: { id: string }) => aliceSeed.eventIds.includes(r.id)),
  ).toBe(true);
});
```

## Testing

### Pre-implementation
- Confirm both tests have `if (data && data.length > 0)` guards

### Post-implementation
- Both tests assert `data!.length > 0` (will fail if RPC returns empty)
- Both tests verify `total === 2` (Alice's 2 seeded events)
- No `if` guards remain in the RPC test section
- Run `npm run test:integration` — all tests pass
