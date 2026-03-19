# Section 04: S3 Client Hardening

**Depends on:** section-01 (logger), section-02 (retry/SDK config), section-03 (validation)
**Blocks:** section-07 (agent hardening), section-08 (CLI hardening)
**Can be implemented as an independent PR after sections 01–03 are merged**

---

## Overview

This section hardens the existing S3 client in `web/lib/media/s3.ts` by adding structured error classification, SDK-level retry and timeout configuration, and pagination robustness (max page guard, edge-case handling). It also creates a new `web/lib/media/s3-errors.ts` file with an error classification enum.

This is not a feature addition. The current code works on the happy path but has gaps: error handling uses fragile string matching, pagination has no runaway guard, and the client has no timeout or retry configuration.

---

## Dependencies

Before starting this section, verify:

- **Section 01 (Logger):** `web/lib/logger.ts` exports `createLogger` and `LogComponent`. The `console.error("Note: list_objects_v2 not supported...")` call in the current `listS3Objects` will be replaced with a structured log call.
- **Section 02 (Retry/SDK):** The `p-limit` package is installed in `web/`. The AWS SDK retry approach is established: configure retry on the `S3Client` constructor, not by wrapping individual calls.
- **Section 03 (Validation):** `web/lib/media/validation.ts` exports `validateS3Key`. It is called in `downloadS3Object` before issuing the S3 request.

---

## Files to Create

- `web/lib/media/s3-errors.ts` — S3 error classification enum and classifier function (new file)

## Files to Modify

- `web/lib/media/s3.ts` — SDK retry config, timeout config, pagination robustness, structured logging, use `classifyS3Error`

---

## Tests First

**New file:** `web/__tests__/s3-client.test.ts`

Write all tests before touching any implementation. Use `vi.mock("@aws-sdk/client-s3")` to intercept SDK calls. Use `vi.stubEnv()` in `beforeEach` for any environment variables. Every test should fail with "not implemented" or "not found" errors before the implementation is written.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@aws-sdk/client-s3"); // intercept S3Client and Command constructors
vi.mock("@smithy/node-http-handler"); // intercept NodeHttpHandler

describe("createS3Client", () => {
  // Test: creates client with default region "us-east-1" when no region is specified
  // Test: creates client with custom endpoint when endpoint is provided
  // Test: sets forcePathStyle: true when an endpoint is provided
  // Test: sets forcePathStyle: false when no endpoint is provided
  // Test: passes credentials when accessKeyId and secretAccessKey are both provided
  // Test: omits credentials block when either key is missing
  // Test: sets maxAttempts: 4 in the S3Client options
  // Test: sets retryMode: "adaptive" in the S3Client options
  // Test: passes NodeHttpHandler with connectionTimeout: 5000 and socketTimeout: 30000
});

describe("listS3Objects", () => {
  // === Happy path ===
  // Test: returns correct S3Object array from single-page response (IsTruncated: false)
  // Test: collects objects across multiple v2 pages using ContinuationToken
  // Test: returns empty array when bucket is empty (Contents: undefined)
  // Test: returns empty array when bucket is empty (Contents: [])

  // === ETag and LastModified normalization ===
  // Test: strips surrounding quotes from ETag (e.g., '"abc123"' becomes 'abc123')
  // Test: uses empty string for ETag when obj.ETag is undefined
  // Test: uses obj.LastModified as ISO string when present
  // Test: falls back to current timestamp (not empty string) when LastModified is missing
  // Test: logs a warning when LastModified fallback is used

  // === v1 fallback ===
  // Test: falls back to ListObjects v1 when v2 throws an error whose message includes "not implemented"
  // Test: falls back to ListObjects v1 when v2 throws an error whose message includes "unsupported"
  // Test: does NOT fall back (rethrows) when v2 throws an unrelated error
  // Test: v1 fallback collects objects from a single-page response
  // Test: v1 fallback paginates correctly using Marker token across multiple pages
  // Test: v1 fallback uses last object key as Marker when NextMarker is absent

  // === Pagination guard ===
  // Test: throws after 1000 pages in v2 pagination (max page guard)
  // Test: throws after 1000 pages in v1 fallback pagination (max page guard)
  // Test: error message for max page guard includes bucket name and page count

  // === IsTruncated edge case ===
  // Test: treats response as last page when IsTruncated is true but NextContinuationToken is absent
  // Test: logs a warning when IsTruncated is true but no NextContinuationToken is present
});

describe("downloadS3Object", () => {
  // Test: downloads object and returns a Buffer with the correct bytes
  // Test: calls validateS3Key before sending the request
  // Test: throws an error with S3ErrorType.NotFound when the S3 response is a 404
  // Test: throws an error with S3ErrorType.AccessDenied when the S3 response is a 403
  // Test: attaches s3ErrorType property to the thrown error
  // Test: logs the error type and key before rethrowing
});

describe("uploadS3Object", () => {
  // Test: sends PutObjectCommand with the correct Bucket, Key, Body, and ContentType
  // Test: omits ContentType header when contentType argument is not provided
  // Test: propagates the error when the upload command fails
});

describe("classifyS3Error", () => {
  // Test: classifies error whose message contains "not implemented" as S3ErrorType.Unsupported
  // Test: classifies error whose message contains "unsupported" (case-insensitive) as Unsupported
  // Test: classifies error with $metadata.httpStatusCode 404 as S3ErrorType.NotFound
  // Test: classifies error with $metadata.httpStatusCode 403 as S3ErrorType.AccessDenied
  // Test: classifies error with $metadata.httpStatusCode 401 as S3ErrorType.AccessDenied
  // Test: classifies error with $metadata.httpStatusCode 500 as S3ErrorType.ServerError
  // Test: classifies error with $metadata.httpStatusCode 503 as S3ErrorType.ServerError
  // Test: classifies error with code "ECONNRESET" as S3ErrorType.NetworkError
  // Test: classifies error with code "ECONNREFUSED" as S3ErrorType.NetworkError
  // Test: classifies error with code "ETIMEDOUT" as S3ErrorType.NetworkError
  // Test: classifies error with name "TimeoutError" as S3ErrorType.Timeout
  // Test: classifies error with name "RequestTimeout" as S3ErrorType.Timeout
  // Test: classifies any other error shape as S3ErrorType.Unknown
  // Test: classifies a plain string error as S3ErrorType.Unknown (not a crash)
  // Test: message check takes priority over httpStatusCode
  //       (e.g., a 404 whose message says "not implemented" → Unsupported, not NotFound)
});
```

Run the tests with `npm test` from `web/`. All tests must fail before implementation is written.

---

## Implementation

### 1. Create `web/lib/media/s3-errors.ts`

This new file is the structured replacement for the fragile string-matching pattern currently in `listS3Objects`. Define the enum and a single classifier function.

```typescript
export enum S3ErrorType {
  NotFound,
  AccessDenied,
  Unsupported,   // v2 API not supported — triggers v1 fallback
  NetworkError,
  Timeout,
  ServerError,   // HTTP 500, 503
  Unknown,
}

export function classifyS3Error(error: unknown): S3ErrorType
```

The classifier inspects the error in this priority order:

1. Coerce to string and check lowercased message for `"not implemented"` or `"unsupported"` → `Unsupported`. This check comes first because some S3-compatible providers (Supabase Storage, MinIO) return a 404 or 501 with these phrases for ListObjectsV2 when they only support v1. Without this priority, the 404 check below would fire and the fallback would never trigger.

2. Check `(error as any).$metadata?.httpStatusCode`:
   - `403` or `401` → `AccessDenied`
   - `404` → `NotFound`
   - `500` or `503` → `ServerError`

3. Check `(error as any).code` against network error codes: `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND` → `NetworkError`

4. Check `(error as any).name` for timeout patterns: `TimeoutError`, `RequestTimeout` → `Timeout`

5. Anything else → `Unknown`

No imports from other project files. No external dependencies.

### 2. Modify `web/lib/media/s3.ts`

#### 2a. Add module-level logger

At the top of the file, after existing imports, create a logger:

```typescript
import { createLogger, LogComponent } from "@/lib/logger";
const logger = createLogger(LogComponent.S3);
```

#### 2b. Add SDK retry and timeout to `createS3Client`

Import `NodeHttpHandler` — it is bundled as a transitive dependency of `@aws-sdk/client-s3`, no additional install is needed:

```typescript
import { NodeHttpHandler } from "@smithy/node-http-handler";
```

Extend the `S3Client` constructor with retry and timeout options. The existing endpoint, region, credentials, and `forcePathStyle` logic is unchanged — add these fields alongside them:

```typescript
maxAttempts: 4,
retryMode: "adaptive",
requestHandler: new NodeHttpHandler({
  connectionTimeout: 5000,   // ms to establish TCP connection
  socketTimeout: 30000,      // ms to wait for response data after connect
}),
```

`retryMode: "adaptive"` tracks server capacity signals and avoids thundering herds during throttling. It is strictly better than `"standard"` for Supabase Storage. Do not add a custom retry wrapper around any S3 call — that would cause double-retrying because the SDK already retries internally.

If `@smithy/node-http-handler` does not resolve at runtime, install it explicitly: `npm install @smithy/node-http-handler` in `web/`. Check whether it resolves before assuming it is available.

#### 2c. Replace string-matching in `listS3Objects` with `classifyS3Error`

Import the new classifier:

```typescript
import { classifyS3Error, S3ErrorType } from "./s3-errors";
```

The current catch block inside the v2 `try`:

```typescript
const msg = String(err).toLowerCase();
const isUnsupported =
  msg.includes("not implemented") ||
  msg.includes("unsupported") ||
  msg.includes("404") ||
  msg.includes("not found");

if (!isUnsupported) throw err;
console.error("  Note: list_objects_v2 not supported, using v1 fallback");
```

Replace with:

```typescript
const errorType = classifyS3Error(err);
if (errorType !== S3ErrorType.Unsupported) throw err;
logger.info("list_objects_v2 not supported, falling back to v1", { bucket });
```

Note that the current string match also includes `"404"` and `"not found"`. The new `classifyS3Error` handles this correctly: message-string check takes priority, so a "not implemented" 404 is still classified as `Unsupported` rather than `NotFound`. The `"not found"` string check is dropped because it was too broad and would incorrectly trigger the fallback on legitimate object-not-found errors from other operations.

#### 2d. Add max page guard to both pagination loops

Both the v2 loop and the v1 fallback loop are unbounded `do...while` loops. If a server returns `IsTruncated: true` perpetually (or returns a bad token that maps to an earlier page), the loop runs forever. Add a page counter to each:

```typescript
const MAX_PAGES = 1000;
let pageCount = 0;

// At the top of each loop body:
pageCount++;
if (pageCount > MAX_PAGES) {
  throw new Error(
    `S3 pagination exceeded ${MAX_PAGES} pages for bucket "${bucket}" — possible infinite loop`
  );
}
```

Apply this pattern to both the v2 loop (before v1 fallback) and to the v1 fallback loop independently, with separate `pageCount` variables. Each loop has its own counter starting from 0.

#### 2e. Handle the IsTruncated-but-no-token edge case

In the v2 loop the current assignment is:

```typescript
continuationToken = response.IsTruncated
  ? response.NextContinuationToken
  : undefined;
```

If `IsTruncated` is `true` but `NextContinuationToken` is absent, this sets `continuationToken = undefined` and exits the loop — which is the correct behavior. Make it explicit and observable:

```typescript
if (response.IsTruncated && !response.NextContinuationToken) {
  logger.warn("S3 response IsTruncated but no NextContinuationToken — treating as last page", {
    bucket,
    page: pageCount,
    objects_so_far: objects.length,
  });
}
continuationToken =
  response.IsTruncated && response.NextContinuationToken
    ? response.NextContinuationToken
    : undefined;
```

#### 2f. Fix missing LastModified fallback

The current code uses `obj.LastModified?.toISOString() ?? ""` — an empty string is a worse fallback than a real timestamp for downstream date filtering. Change to use the current time, and log a warning so missing timestamps are observable:

```typescript
if (!obj.LastModified) {
  logger.warn("S3 object has no LastModified, using current timestamp", {
    bucket,
    key: obj.Key,
  });
}
lastModified: obj.LastModified?.toISOString() ?? new Date().toISOString(),
```

The ETag empty-string fallback (`(obj.ETag ?? "").replace(/"/g, "")`) is correct as-is — keep it unchanged.

#### 2g. Add completion log to `listS3Objects`

After all pages are consumed (just before the final `return objects`), log a summary:

```typescript
logger.info("s3 listing complete", {
  bucket,
  prefix: prefix || undefined,
  total_objects: objects.length,
  pages: pageCount,
});
```

#### 2h. Classify and attach error type in `downloadS3Object`

Wrap the existing download body in a try/catch. On error, classify the error, attach the `s3ErrorType` property to it, log it, and rethrow. Do not change the function signature — callers still receive a thrown error:

```typescript
export async function downloadS3Object(
  client: S3Client,
  bucket: string,
  key: string
): Promise<Buffer>
```

Before issuing the S3 request, call `validateS3Key(key)` (imported from `./validation`). If the key is invalid, throw immediately with the validation errors — no S3 request should be made for an invalid key.

In the catch block:

```typescript
const s3ErrorType = classifyS3Error(err);
(err as any).s3ErrorType = s3ErrorType;
logger.error("s3 download failed", {
  bucket,
  key,
  s3ErrorType: S3ErrorType[s3ErrorType],
  error: String(err),
});
throw err;
```

---

## Summary of Changes

| What | Where | Why |
|------|-------|-----|
| New `S3ErrorType` enum + `classifyS3Error()` | `web/lib/media/s3-errors.ts` | Replaces brittle string matching; makes error classification testable |
| `maxAttempts: 4, retryMode: "adaptive"` | `createS3Client` in `s3.ts` | SDK handles retries internally; no custom wrapper needed |
| `NodeHttpHandler` with timeouts | `createS3Client` in `s3.ts` | Prevents hanging connections on slow or unresponsive endpoints |
| Max page guard (1000 pages) in v2 and v1 loops | `listS3Objects` in `s3.ts` | Prevents infinite pagination on broken server responses |
| IsTruncated-but-no-token warning and explicit handling | `listS3Objects` v2 loop | Observable behavior for malformed server responses |
| Current timestamp fallback for missing LastModified | `listS3Objects` | Avoids empty string dates breaking downstream date filters |
| Structured logging throughout | `s3.ts` | Replaces bare `console.error`; includes bucket, key, page count context |
| `validateS3Key` pre-flight in `downloadS3Object` | `s3.ts` | Prevents invalid keys from reaching the network |
| `s3ErrorType` attached to thrown errors | `downloadS3Object` | Lets callers discriminate on error type without string matching |

---

## Acceptance Criteria

- `web/__tests__/s3-client.test.ts` passes with `npm test`
- `web/lib/media/s3-errors.ts` exports `S3ErrorType` (enum) and `classifyS3Error` (function)
- `web/lib/media/s3.ts` no longer contains any `msg.includes(...)` string-matching for error classification
- `createS3Client` passes `maxAttempts: 4` and `retryMode: "adaptive"` to `S3Client`
- `createS3Client` uses `NodeHttpHandler` with `connectionTimeout: 5000` and `socketTimeout: 30000`
- `listS3Objects` has a max page guard that throws after 1000 pages
- No `withRetry()` wrapper is used around any S3 call
- All new log output uses `createLogger("s3")`, not `console.log` or `console.error`
- The existing `web/__tests__/s3-actions.test.ts` continues to pass without modification (it mocks `listS3Objects` and `downloadS3Object` entirely, so internal changes are invisible to it)

---

## Notes

Do not add `withRetry()` from `web/lib/retry.ts` around S3 calls. Section 02 explains why: the AWS SDK v3 already retries internally via `maxAttempts` and `retryMode`. Adding a wrapper causes double-retrying.

The `p-limit` package is not used in this section. It is used in section 05 (batch enrichment) and section 07 (batch indexing in the agent action).

If the import `import { NodeHttpHandler } from "@smithy/node-http-handler"` fails to resolve, run `npm install @smithy/node-http-handler` in `web/`. The package is a declared transitive dependency of `@aws-sdk/client-s3` but TypeScript may not resolve it without an explicit install depending on the package manager configuration.
