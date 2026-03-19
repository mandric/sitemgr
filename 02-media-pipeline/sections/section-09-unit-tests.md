# Section 09: Unit Tests

**Depends on:** sections 01–08 (all implementation sections must be complete)
**Blocks:** section-10 (integration tests)
**Can be implemented as an independent PR once sections 01–08 are merged**

---

## What You Are Building

This section consolidates every unit test stub defined across sections 01–08 into concrete, runnable test files. If you wrote tests alongside each implementation section (the recommended approach), this section is a review and gap-filling pass. If tests were deferred, this section is the full write.

**New files to create:**

- `web/__tests__/s3-client.test.ts`
- `web/__tests__/enrichment.test.ts`
- `web/__tests__/db-operations.test.ts`
- `web/__tests__/retry.test.ts`
- `web/__tests__/logger.test.ts`
- `web/__tests__/request-context.test.ts`
- `web/__tests__/validation.test.ts`

**Existing file to extend:**

- `web/__tests__/media-utils.test.ts` — add edge-case tests to the end of the existing file

**No implementation files change in this section.** If a test reveals a bug, fix the implementation file in a separate commit before continuing.

---

## Testing Framework and Conventions

Framework: Vitest (configured in `web/vitest.config.ts`).

Run command: `npm test` from `web/`.

Standard setup block for env vars:

```typescript
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test-service-key");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
  vi.stubEnv("ENCRYPTION_KEY_CURRENT", "test-fixture-key-32bytes-padding!");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
```

Use `vi.stubEnv()` for all environment variables. Never set real secrets in test files. See `CLAUDE.md` — the pattern is: fixtures for unit tests, real service values only for E2E tests that actually connect to a service.

Import alias `@/` maps to `web/` (configured in `tsconfig.json`). Use it for all project imports.

---

## File 1: `web/__tests__/logger.test.ts`

Tests the structured logger from section 01.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, LogComponent } from "@/lib/logger";
import { runWithRequestId } from "@/lib/request-context";

describe("createLogger", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test: returns an object with debug, info, warn, and error methods
  // Test: info() writes exactly one line to stderr (console.error called once)
  // Test: info() does NOT write to stdout (console.log not called)
  // Test: error() writes to stderr
  // Test: debug() and warn() write to stderr
  // Test: the argument passed to console.error is valid JSON (JSON.parse does not throw)
  // Test: JSON entry includes "timestamp" field that parses as a valid Date
  // Test: JSON entry includes "level" matching the method called ("info", "warn", "error", "debug")
  // Test: JSON entry includes "component" matching the string passed to createLogger
  // Test: JSON entry includes "message" matching the string argument
  // Test: extra metadata fields are spread into the top-level JSON object, not nested under "meta"
  //       e.g. logger.info("msg", { duration_ms: 42 }) → entry.duration_ms === 42
  // Test: nested objects in metadata are preserved as-is
  // Test: when meta contains an Error instance, error_message and error_stack are in top-level entry
  // Test: request_id is omitted from JSON when called outside any runWithRequestId context
  // Test: request_id is present in JSON when called inside runWithRequestId
  //       — value matches the ID passed to runWithRequestId
});
```

**Key pattern for asserting JSON output:**

```typescript
it("info() outputs valid JSON to stderr", () => {
  const logger = createLogger("test-component");
  logger.info("hello world", { userId: "u1" });

  expect(console.error).toHaveBeenCalledOnce();
  const raw = (console.error as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as string;
  const entry = JSON.parse(raw);

  expect(entry.level).toBe("info");
  expect(entry.component).toBe("test-component");
  expect(entry.message).toBe("hello world");
  expect(entry.userId).toBe("u1");
  expect(() => new Date(entry.timestamp)).not.toThrow();
});
```

`LogComponent` constants (S3, Enrichment, DB, etc.) are strings — test that `createLogger(LogComponent.S3)` produces `"component": "s3"` in the output.

---

## File 2: `web/__tests__/request-context.test.ts`

Tests the `AsyncLocalStorage`-based request ID propagation from section 01.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWithRequestId, getRequestId } from "@/lib/request-context";
import { createLogger } from "@/lib/logger";

describe("runWithRequestId / getRequestId", () => {
  // Test: getRequestId() returns undefined when called outside any context
  // Test: getRequestId() returns the ID passed to runWithRequestId within the callback
  // Test: the return value of runWithRequestId is the return value of the callback
  // Test: nested async calls (await Promise.resolve, await new Promise setTimeout)
  //       inside the callback can read the same request ID via getRequestId()
  // Test: after the callback completes, getRequestId() returns undefined again
});

describe("concurrent context isolation", () => {
  it("two parallel runWithRequestId calls are isolated from each other", async () => {
    const results: string[] = [];
    await Promise.all([
      runWithRequestId("req-A", async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(getRequestId()!);
      }),
      runWithRequestId("req-B", async () => {
        await new Promise((r) => setTimeout(r, 2));
        results.push(getRequestId()!);
      }),
    ]);
    expect(results).toContain("req-A");
    expect(results).toContain("req-B");
    expect(results).toHaveLength(2);
  });
});

describe("logger integration", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test: logger includes "request_id" in JSON when called inside runWithRequestId
  //       — the value equals the ID passed to runWithRequestId
  // Test: logger omits "request_id" key entirely when called outside any context
  //       — JSON.parse(raw) should not have a request_id property at all
});
```

---

## File 3: `web/__tests__/retry.test.ts`

Tests the Supabase-only retry helper from section 02.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "@/lib/retry";

describe("withRetry", () => {
  // Test: resolves on first try — fn called once, result returned
  // Test: retries on failure and eventually succeeds
  //       — fn throws twice, succeeds on third call; verify fn called exactly 3 times
  // Test: retries up to maxRetries then throws the original error
  //       — fn always throws; after maxRetries+1 calls, withRetry rejects with original error
  // Test: stops retrying when shouldRetry returns false for the thrown error
  //       — shouldRetry returns false for a specific error; fn is called only once
  // Test: does not retry on Postgres constraint violation by default
  //       (shouldRetry default returns false for code "23505")

  it("uses exponential backoff via injectable delayFn", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelay: 100,
        delayFn: async (ms) => { delays.push(ms); },
      }),
    ).rejects.toThrow("fail");

    expect(delays).toHaveLength(3);
    expect(delays[1]).toBeGreaterThan(delays[0]);  // exponential growth
    expect(delays[2]).toBeGreaterThan(delays[1]);
  });

  it("caps delay at maxDelay", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      withRetry(fn, {
        maxRetries: 5,
        baseDelay: 1000,
        maxDelay: 2000,
        delayFn: async (ms) => { delays.push(ms); },
      }),
    ).rejects.toThrow();

    expect(Math.max(...delays)).toBeLessThanOrEqual(2000);
  });

  // Test: onRetry callback fires with (attempt, error, delayMs) arguments on each retry
  //       — capture calls, assert called maxRetries times with increasing attempt numbers
});
```

The `delayFn` parameter is the key to deterministic timing. Tests must never call `withRetry` without injecting `delayFn` — real `setTimeout` delays make unit tests slow and flaky.

---

## File 4: `web/__tests__/validation.test.ts`

Tests the image, S3 key, and bucket config validators from section 03.

```typescript
import { describe, it, expect } from "vitest";
import { validateImage, validateS3Key, validateBucketConfig } from "@/lib/media/validation";

// === Magic byte helpers for constructing test buffers ===
// JPEG: Buffer.from([0xFF, 0xD8, 0xFF, 0x00, ...padded to required length])
// PNG:  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...])
// GIF:  Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...])
// WebP: Buffer from [0x52,0x49,0x46,0x46, <4 bytes size>, 0x57,0x45,0x42,0x50, ...]

describe("validateImage", () => {
  // Test: returns valid=true for a correct JPEG buffer + "image/jpeg" mime
  // Test: returns valid=true for a correct PNG buffer + "image/png" mime
  // Test: returns valid=true for a correct GIF buffer + "image/gif" mime
  // Test: returns valid=true for a correct WebP buffer + "image/webp" mime
  // Test: returns valid=false with error for file larger than 20MB
  //       (20 * 1024 * 1024 + 1 bytes with valid JPEG magic)
  // Test: returns valid=false with error for unsupported MIME type "image/tiff"
  // Test: returns valid=false with error when magic bytes don't match declared MIME
  //       (PNG magic bytes but "image/jpeg" mime)
  // Test: returns valid=false with error for empty buffer (zero bytes)
  // Test: returns valid=false with error for buffer shorter than 8 bytes
  // Test: returns valid=true with a warning (not error) when dimensions metadata indicates >1568px
  //       — warnings.length > 0, errors.length === 0, valid === true
  // Test: normalises "image/jpg" to "image/jpeg" before checking MIME type
  //       (a buffer with JPEG magic + mime "image/jpg" should pass)
});

describe("validateS3Key", () => {
  // Test: returns valid=true for "photos/2024/vacation/beach.jpg"
  // Test: returns valid=true for key with spaces
  // Test: returns valid=true for key with unicode characters
  // Test: returns valid=false for key containing a null byte (\x00)
  // Test: returns valid=false for key longer than 1024 bytes
  //       (string of 1025 'a' characters)
  // Test: returns valid=false for key containing a control character (\x01, \x1F, etc.)
  // Test: returns valid=false for empty string key
});

describe("validateBucketConfig", () => {
  const validConfig = {
    bucket_name: "my-bucket",
    endpoint_url: "https://s3.example.com",
    region: "us-east-1",
    access_key_id: "AKIAIOSFODNN7EXAMPLE",
    secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  // Test: returns valid=true for a complete valid config
  // Test: returns valid=false for empty bucket_name
  // Test: returns valid=false for bucket_name consisting only of whitespace
  // Test: returns valid=false for endpoint_url that is not a valid URL ("not-a-url")
  // Test: returns valid=true when endpoint_url is omitted (optional field)
  // Test: returns valid=true when region is omitted (optional field)
  // Test: returns valid=false for empty access_key_id
  // Test: returns valid=false for empty secret_access_key
  // Test: returns multiple errors when multiple fields are invalid simultaneously
});
```

Construct minimal test buffers inline — no files on disk. For the >20MB test, use `Buffer.alloc()` with JPEG magic bytes in the first three positions and the rest zeroed; do not allocate gigabytes, just over the limit.

---

## File 5: `web/__tests__/s3-client.test.ts`

Tests the S3 client from section 04. Full test list defined in section 04's "Tests First" block — reproduce it here verbatim as the authoritative source. Key mock setup:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@aws-sdk/client-s3");
vi.mock("@smithy/node-http-handler");
```

Intercept `S3Client` constructor calls by capturing the options passed to it. Intercept `send()` calls by mocking the `S3Client` prototype or using a factory mock. Return shaped response objects for `ListObjectsV2Command`, `ListObjectsCommand`, `GetObjectCommand`, and `PutObjectCommand`.

**`describe` blocks to implement:**

```typescript
describe("createS3Client", () => {
  // Test: creates client with default region "us-east-1" when no region specified
  // Test: sets forcePathStyle: true when endpoint is provided
  // Test: sets forcePathStyle: false when no endpoint is provided
  // Test: passes credentials when both accessKeyId and secretAccessKey are provided
  // Test: omits credentials when either key is missing
  // Test: sets maxAttempts: 4
  // Test: sets retryMode: "adaptive"
  // Test: passes NodeHttpHandler with connectionTimeout: 5000 and socketTimeout: 30000
});

describe("listS3Objects", () => {
  // === Happy path ===
  // Test: returns S3Object array from single-page response (IsTruncated: false)
  // Test: collects objects across multiple v2 pages using ContinuationToken
  // Test: returns empty array when bucket is empty (Contents: undefined)
  // Test: returns empty array when bucket is empty (Contents: [])

  // === ETag and LastModified normalisation ===
  // Test: strips surrounding quotes from ETag ('"abc123"' → 'abc123')
  // Test: uses empty string for ETag when obj.ETag is undefined
  // Test: uses obj.LastModified as ISO string when present
  // Test: falls back to current timestamp (not empty string) when LastModified is missing
  // Test: logs a warning when LastModified fallback is used

  // === v1 fallback ===
  // Test: falls back to ListObjects v1 when v2 throws error with "not implemented" in message
  // Test: falls back to v1 when v2 throws error with "unsupported" in message
  // Test: rethrows (does NOT fall back) when v2 throws an unrelated error
  // Test: v1 fallback collects objects from single-page response
  // Test: v1 fallback paginates using Marker token across multiple pages
  // Test: v1 fallback uses last object key as Marker when NextMarker is absent

  // === Pagination guard ===
  // Test: throws after 1000 pages in v2 pagination
  // Test: throws after 1000 pages in v1 pagination
  // Test: error message includes bucket name and page count

  // === IsTruncated edge case ===
  // Test: treats response as last page when IsTruncated=true but no NextContinuationToken
  // Test: logs a warning in that case
});

describe("downloadS3Object", () => {
  // Test: downloads object and returns a Buffer with correct bytes
  // Test: calls validateS3Key before issuing the S3 request
  // Test: throws error with s3ErrorType === S3ErrorType.NotFound on 404
  // Test: throws error with s3ErrorType === S3ErrorType.AccessDenied on 403
  // Test: logs the error type and key before rethrowing
});

describe("uploadS3Object", () => {
  // Test: sends PutObjectCommand with correct Bucket, Key, Body, ContentType
  // Test: omits ContentType when not provided
  // Test: propagates error when upload fails
});

describe("classifyS3Error", () => {
  // Test: "not implemented" in message → S3ErrorType.Unsupported
  // Test: "unsupported" in message (case-insensitive) → S3ErrorType.Unsupported
  // Test: $metadata.httpStatusCode 404 → S3ErrorType.NotFound
  // Test: $metadata.httpStatusCode 403 → S3ErrorType.AccessDenied
  // Test: $metadata.httpStatusCode 401 → S3ErrorType.AccessDenied
  // Test: $metadata.httpStatusCode 500 → S3ErrorType.ServerError
  // Test: $metadata.httpStatusCode 503 → S3ErrorType.ServerError
  // Test: code "ECONNRESET" → S3ErrorType.NetworkError
  // Test: code "ECONNREFUSED" → S3ErrorType.NetworkError
  // Test: code "ETIMEDOUT" → S3ErrorType.NetworkError
  // Test: name "TimeoutError" → S3ErrorType.Timeout
  // Test: name "RequestTimeout" → S3ErrorType.Timeout
  // Test: plain string error → S3ErrorType.Unknown (no crash)
  // Test: unknown shape → S3ErrorType.Unknown
  // Test: message check takes priority over httpStatusCode
  //       (404 response whose message says "not implemented" → Unsupported, not NotFound)
});
```

---

## File 6: `web/__tests__/enrichment.test.ts`

Tests the enrichment module from section 05. Mock the Anthropic SDK:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@anthropic-ai/sdk");
```

Capture the `messages.create` call by mocking the SDK's `Anthropic` class. The mock should return a shaped response object that looks like a real API response: `{ content: [{ type: "text", text: "..." }], usage: { input_tokens: N, output_tokens: N }, model: "..." }`.

```typescript
describe("enrichImage — happy path", () => {
  // Test: returns parsed EnrichmentResult from clean JSON response
  //       response text: '{"description":"a beach","objects":["sand","water"],"context":"outdoor","suggested_tags":["beach"]}'
  // Test: strips markdown fences and parses multi-line JSON
  //       response text: '```json\n{"description":"beach","objects":[],"context":"","suggested_tags":[]}\n```'
  // Test: normalises "image/jpg" to "image/jpeg" before passing to API
  //       — assert the content_type in the API call is "image/jpeg"
  // Test: includes provider and model from the API response in the result
});

describe("response parsing edge cases", () => {
  // Test: parses ```json\n{ multi-line JSON }\n``` correctly
  //       (verify the bug fix: split("\n", 2)[1] was wrong; now full content between fences is used)
  // Test: handles response with ``` fences but no language tag
  // Test: handles missing "objects" field — result.objects defaults to []
  // Test: coerces "objects" as a string to a single-element array
  // Test: coerces "suggested_tags" as a string to a single-element array
  // Test: returns structured error (not throw) for completely unparseable response text
  //       — result should indicate failure without crashing
});

describe("pre-enrichment validation", () => {
  // Test: does not call the Anthropic API for an image larger than 20MB
  // Test: does not call the Anthropic API for an unsupported MIME type ("image/tiff")
  // Test: does not call the Anthropic API for a buffer with wrong magic bytes
  // Test: proceeds with API call for a valid JPEG image
  //       — verify messages.create is called exactly once
});

describe("Anthropic client reuse", () => {
  // Test: calling enrichImage twice returns results without creating a second Anthropic instance
  //       — mock Anthropic constructor with vi.fn(); assert it was called at most once
  // Test: the singleton client is constructed with maxRetries: 3
});

describe("batch enrichment", () => {
  // Test: processes multiple items, returns { total, succeeded, failed, skipped }
  // Test: continues processing when one item throws — other items are not skipped
  // Test: skips items with unsupported MIME types (count them in skipped)
  // Test: logs input_tokens and output_tokens from the API usage field
});
```

---

## File 7: `web/__tests__/db-operations.test.ts`

Tests the DB operations module from section 06. Full test list is defined in section 06's "Tests First" block — reproduce it here as the authoritative source.

Mock setup: use `vi.mock("@supabase/supabase-js")` and return a chainable mock builder. The chain must support `.from().upsert()`, `.from().insert()`, `.from().select().eq()`, `.rpc()` etc. Follow the same pattern used in `web/__tests__/whatsapp-route.test.ts` or `web/__tests__/s3-actions.test.ts`.

```typescript
describe("upsertWatchedKey — bug fix", () => {
  // Test: the options object passed to .upsert() includes onConflict: "s3_key,bucket_config_id"
  // Test: the options object does NOT include ignoreDuplicates: true
  // Test: the row data passed to .upsert() includes bucket_config_id
  // Test: the row data includes etag and size_bytes
  // Test: logs a message at info level when an existing key is updated
  // Test: accepts null for bucket_config_id without error
});

describe("queryEvents — N+1 fix", () => {
  // Test: with no search option, exactly ONE query is issued (verify mock call count)
  // Test: returned events have enrichment data attached inline (not fetched separately)
  // Test: with empty string search, returns empty results without calling the search_events RPC
  // Test: caps result_limit at 100 (even if caller passes 500)
  // Test: logs duration_ms after query
});

describe("Postgres error mapping", () => {
  // Test: Supabase error with code "23505" is mapped to a message containing "duplicate key"
  // Test: Supabase error with code "23503" is mapped to a message containing "FK violation"
  // Test: Supabase error with code "42501" is mapped to a message containing "RLS denied"
  // Test: error message includes the table name and operation
});

describe("insertEvent", () => {
  // Test: inserts row with all required fields present
  // Test: handles duplicate event ID gracefully (does not crash; returns or throws as documented)
});

describe("insertEnrichment", () => {
  // Test: inserts enrichment row with event_id foreign key
  // Test: throws a meaningful error when event_id does not exist (FK violation)
});

describe("getStats", () => {
  // Test: returns correct counts for a normal database state
  // Test: handles empty database (all counts are 0)
});

describe("getEnrichStatus", () => {
  // Test: returns correct pending count when some events lack enrichments
  // Test: returns pending = 0 when all events are enriched
  // Test: handles empty database
});
```

---

## Extending `web/__tests__/media-utils.test.ts`

Add the following tests to the end of the existing file. Do not remove or modify the existing tests.

```typescript
describe("detectContentType — edge cases", () => {
  // Test: returns "file" for an unknown extension ".xyz"
  // Test: returns "file" when the key has no extension ("DCIM/photo")
  // Test: returns "file" for empty string
});

describe("isMediaKey — edge cases", () => {
  // Test: returns true for "IMAGE.JPG" (uppercase extension)
  // Test: returns true for "photo.backup.jpg" (multiple dots)
  // Test: returns false for "notes.txt"
  // Test: returns false for a directory-like key "photos/" with no extension
});

describe("sha256Bytes", () => {
  // Test: returns a consistent hash for an empty buffer
  //       — call twice with Buffer.alloc(0), both results must be identical
  // Test: matches a known test vector
  //       — sha256("") = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  //       — Buffer.from("") → sha256Bytes → must match the known hex string
  // Test: different inputs produce different hashes
});

describe("newEventId (ULID monotonicity)", () => {
  // Test: two IDs generated in sequence are lexicographically ordered
  //       — id1 = newEventId(), id2 = newEventId(); expect id1 < id2
  // Test: generated IDs are 26 characters long
});

describe("humanSize", () => {
  // Test: returns "0 B" for 0
  // Test: returns "1023 B" for 1023
  // Test: returns "1.0 KB" for 1024
  // Test: returns "1.5 KB" for 1536
  // Test: returns "1.0 MB" for 1048576
  // Test: returns "1.0 GB" for 1073741824
});
```

Note: if `humanSize` is not yet exported from `web/lib/media/utils.ts`, add it to the exports. If it does not exist yet, skip those tests.

---

## Running the Tests

```bash
# Run all unit tests
cd web && npm test

# Verbose output (shows individual test names)
cd web && npx vitest run --reporter verbose

# Single file
cd web && npx vitest run __tests__/s3-client.test.ts

# Watch mode during development
cd web && npx vitest __tests__/retry.test.ts
```

All tests must pass with no real service dependencies. Everything is mocked. The `NEXT_PUBLIC_SUPABASE_URL` and related env vars are stubbed with fixture values in `beforeEach`.

---

## Acceptance Criteria

- All 7 new test files pass with `npm test`
- Extended `media-utils.test.ts` passes with no regressions
- All existing test files continue to pass
- No test file requires a running Supabase instance or S3 bucket
- No test file reads real credentials from environment variables — all use `vi.stubEnv()` with fixture values
- No real `setTimeout` delays in retry tests — all use injectable `delayFn`
- Test coverage: every public function in the following modules has at least one test:
  - `web/lib/logger.ts`
  - `web/lib/request-context.ts`
  - `web/lib/retry.ts`
  - `web/lib/media/validation.ts`
  - `web/lib/media/s3-errors.ts`
  - `web/lib/media/s3.ts` (via s3-client.test.ts)
  - `web/lib/media/enrichment.ts`
  - `web/lib/media/db.ts`
