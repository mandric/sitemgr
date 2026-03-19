# Section 06: Database Operations Hardening

## Overview

This section fixes two existing bugs in `web/lib/media/db.ts`, adds Postgres error code mapping, hardens search query behavior, and integrates the Supabase retry helper from section 02. After this section the database layer is correct, observable, and resilient.

**File to modify:** `web/lib/media/db.ts`

**Dependencies:**
- Section 01 (structured logger and `getRequestId()`) must be complete — logging calls added here use the logger from `web/lib/logger.ts`.
- Section 02 (retry helper) must be complete — `withRetry()` from `web/lib/retry.ts` is used for Supabase calls.

---

## Tests First

**New file:** `web/__tests__/db-operations.test.ts`

All tests in this file mock the Supabase client. Use `vi.mock("@supabase/supabase-js")` to intercept `createClient` and return a chainable mock object whose `.from()`, `.select()`, `.upsert()`, `.insert()`, `.eq()`, `.rpc()`, etc. return mock responses. Follow the same mock-chaining pattern already used in `web/__tests__/s3-actions.test.ts` and `web/__tests__/whatsapp-route.test.ts`.

Use `vi.stubEnv()` in `beforeEach` for the required env vars:

```typescript
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test-service-key");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
```

### upsertWatchedKey — bug fix tests

```typescript
// Test: upsert call includes bucket_config_id in the row data
// Test: onConflict is set to "s3_key,bucket_config_id" (composite key)
// Test: ignoreDuplicates is NOT set (or is false) — the upsert updates on conflict
// Test: upsert row includes etag and size_bytes in the update columns
// Test: logs a message when an existing key is updated (etag differs from last known)
// Test: accepts null bucket_config_id without error
```

The key assertion for the conflict fix: verify the object passed to `.upsert(..., options)` has `onConflict: "s3_key,bucket_config_id"` and does NOT have `ignoreDuplicates: true`.

### queryEvents — N+1 fix tests

```typescript
// Test: queryEvents with no search option issues exactly ONE Supabase query (not one per event)
// Test: returned events include enrichment data attached inline
// Test: queryEvents with search option calls the search_events RPC (already correct — no change)
// Test: queryEvents returns empty array when no events match
// Test: queryEvents with empty string search returns empty results without calling RPC
// Test: queryEvents caps result_limit at 100 (passes 100 even if caller passes 500)
// Test: queryEvents logs duration_ms after query completes
```

For the N+1 assertion, count the number of times the mocked `.from()` or `.select()` is called. Before the fix there is one call per event for enrichments. After the fix there is one combined query.

### Error mapping tests

```typescript
// Test: a Supabase error with code "23505" is thrown as an error with message containing "duplicate key"
// Test: a Supabase error with code "23503" is thrown as an error with message containing "FK violation"
// Test: a Supabase error with code "42501" is thrown as an error with message containing "RLS denied"
// Test: error message includes the table name (e.g., "events", "enrichments", "watched_keys")
// Test: error message includes the operation name (e.g., "insert", "upsert", "select")
// Test: a Supabase error with an unmapped code is re-thrown with its original message
```

### insertEvent tests

```typescript
// Test: inserts row with all required fields set
// Test: timestamp defaults to current ISO string when not provided
// Test: throws mapped error on duplicate event ID (code 23505)
```

### insertEnrichment tests

```typescript
// Test: inserts enrichment row linked to the given event_id
// Test: throws mapped FK violation error when event_id does not exist (code 23503)
```

### getStats tests

```typescript
// Test: returns correct shape: total_events, by_content_type, by_event_type, watched_s3_keys, enriched, pending_enrichment
// Test: handles empty database (all counts are 0)
```

### getEnrichStatus tests

```typescript
// Test: returns total_media, enriched, pending with correct values
// Test: pending is 0 when all events are enriched
// Test: handles no events (total_media = 0, enriched = 0, pending = 0)
```

---

## Bug Fix 1: `upsertWatchedKey` Composite Conflict Key

### What is broken

The current call in `web/lib/media/db.ts` (around line 264) is:

```typescript
{ onConflict: "s3_key", ignoreDuplicates: true }
```

This is wrong in two ways:
1. The `watched_keys` table has a composite primary key of `(s3_key, bucket_config_id)`. Using only `s3_key` as the conflict target will cause the upsert to fail or silently misbehave when two different buckets have an object with the same key (a common scenario).
2. `ignoreDuplicates: true` means that when a key is re-scanned with a new ETag (because the object was replaced), the `etag`, `size_bytes`, and `event_id` columns are never updated. The database retains stale data forever.

### Fix

Add `bucket_config_id` as a parameter to `upsertWatchedKey`:

```typescript
export async function upsertWatchedKey(
  s3Key: string,
  eventId: string | null,
  etag: string,
  sizeBytes: number,
  userId?: string,
  bucketConfigId?: string,  // new parameter
): Promise<void>
```

Change the upsert options to use the composite conflict key and perform an actual update on conflict:

```typescript
{
  onConflict: "s3_key,bucket_config_id",
  // No ignoreDuplicates — let it update the row
}
```

The upserted row should include all columns. On conflict, Supabase will update all non-conflict columns. Log at `info` level when an existing key is being updated (this is normal during re-scans and useful for observability).

The caller in `web/lib/agent/core.ts` passes `s3.config.id` as the bucket config ID — update that call site to pass the new parameter.

---

## Bug Fix 2: N+1 Enrichment Query in `queryEvents`

### What is broken

In the non-search path of `queryEvents` (lines 96–107 in the current file), there is a loop:

```typescript
for (const evt of events) {
  const { data: enrichment } = await supabase
    .from("enrichments")
    .select("description, objects, context, tags")
    .eq("event_id", evt.id)
    .maybeSingle();
  ...
}
```

This issues one Supabase round-trip per event. With 1,000 events, that is 1,001 queries (1 for events + 1 per event for enrichment). At typical Supabase latencies this is unusably slow.

### Fix

Replace the loop with a single joined query using Supabase's PostgREST foreign key embedding syntax:

```typescript
const { data, count, error } = await supabase
  .from("events")
  .select("*, enrichments(description, objects, context, tags)", { count: "exact" })
  .eq("type", "create")
  .order("timestamp", { ascending: false })
  .range(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 20) - 1);
```

PostgREST resolves the join server-side. The returned rows have an `enrichments` field (which is an array with 0 or 1 items because of the FK relationship). Normalize the result before returning: if `row.enrichments` is a non-empty array, set `row.enrichment = row.enrichments[0]` and delete `row.enrichments`.

Apply the same single-query fix to `showEvent`, which has an equivalent two-round-trip pattern for fetching the enrichment (lines 126–134).

---

## Postgres Error Code Mapping

### Motivation

Currently the database layer throws raw Supabase error objects, which have a `code` property with a Postgres error code (e.g., `"23505"`) and a `message` property with a terse pg message. When these bubble up to callers or logs, the meaning is opaque.

### Implementation

Add a private helper function inside `db.ts`:

```typescript
function mapDbError(error: { code?: string; message: string }, context: { table: string; operation: string }): Error
```

This function examines `error.code` and returns a new `Error` with a human-readable message that includes the table name, operation, and a description of what the code means:

- `"23505"` → `"duplicate key in {table} during {operation}"`
- `"23503"` → `"FK violation in {table} during {operation}"`
- `"42501"` → `"RLS denied on {table} during {operation}"`
- Any other code → re-use the original message, but still include table and operation in the string

Wrap every Supabase operation that can fail with `mapDbError`. The pattern is:

```typescript
const { data, error } = await supabase.from("events").insert(...);
if (error) throw mapDbError(error, { table: "events", operation: "insert" });
```

---

## Search Robustness

### Empty query guard

When `opts.search` is an empty string (`""`), do not call the `search_events` RPC. An empty full-text search query will error or return unexpected results depending on the Postgres `to_tsquery` configuration. Instead, return `{ events: [], total: 0 }` immediately. Check for both `undefined` and `""`:

```typescript
if (opts.search && opts.search.trim() !== "") {
  // call RPC
}
```

### Result limit cap

The `result_limit` parameter passed to `search_events` RPC should be capped at 100. Unbounded queries can time out or return response payloads too large to process:

```typescript
result_limit: Math.min(opts.limit ?? 20, 100),
```

Apply the same cap to the non-search `.range()` call so that `opts.limit` cannot exceed 100 there either.

### Search performance logging

After `queryEvents` completes, log at `info` level:

```typescript
logger.info("queryEvents", {
  has_search: !!opts.search,
  result_count: events.length,
  duration_ms: /* elapsed time */,
  request_id: getRequestId(),  // from section 01
});
```

Use `Date.now()` before and after the query for `duration_ms`. Import `getRequestId` from `web/lib/request-context.ts` (section 01).

---

## Supabase Retry Integration

Wrap the Supabase operations in `db.ts` that are most susceptible to transient failures with `withRetry()` from `web/lib/retry.ts` (section 02):

- `insertEvent` — network flakiness during batch indexing makes this important
- `insertEnrichment` — same reason
- `upsertWatchedKey` — called in a loop during indexing

Do NOT wrap `queryEvents` or `getStats` with retry — reads that fail should surface to the caller immediately rather than adding latency.

The retry config for db operations should use the defaults from section 02 (2 retries, 500ms base delay). The `shouldRetry` predicate should return `false` for Postgres error codes `23505`, `23503`, and `42501` (these are logic errors, not transient failures; retrying them will never succeed).

---

## Logging

Import the logger at the top of `db.ts`:

```typescript
import { createLogger } from "@/lib/logger";  // section 01
import { getRequestId } from "@/lib/request-context";  // section 01

const logger = createLogger("db");
```

Add logging at these points:
- `upsertWatchedKey`: log at `debug` when inserting a new key; log at `info` when updating an existing key (with old and new ETag values).
- `insertEvent`: log at `debug` with `event_id` and `content_type`.
- `insertEnrichment`: log at `debug` with `event_id`.
- `queryEvents`: log at `info` with result count and duration (see above).
- Any mapped DB error: log at `error` with table, operation, and Postgres code before throwing.

---

## Summary of Changes

| Location | Change |
|---|---|
| `upsertWatchedKey` signature | Add `bucketConfigId?: string` parameter |
| `upsertWatchedKey` upsert call | `onConflict: "s3_key,bucket_config_id"`, remove `ignoreDuplicates` |
| `queryEvents` non-search path | Replace N+1 loop with single joined `select("*, enrichments(...)")` |
| `showEvent` | Replace two-query pattern with single joined query |
| All mutating operations | Wrap Supabase error with `mapDbError(error, { table, operation })` |
| `queryEvents` search path | Guard against empty string; cap limit at 100 |
| `insertEvent`, `insertEnrichment`, `upsertWatchedKey` | Wrap with `withRetry()` |
| Throughout | Replace `console.log`/`console.error` with structured logger |
| `web/lib/agent/core.ts` | Update `upsertWatchedKey` call site to pass `s3.config.id` |
