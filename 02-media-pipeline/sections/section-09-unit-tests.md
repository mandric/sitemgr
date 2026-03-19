# Section 09: Unit Tests

## Overview

Consolidation of all unit test files for the media pipeline hardening. Each section (01-08) defined test stubs inline; this section organizes them into files and adds cross-cutting tests.

**Files to create:**
- `web/__tests__/s3-client.test.ts` — S3 library unit tests
- `web/__tests__/enrichment.test.ts` — Enrichment library unit tests
- `web/__tests__/db-operations.test.ts` — DB operations unit tests
- `web/__tests__/retry.test.ts` — Retry helper unit tests
- `web/__tests__/logger.test.ts` — Logger unit tests
- `web/__tests__/request-context.test.ts` — Request context tests
- `web/__tests__/validation.test.ts` — Validation unit tests

**Files to modify:**
- `web/__tests__/media-utils.test.ts` — Extend with additional edge case tests

**Dependencies:** Requires all of sections 01-08 to be implemented first.

---

## Testing Framework & Patterns

**Framework:** Vitest (already configured in `web/vitest.config.ts`)
**Run:** `npm test` from `web/` directory
**Mocking:** `vi.mock()` for module mocks, `vi.stubEnv()` for environment variables

**Existing patterns to follow** (from `helpers/agent-test-setup.ts`):
```typescript
// Module mocking
vi.mock("@/lib/media/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/media/db")>();
  return { ...actual, getAdminClient: () => ({ from: mockFrom }) };
});

// Environment setup
beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY_CURRENT", "test-fixture-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
```

---

## Test Files

### 1. `web/__tests__/logger.test.ts`

```typescript
// Test: createLogger returns logger with debug, info, warn, error methods
// Test: info() outputs valid JSON to stderr (capture via vi.spyOn(console, 'error'))
// Test: error() outputs valid JSON to stderr
// Test: all levels include timestamp, level, component, message fields
// Test: additional metadata fields { duration_ms: 42, key: "value" } are included in output
// Test: withRequestId() returns child logger that includes request_id in all entries
```

### 2. `web/__tests__/request-context.test.ts`

```typescript
// Test: runWithRequestId sets context accessible via getRequestId
// Test: getRequestId returns undefined when not in a request context
// Test: nested async calls can access the request ID (setTimeout, Promise.resolve)
// Test: concurrent contexts are isolated (parallel runWithRequestId calls don't leak)
```

### 3. `web/__tests__/retry.test.ts`

```typescript
// Test: withRetry succeeds on first try — fn called once, result returned
// Test: withRetry retries on failure — fn called maxRetries+1 times
// Test: withRetry stops when shouldRetry returns false — fn called fewer times
// Test: withRetry uses exponential backoff (verify via injectable delayFn capturing delays)
// Test: withRetry respects maxDelay cap — delay never exceeds maxDelay
// Test: withRetry throws original error after exhausting retries
// Test: onRetry callback fires with (attempt, error, delay) on each retry
```

**Important:** Use injectable `delayFn` to avoid real `setTimeout` in tests:
```typescript
const delays: number[] = [];
await withRetry(failingFn, {
  maxRetries: 3,
  delayFn: async (ms) => { delays.push(ms); },
});
expect(delays).toHaveLength(3);
expect(delays[1]).toBeGreaterThan(delays[0]); // exponential
```

### 4. `web/__tests__/validation.test.ts`

```typescript
// === Image Validation ===
// Test: validateImage accepts valid JPEG (correct magic bytes + mime)
// Test: validateImage accepts valid PNG
// Test: validateImage accepts valid GIF
// Test: validateImage accepts valid WebP
// Test: validateImage rejects file >20MB
// Test: validateImage rejects unsupported MIME type (image/tiff)
// Test: validateImage rejects mismatched magic bytes (JPEG header + .png mime)
// Test: validateImage rejects empty buffer
// Test: validateImage rejects buffer shorter than magic byte length
// Test: validateImage returns warning for >1568px dimensions

// === S3 Key Validation ===
// Test: validateS3Key accepts "photos/2024/image.jpg"
// Test: validateS3Key rejects key with null byte
// Test: validateS3Key rejects key >1024 bytes
// Test: validateS3Key rejects key with control characters
// Test: validateS3Key accepts key with spaces and unicode

// === Bucket Config Validation ===
// Test: validateBucketConfig accepts complete valid config
// Test: validateBucketConfig rejects empty bucket_name
// Test: validateBucketConfig rejects invalid endpoint_url
// Test: validateBucketConfig accepts config with optional fields omitted
// Test: validateBucketConfig rejects empty access_key_id
// Test: validateBucketConfig rejects empty secret_access_key
```

### 5. `web/__tests__/s3-client.test.ts`

Mock `@aws-sdk/client-s3` Send command.

```typescript
// === createS3Client ===
// Test: creates client with default region when none specified
// Test: creates client with custom endpoint and forcePathStyle
// Test: creates client with maxAttempts: 4 and adaptive retry mode

// === listS3Objects ===
// Test: lists objects from single page response
// Test: lists objects across multiple pages (ContinuationToken pagination)
// Test: falls back to ListObjects v1 when v2 returns "not implemented"
// Test: v1 fallback paginates with Marker token
// Test: returns empty array for empty bucket
// Test: stops after max page count (1000) to prevent infinite loop
// Test: normalizes ETags (strips quotes)
// Test: uses empty string for missing ETag
// Test: uses current timestamp for missing LastModified

// === downloadS3Object ===
// Test: downloads object as Buffer (happy path)
// Test: throws classified NotFound error on 404
// Test: throws classified AccessDenied error on 403

// === uploadS3Object ===
// Test: uploads with correct Content-Type
// Test: handles upload error

// === classifyS3Error ===
// Test: maps "not implemented" → Unsupported
// Test: maps 404 → NotFound
// Test: maps 403 → AccessDenied
// Test: maps 500 → ServerError
// Test: maps network error → NetworkError
// Test: maps unknown → Unknown
```

### 6. `web/__tests__/enrichment.test.ts`

Mock `@anthropic-ai/sdk`.

```typescript
// === enrichImage happy path ===
// Test: returns parsed EnrichmentResult from clean JSON response
// Test: strips markdown fences and parses multi-line JSON correctly
// Test: normalizes image/jpg to image/jpeg
// Test: includes provider and model in result

// === Response parsing ===
// Test: parses ```json\n{multi-line}\n``` fences
// Test: handles missing "objects" field — defaults to []
// Test: coerces "objects" string to array
// Test: coerces "suggested_tags" string to array
// Test: returns error for completely unparseable response

// === Pre-validation ===
// Test: skips enrichment for >20MB image without calling API
// Test: skips enrichment for unsupported MIME type without calling API
// Test: proceeds for valid image

// === Client reuse ===
// Test: getAnthropicClient returns same instance
// Test: client configured with maxRetries: 3

// === Batch enrichment ===
// Test: batchEnrich processes items with p-limit concurrency
// Test: continues when one item fails
// Test: returns { succeeded, failed, skipped } counts
```

### 7. `web/__tests__/db-operations.test.ts`

Mock Supabase client.

```typescript
// === upsertWatchedKey ===
// Test: uses composite conflict key (s3_key, bucket_config_id)
// Test: updates etag on conflict (not ignoreDuplicates)
// Test: accepts bucket_config_id parameter

// === queryEvents ===
// Test: returns events with enrichments in single query (not N+1)
// Test: returns empty array for no matches
// Test: caps result_limit at 100

// === Error wrapping ===
// Test: maps Postgres 23505 → "duplicate key"
// Test: maps Postgres 23503 → "FK violation"
// Test: maps Postgres 42501 → "RLS denied"

// === insertEvent ===
// Test: inserts with all required fields
// Test: handles duplicate event ID

// === insertEnrichment ===
// Test: inserts enrichment linked to event
// Test: handles FK violation

// === getStats / getEnrichStatus ===
// Test: returns correct counts
// Test: handles empty database
// Test: handles all enriched (pending = 0)
```

### 8. Extend `web/__tests__/media-utils.test.ts`

Add to existing file:

```typescript
// Test: detectContentType returns "file" for unknown extension
// Test: detectContentType returns "file" for no extension
// Test: detectContentType returns "file" for empty string
// Test: isMediaKey handles case sensitivity (e.g., .JPG)
// Test: isMediaKey handles paths with multiple dots (photo.backup.jpg)
// Test: sha256Bytes returns consistent hash for empty buffer
// Test: sha256Bytes matches known test vector
// Test: newEventId returns monotonically increasing ULIDs
// Test: humanSize returns "0 B" for 0
// Test: humanSize returns "1023 B" for 1023
// Test: humanSize returns "1.0 KB" for 1024
// Test: humanSize returns "1.0 MB" for 1048576
```

---

## Running Tests

```bash
cd web && npm test                    # Run all unit tests
cd web && npx vitest run --reporter verbose  # Verbose output
cd web && npx vitest run __tests__/s3-client.test.ts  # Single file
```

All tests should pass with no real service dependencies — everything is mocked.
