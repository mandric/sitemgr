# Section 07: Agent Action Hardening

**Depends on:** section-01 (logger + request context), section-04 (S3 hardening), section-05 (enrichment hardening), section-06 (DB hardening)
**Blocks:** section-08 (CLI hardening)
**Can be implemented as an independent PR**

---

## What You Are Building

Three targeted improvements to `web/lib/agent/core.ts`:

1. **Request context propagation** — wrap every `executeAction` dispatch in `runWithRequestId()` so that all downstream log entries (from `db.ts`, `s3.ts`, `enrichment.ts`) automatically carry the same `request_id` without any signature changes.
2. **Error response standardization** — all error JSON returned by action handlers gains a typed `errorType` field alongside the existing `error` string, making errors programmatically distinguishable by callers and summaries.
3. **`indexBucket` hardening** — replace the sequential `for` loop with `p-limit` concurrency, handle per-object failures gracefully, and return a richer result shape including per-object status.

No new files are created. No new library dependencies beyond `p-limit` (added in section 02).

---

## Tests First

**Extend the existing file:** `web/__tests__/agent-core.test.ts`

The existing file already mocks `@anthropic-ai/sdk` and tests `sendMessageToAgent`. Add new `describe` blocks for the three areas below. Do not break or modify the existing tests.

### Shared mock setup additions

The new tests need mocks for the media library modules that `executeAction` calls. Add these at the top of the file alongside the existing Anthropic mock:

```typescript
// Mock the entire media library so tests don't touch Supabase or S3
vi.mock("@/lib/media/db", () => ({
  getAdminClient: vi.fn(),
  queryEvents: vi.fn(),
  showEvent: vi.fn(),
  getStats: vi.fn(),
  getEnrichStatus: vi.fn(),
  insertEvent: vi.fn(),
  insertEnrichment: vi.fn(),
  upsertWatchedKey: vi.fn(),
  getWatchedKeys: vi.fn(),
}));

vi.mock("@/lib/media/s3", () => ({
  createS3Client: vi.fn(),
  listS3Objects: vi.fn(),
  downloadS3Object: vi.fn(),
}));

vi.mock("@/lib/media/enrichment", () => ({
  enrichImage: vi.fn(),
}));

vi.mock("@/lib/request-context", () => ({
  runWithRequestId: vi.fn((id, fn) => fn()),  // transparent passthrough by default
  getRequestId: vi.fn(() => undefined),
}));
```

Import the mocked modules at the top so tests can configure return values:

```typescript
import { queryEvents, getStats, insertEvent, insertEnrichment, upsertWatchedKey, getWatchedKeys } from "@/lib/media/db";
import { listS3Objects, downloadS3Object } from "@/lib/media/s3";
import { enrichImage } from "@/lib/media/enrichment";
import { runWithRequestId } from "@/lib/request-context";
```

### Request context tests

```typescript
describe("executeAction — request context", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    // stub resolveUserId to return a fixed user
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  // Test: executeAction wraps execution in runWithRequestId
  //       — verify runWithRequestId is called exactly once per executeAction call
  // Test: the request ID passed to runWithRequestId is a non-empty string
  // Test: the request ID is different for two consecutive executeAction calls
  //       (each invocation generates a fresh ID)
  // Test: the action handler runs inside the runWithRequestId callback
  //       (verify by checking that queryEvents is called after runWithRequestId is called)
});
```

The key assertions: import `runWithRequestId` from the mock and use `expect(runWithRequestId).toHaveBeenCalledOnce()` after each `executeAction` call. For the unique-ID test, capture the argument on two consecutive calls and assert they differ.

### Error standardization tests

```typescript
describe("executeAction — error response shape", () => {
  // Test: unknown action returns JSON with both "error" and "errorType" fields
  //       plan = { action: "unknown_action" }
  //       parsed response should have errorType: "not_found" or errorType: "internal"
  // Test: missing bucket_name in add_bucket returns errorType: "validation_error"
  // Test: unresolved phone number (no userId) returns errorType: "not_found"
  // Test: when a media library function throws, response includes errorType: "internal"
  //       — configure queryEvents mock to throw, call action "query",
  //         parse JSON response, assert errorType === "internal"
  // Test: error responses never include errorType: undefined
  //       — all action error paths set a non-empty errorType string
  // Test: success responses include success: true
  //       — configure getStats mock to return {}, call action "stats",
  //         assert parsed response contains success: true (or at minimum no errorType)
});
```

### indexBucket concurrency and partial failure tests

```typescript
describe("indexBucket — concurrency and partial failure", () => {
  beforeEach(() => {
    // Configure a mock S3 client with a recognizable shape
    // getWatchedKeys returns empty set (all objects are new)
    // insertEvent resolves by default
    // upsertWatchedKey resolves by default
    // enrichImage resolves with a valid EnrichmentResult by default
    // insertEnrichment resolves by default
  });

  // Test: indexBucket calls listS3Objects once
  // Test: indexBucket processes multiple objects — verify insertEvent is called
  //       once per object in the batch
  // Test: when one insertEvent call throws for a specific object, indexBucket
  //       continues and processes the remaining objects (does not abort)
  // Test: the result JSON includes an "errors" array listing the key of the failed object
  // Test: when enrichImage throws for one image, indexBucket continues enriching others
  //       — mock enrichImage to throw for key "bad.jpg" and succeed for "good.jpg"
  //       — assert insertEnrichment is called for "good.jpg" but not "bad.jpg"
  // Test: result JSON includes batch_indexed count (only successfully indexed objects)
  // Test: result JSON includes batch_enriched count (only successfully enriched objects)
  // Test: result JSON includes per_object array with { key, status } entries
  //       where status is "indexed", "enriched", "enrich_failed", or "error"
  // Test: non-image objects (e.g., "archive.zip") are indexed but not enriched
  //       — enrichImage is not called for non-image keys
  //       — status for that key is "indexed" not "enriched"
});
```

For the concurrency test, you cannot directly observe `p-limit` concurrency in a unit test without timing. Instead verify correctness: all objects in the batch are processed, failures are isolated. If you want to assert concurrency limit, use a spy that tracks how many concurrent invocations are in-flight at peak and assert it does not exceed the limit.

---

## Implementation: Request Context at Action Dispatch

### Where to add it

In `executeAction` (around line 152 of `web/lib/agent/core.ts`), generate a request ID at the top of the function and wrap the rest of the function body — including the `resolveUserId` call and the `switch` — inside `runWithRequestId`:

```typescript
import { runWithRequestId } from "@/lib/request-context";
import { createLogger } from "@/lib/logger";

const logger = createLogger("agent");

export async function executeAction(
  plan: AgentPlan,
  phoneNumber: string,
  preResolvedUserId?: string | null,
): Promise<string> {
  const requestId = generateRequestId();  // see below
  return runWithRequestId(requestId, async () => {
    // ... entire existing body goes here
  });
}
```

### Generating the request ID

Generate a short unique string for each action. Use `crypto.randomUUID()` (available in Node 14.17+ without import) or build a simple timestamp+random string. Do NOT import `ulid` just for this — `crypto.randomUUID()` is sufficient and has no dependency:

```typescript
function generateRequestId(): string {
  return crypto.randomUUID();
}
```

### What this gives you

After this change, every log line emitted by any media library function called during an action will include `"request_id": "<uuid>"` automatically, because `getRequestId()` reads from `AsyncLocalStorage`. No function signatures change anywhere else.

Log the action start at the entry point:

```typescript
logger.info("action dispatch", {
  action: plan.action,
  request_id: requestId,
});
```

---

## Implementation: Error Response Standardization

### The errorType enum

Define this near the top of `core.ts`, after the imports:

```typescript
export type ErrorType =
  | "not_found"        // resource doesn't exist (unknown user, missing bucket)
  | "access_denied"    // user exists but cannot perform the operation
  | "validation_error" // caller provided bad input (missing required field)
  | "api_error"        // external API failure (S3, Claude)
  | "timeout"          // operation exceeded time limit
  | "internal";        // unexpected error (programming error, unhandled case)
```

### Helper function

Add a private helper that produces standardized error JSON:

```typescript
function errorResponse(
  message: string,
  errorType: ErrorType,
  details?: Record<string, unknown>,
): string {
  return JSON.stringify({
    error: message,
    errorType,
    ...(details ? { details } : {}),
  });
}
```

### Applying errorType across action handlers

Go through every location in `executeAction` and the private action functions that currently return `JSON.stringify({ error: "..." })` and replace them with `errorResponse(...)` calls using the appropriate type:

| Existing error message pattern | errorType |
|---|---|
| `"Unknown user — phone number not registered"` | `"not_found"` |
| `"Could not resolve user for this phone number"` | `"not_found"` |
| `"bucket_name is required"` | `"validation_error"` |
| `"Missing required fields: ..."` | `"validation_error"` |
| `"Bucket ... not found"` | `"not_found"` |
| `"Bucket ... is already configured"` | `"validation_error"` |
| `"Cannot read bucket ..."` (S3 access failure) | `"api_error"` |
| `"Failed to list objects: ..."` | `"api_error"` |
| `"Failed to index bucket: ..."` (top-level catch) | `"internal"` |
| `"Failed to save bucket configuration"` | `"internal"` |
| `"Failed to retrieve buckets"` | `"internal"` |
| `"Failed to remove bucket"` | `"internal"` |
| `"Unknown action: ..."` | `"not_found"` |

For the `decrypt` failure path in `getBucketConfig` / `requireS3Client`, use `"internal"` — the key is present but unusable.

### Success response shape

Success responses are not uniformly structured today. Leave them mostly as-is for now — this section standardizes errors, not successes. The one addition: wherever an action returns a success JSON object, log the completion at `info` level:

```typescript
logger.info("action complete", {
  action: plan.action,
  duration_ms: Date.now() - startMs,
});
```

Capture `startMs = Date.now()` at the top of the `runWithRequestId` callback.

---

## Implementation: indexBucket Improvements

### Current problems

The existing `indexBucket` function (lines 656–752 in `core.ts`):

1. Processes objects sequentially with a plain `for` loop — slow for large batches.
2. On a per-object `catch`, it appends to an `errors` string array but provides no structured per-object status.
3. On enrichment failure, it creates an `enrich_failed` event in the database — this is a side effect that adds noise to the event store. Replace with in-memory tracking only.
4. Does not report which specific objects succeeded or failed.

### Result shape

Define the new result shape inline (no need for a separate exported type):

```typescript
type ObjectStatus = "enriched" | "indexed" | "enrich_failed" | "error";

interface IndexBucketResult {
  bucket: string;
  total_objects: number;
  already_indexed: number;
  remaining: number;
  batch_size: number;
  batch_indexed: number;
  batch_enriched: number;
  per_object: Array<{ key: string; status: ObjectStatus; error?: string }>;
}
```

### Concurrency with p-limit

Replace the `for` loop with `p-limit`. Import at the top of the file:

```typescript
import pLimit from "p-limit";
```

Inside `indexBucket`, after determining `batch`:

```typescript
const limit = pLimit(3);  // max 3 concurrent object operations

const results = await Promise.all(
  batch.map((obj) =>
    limit(async () => {
      // process one object; return { key, status, error? }
    })
  )
);
```

Each task in the limit callback should never throw — catch all errors internally and return a result object with `status: "error"`. This ensures `Promise.all` always resolves.

### Per-object processing logic

For each object, the processing steps are:

1. Create the event with `insertEvent`. If this throws, return `{ key, status: "error", error: message }` — do not proceed to upsert or enrichment.
2. Upsert the watched key with `upsertWatchedKey` (passing `bucketConfigId: s3.config.id` — the fix from section 06). If this throws, log a warning but still count the object as indexed.
3. If the MIME type is a supported image format, download and enrich:
   - If `downloadS3Object` throws, return `{ key, status: "enrich_failed", error: message }` — the event was created, just not enriched.
   - If `enrichImage` throws, return `{ key, status: "enrich_failed", error: message }`.
   - If `insertEnrichment` throws, return `{ key, status: "enrich_failed", error: message }`.
   - On success, return `{ key, status: "enriched" }`.
4. If the MIME type is not a supported image, return `{ key, status: "indexed" }`.

Do NOT create `enrich_failed` events in the database when enrichment fails. The failure is captured in the `per_object` result and logged. Creating events for failures adds clutter and makes stats reporting less accurate.

### Assembling the final result

After all promises resolve:

```typescript
const perObject = results;  // Array<{ key, status, error? }>

const batchIndexed = perObject.filter(
  (r) => r.status === "indexed" || r.status === "enriched" || r.status === "enrich_failed"
).length;
const batchEnriched = perObject.filter((r) => r.status === "enriched").length;

const result: IndexBucketResult = {
  bucket: bucketName,
  total_objects: allObjects.length,
  already_indexed: allObjects.length - newObjects.length,
  remaining: Math.max(0, newObjects.length - batch.length),
  batch_size: batch.length,
  batch_indexed: batchIndexed,
  batch_enriched: batchEnriched,
  per_object: perObject,
};

logger.info("indexBucket complete", {
  bucket: bucketName,
  batch_indexed: batchIndexed,
  batch_enriched: batchEnriched,
  errors: perObject.filter((r) => r.status === "error").length,
});

return JSON.stringify(result);
```

### Remove the enrich_failed event write

Delete the block inside the current enrichment `catch` that calls `insertEvent` with `type: "enrich_failed"`. That pattern is removed entirely. The per-object result array is the record of what failed and why.

---

## Logging in agent/core.ts

Import and use the logger for these points:

- `executeAction` entry: `logger.info("action dispatch", { action, request_id })` — at `debug` level is fine since this fires for every message
- `getBucketConfig` lazy migration success and failure: replace the existing `console.log` and `console.error` calls with `logger.info` and `logger.error` respectively
- `requireS3Client` decryption failure: replace `console.error` with `logger.error`
- `indexBucket` completion: `logger.info("indexBucket complete", { ... })` as shown above
- `verifyBucketConfig` failure: replace `console.info` with `logger.info`

Leave `listBuckets`, `addBucket`, and `removeBucket` `console.error` calls as the lowest priority — they can be converted to `logger.error` but are not critical for this section.

---

## Call Site Update: upsertWatchedKey

Section 06 adds `bucketConfigId` as a new last parameter to `upsertWatchedKey`. Update the call in `indexBucket` to pass it:

```typescript
await upsertWatchedKey(
  obj.key,
  eventId,
  obj.etag,
  obj.size,
  userId ?? undefined,
  s3.config.id,          // new: bucket_config_id from section 06 fix
);
```

This is the only call site of `upsertWatchedKey` in `core.ts`.

---

## Summary of Changes

| Location | Change |
|---|---|
| `executeAction` | Wrap body in `runWithRequestId(generateRequestId(), ...)` |
| `executeAction` | Add `startMs` capture and completion log at `info` level |
| New `errorResponse()` helper | Returns `{ error, errorType, details? }` JSON |
| All `JSON.stringify({ error: "..." })` sites | Replace with `errorResponse(message, type)` |
| New `ErrorType` type | Exported union string literal type |
| `indexBucket` | Replace `for` loop with `pLimit(3)` + `Promise.all` |
| `indexBucket` | Add `per_object` array to result shape |
| `indexBucket` | Remove `insertEvent` call for `enrich_failed` events |
| `indexBucket` | Pass `s3.config.id` as `bucketConfigId` to `upsertWatchedKey` |
| Throughout | Replace `console.log`/`console.error` with structured logger |
