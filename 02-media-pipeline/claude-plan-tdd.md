# TDD Plan: Media Pipeline Hardening

This document mirrors `claude-plan.md` and defines what tests to write BEFORE implementing each section. Tests use Vitest with `vi.mock()` and `vi.stubEnv()` following existing project patterns.

---

## 2. Structured Logger

**File:** `web/__tests__/logger.test.ts`

```typescript
// Test: createLogger returns logger with all level methods (debug, info, warn, error)
// Test: info() outputs valid JSON to stderr (not stdout)
// Test: error() outputs valid JSON to stderr
// Test: all levels include timestamp, level, component, message fields
// Test: additional metadata fields are included in output
// Test: debug level output can be suppressed via config
// Test: withRequestId() returns child logger that includes request_id in all entries
```

**File:** `web/__tests__/request-context.test.ts`

```typescript
// Test: runWithRequestId sets context accessible via getRequestId
// Test: getRequestId returns undefined when not in a request context
// Test: nested async calls can access the request ID
// Test: concurrent contexts are isolated (two parallel runWithRequestId calls)
// Test: logger automatically includes request ID when in context
```

---

## 3. Retry & SDK Configuration

**File:** `web/__tests__/retry.test.ts`

```typescript
// Test: withRetry succeeds on first try (no retry needed)
// Test: withRetry retries on failure up to maxRetries
// Test: withRetry stops retrying when shouldRetry returns false
// Test: withRetry uses exponential backoff (verify via injectable delayFn)
// Test: withRetry respects maxDelay cap
// Test: withRetry throws original error after exhausting retries
// Test: onRetry callback fires with (attempt, error, delay) args
// Test: default shouldRetry returns false for non-retryable errors
```

**For SDK retry config (no dedicated test file — verified in S3 and enrichment tests):**

```typescript
// Test: S3 client is created with maxAttempts: 4 and retryMode: "adaptive"
// Test: Anthropic client singleton is reused across enrichImage calls
// Test: Anthropic client is created with maxRetries: 3
```

---

## 4. Input Validation

**File:** `web/__tests__/validation.test.ts`

```typescript
// === Image Validation ===
// Test: validateImage accepts valid JPEG (correct magic bytes + mime type)
// Test: validateImage accepts valid PNG
// Test: validateImage accepts valid GIF
// Test: validateImage accepts valid WebP
// Test: validateImage rejects file >20MB
// Test: validateImage rejects unsupported MIME type (e.g., image/tiff)
// Test: validateImage rejects file with wrong magic bytes (e.g., JPEG header but .png extension)
// Test: validateImage rejects empty buffer
// Test: validateImage rejects buffer shorter than magic byte length
// Test: validateImage returns warning for oversized dimensions (>1568px)

// === S3 Key Validation ===
// Test: validateS3Key accepts normal key "photos/2024/image.jpg"
// Test: validateS3Key rejects key with null byte
// Test: validateS3Key rejects key longer than 1024 bytes
// Test: validateS3Key rejects key with control characters
// Test: validateS3Key accepts key with spaces and unicode

// === Bucket Config Validation ===
// Test: validateBucketConfig accepts valid complete config
// Test: validateBucketConfig rejects empty bucket_name
// Test: validateBucketConfig rejects invalid endpoint_url
// Test: validateBucketConfig accepts config with optional fields omitted
// Test: validateBucketConfig rejects empty access_key_id
// Test: validateBucketConfig rejects empty secret_access_key
```

---

## 5. S3 Client Hardening

**File:** `web/__tests__/s3-client.test.ts`

```typescript
// === createS3Client ===
// Test: creates client with default region when none specified
// Test: creates client with custom endpoint and forcePathStyle
// Test: creates client with retry config (maxAttempts: 4, adaptive mode)
// Test: creates client with timeout configuration

// === listS3Objects ===
// Test: lists objects from single page response
// Test: lists objects across multiple pages (pagination with ContinuationToken)
// Test: falls back to ListObjects v1 when v2 returns "not implemented" error
// Test: falls back to ListObjects v1 on "unsupported" error
// Test: v1 fallback paginates with Marker token
// Test: returns empty array for empty bucket
// Test: stops pagination after max page count (1000) to prevent infinite loop
// Test: handles truncated response with IsTruncated=true but no token
// Test: normalizes ETags (strips quotes)
// Test: uses empty string for missing ETag
// Test: uses current timestamp for missing LastModified

// === downloadS3Object ===
// Test: downloads object as Buffer
// Test: throws classified error on 404 (NotFound)
// Test: throws classified error on 403 (AccessDenied)

// === uploadS3Object ===
// Test: uploads object with correct Content-Type
// Test: handles upload error

// === classifyS3Error ===
// Test: classifies "not implemented" as Unsupported
// Test: classifies "unsupported" as Unsupported
// Test: classifies 404 error as NotFound
// Test: classifies 403 error as AccessDenied
// Test: classifies 500 error as ServerError
// Test: classifies 503 error as ServerError
// Test: classifies network error as NetworkError
// Test: classifies timeout error as Timeout
// Test: classifies unknown error as Unknown
```

---

## 6. Enrichment Hardening

**File:** `web/__tests__/enrichment.test.ts`

```typescript
// === enrichImage happy path ===
// Test: returns parsed EnrichmentResult from clean JSON response
// Test: strips markdown fences and parses multi-line JSON correctly
// Test: normalizes image/jpg to image/jpeg
// Test: includes provider and model in result

// === Response parsing edge cases ===
// Test: handles response with ```json ... ``` fences (multi-line)
// Test: handles response with ``` ... ``` fences (no language tag)
// Test: handles missing "objects" field (defaults to empty array)
// Test: handles "objects" as string instead of array (coerces to array)
// Test: handles "suggested_tags" as string instead of array
// Test: handles empty arrays for objects and suggested_tags
// Test: returns structured error for completely unparseable response

// === Pre-enrichment validation ===
// Test: skips enrichment for oversized image (>20MB) without calling API
// Test: skips enrichment for unsupported MIME type without calling API
// Test: skips enrichment for corrupt image (bad magic bytes) without calling API
// Test: proceeds with enrichment for valid image

// === Client reuse ===
// Test: getAnthropicClient returns same instance on repeated calls
// Test: client is configured with maxRetries: 3

// === Batch enrichment ===
// Test: processes multiple images with p-limit concurrency
// Test: continues processing when one image fails
// Test: returns batch result with succeeded/failed/skipped counts
// Test: logs token usage from API response
```

---

## 7. Database Operations Hardening

**File:** `web/__tests__/db-operations.test.ts`

```typescript
// === upsertWatchedKey bug fix ===
// Test: upsert uses composite conflict key (s3_key, bucket_config_id)
// Test: upsert updates etag and size_bytes on conflict (not ignoreDuplicates)
// Test: upsert accepts bucket_config_id parameter
// Test: logs when existing key is updated

// === N+1 fix for queryEvents ===
// Test: queryEvents returns events with enrichments in single query (not N+1)
// Test: queryEvents returns empty array for no matches

// === Error wrapping ===
// Test: maps Postgres 23505 to "duplicate key" error
// Test: maps Postgres 23503 to "FK violation" error
// Test: maps Postgres 42501 to "RLS denied" error
// Test: includes table name and operation in error message

// === Search robustness ===
// Test: queryEvents with empty query text returns empty results
// Test: queryEvents caps result_limit at 100
// Test: queryEvents logs search duration_ms

// === insertEvent ===
// Test: inserts event with all required fields
// Test: handles duplicate event ID gracefully

// === insertEnrichment ===
// Test: inserts enrichment linked to event
// Test: handles FK violation (nonexistent event_id)

// === getStats ===
// Test: returns correct counts for normal state
// Test: handles empty database

// === getEnrichStatus ===
// Test: returns correct pending count
// Test: handles all enriched (pending = 0)
// Test: handles none enriched
```

---

## 8. Agent Action Hardening

**Extend:** `web/__tests__/agent-core.test.ts` (existing file)

```typescript
// === Request context ===
// Test: agent actions wrap execution in runWithRequestId
// Test: request ID appears in log output during action execution

// === Error standardization ===
// Test: error responses include errorType field
// Test: error responses include error message
// Test: success responses include success: true and timing info

// === indexBucket improvements ===
// Test: indexBucket uses p-limit for concurrent enrichment
// Test: indexBucket continues on individual enrichment failure
// Test: indexBucket returns per-object status in result
```

---

## 9. CLI Hardening

**No dedicated test file** — CLI changes are thin wrappers around tested library functions. Key behaviors to verify manually:

```
// Verify: --verbose flag shows technical error details
// Verify: exit codes (0=success, 1=user error, 2=service error)
// Verify: watch --interval and --max-errors flags work
// Verify: enrich --concurrency and --dry-run flags work
// Verify: progress output goes to stderr, results to stdout
```

---

## 10. Unit Tests (Section 10 of plan)

The unit tests ARE the TDD stubs above. Section 10 of the plan describes the same test files. Each section's tests should be written BEFORE implementing that section.

---

## 11. Integration Tests

**File:** `web/__tests__/integration/media-db.test.ts`

```typescript
// Test: insert event → search by text → verify found
// Test: insert event + enrichment → FTS search by description → verify result
// Test: weighted search: description match ranks higher than tag match
// Test: filter by content_type + date range + search text
// Test: RLS isolation: user A cannot see user B's events
// Test: stats RPC returns correct counts matching actual data
// Test: upsert watched key → re-upsert with new ETag → verify updated
```

**File:** `web/__tests__/integration/media-s3.test.ts`

```typescript
// Test: create bucket → upload object → list → verify in listing
// Test: upload multiple objects → paginated listing returns all
// Test: download uploaded object → content matches original
// Test: list empty bucket → returns empty array
```

**File:** `web/__tests__/integration/media-pipeline.test.ts`

```typescript
// Test: upload image to Storage → S3 client lists it → create event → verify in DB
// Test: full pipeline with mocked enrichment → verify event + enrichment in DB → search finds it
```
