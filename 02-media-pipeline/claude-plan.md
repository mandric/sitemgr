# Implementation Plan: Media Pipeline Hardening

## 1. Overview

This plan hardens the existing sitemgr media pipeline — S3 bucket watching, Claude Vision enrichment, full-text search indexing — for medium-scale production use (a few users, thousands of photos, regular automated syncing). The pipeline code is fully functional but lacks comprehensive test coverage, robust error handling, and observability.

**What we're building:** Not new features — rather, a hardened, well-tested, observable version of the existing pipeline. Every function gets tested, every error path gets handled, and every operation gets logged.

**Why:** The current code works on the happy path but has gaps: minimal input validation, console.log-based logging with no structure, test coverage focused on agent actions rather than the underlying media library, and several existing bugs (upsert conflict handling, N+1 queries, JSON parsing).

**Scope:** Full pipeline end-to-end:
- `web/lib/media/` — S3 client, enrichment, DB operations, utilities
- `web/lib/agent/core.ts` — Action handlers that invoke media library
- `web/bin/smgr.ts` — CLI commands
- `web/app/api/` — API routes
- Supporting code in `web/lib/crypto/` as needed

**Constraints:**
- Prototype mode — all APIs open to change
- Local development only — no CI pipeline changes
- Vitest + Playwright test framework (existing)
- Supabase + AWS SDK v3 infrastructure (existing)

### 1.1 Known Risks

- **Scope**: 14 new files, 9 modified files. Each section should be implementable as an independent PR to reduce regression risk.
- **SDK retry overlap**: AWS SDK v3 and Anthropic SDK both have built-in retry. We leverage these rather than building custom retry wrappers (see section 3).
- **Non-image media in pipeline**: The `indexBucket` function silently skips enrichment for non-image media but still creates events. This is intentional — confirmed as current design.

---

## 2. Structured Logger

### 2.1 Why First

Every subsequent section needs structured logging. Building the logger first means all hardening work immediately uses it.

### 2.2 Design

Create `web/lib/logger.ts` — a lightweight structured logger that wraps console methods.

**Interface:**
```typescript
interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  component: string;
  message: string;
  request_id?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

function createLogger(component: string): Logger
```

**Logger methods:** `debug()`, `info()`, `warn()`, `error()` — each accepts a message string and optional metadata object.

**CRITICAL: All log output goes to stderr.** This prevents mixing structured logs with CLI command output on stdout, preserving CLI piping (e.g., `smgr stats | jq .total_events`).

**No external dependencies.** Thin wrapper over `console.error` with JSON formatting.

### 2.3 Request Context via AsyncLocalStorage

Create `web/lib/request-context.ts` using Node's built-in `AsyncLocalStorage`:

```typescript
function runWithRequestId<T>(requestId: string, fn: () => T): T
function getRequestId(): string | undefined
```

The logger automatically reads `getRequestId()` and includes it in all log entries. No function signature changes needed anywhere — the request ID propagates through the async call chain automatically.

Entry points that create request context:
- CLI command start
- API route handler
- Agent action dispatch

### 2.4 Component Names

Standard components: `s3`, `enrichment`, `db`, `agent`, `cli`, `api`, `crypto`.

### 2.5 Migration Strategy

**Important distinction:**
- **User-facing output** (CLI tables, JSON results, progress): Keep as `console.log` or a separate `output()` helper. These go to stdout.
- **Operational logging** (debug, metrics, errors, warnings): Replace with structured logger. These go to stderr.

This is NOT a blind find-and-replace. Each `console.log` call must be categorized.

---

## 3. Retry & SDK Configuration

### 3.1 SDK Retry Leverage (NOT Custom Retry)

**Critical insight from review:** Both AWS SDK v3 (`@aws-sdk/middleware-retry`) and Anthropic SDK (`@anthropic-ai/sdk`) have built-in retry with exponential backoff. Building custom `withRetry()` wrappers around these would cause double-retrying.

**Approach:**
- **S3 operations**: Configure AWS SDK v3 retry via `S3Client` constructor: `{ maxAttempts: 4, retryMode: "adaptive" }`. This handles 500, 503, network errors, and throttling automatically.
- **Claude API**: Configure Anthropic SDK retry via client constructor: `{ maxRetries: 3 }`. This handles 429, 529, and 500 automatically, including `retry-after` header parsing.
- **Supabase operations**: These DON'T have built-in retry. Create a lightweight `withRetry()` helper ONLY for Supabase calls.

### 3.2 Supabase Retry Helper

Create `web/lib/retry.ts` — used ONLY for Supabase database operations (not S3 or Claude API).

```typescript
interface RetryConfig {
  maxRetries: number;       // default: 2
  baseDelay: number;        // default: 500ms
  maxDelay: number;         // default: 5000ms
  shouldRetry: (error: unknown) => boolean;
  delayFn?: (ms: number) => Promise<void>;  // Injectable for testing
}

async function withRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>
): Promise<T>
```

Retry on: connection errors, timeouts. Don't retry on: constraint violations, RLS denials, authentication errors.

### 3.3 Anthropic Client Reuse

**Bug fix:** Currently `enrichImage()` creates a new `Anthropic()` client on every call, losing SDK rate-limiting state. Create a module-level singleton:

```typescript
// web/lib/media/enrichment.ts
let _client: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ maxRetries: 3 });
  }
  return _client;
}
```

### 3.4 Concurrency for Batch Operations

Use `p-limit` package (4KB, zero dependencies) instead of a custom semaphore:
- Batch enrichment: concurrency of 3
- Batch S3 listing: concurrency of 5

---

## 4. Input Validation

### 4.1 Image Validation

Create `web/lib/media/validation.ts` — validates images before sending to Claude API.

**Validation checks:**
1. **File size**: Reject if >20MB (Claude API limit)
2. **MIME type**: Validate against supported formats (image/jpeg, image/png, image/gif, image/webp)
3. **Magic bytes**: Read first 8 bytes to verify file header matches expected format (detect corrupt/misnamed files)
4. **Dimensions warning**: If image metadata available and >1568px on longest side, log info (informational, not blocking)

```typescript
interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function validateImage(buffer: Buffer, mimeType: string): ValidationResult
```

**Magic byte checks:**
- JPEG: starts with `FF D8 FF`
- PNG: starts with `89 50 4E 47`
- GIF: starts with `47 49 46 38`
- WebP: starts with `52 49 46 46` ... `57 45 42 50`

### 4.2 S3 Key Validation

```typescript
function validateS3Key(key: string): ValidationResult
```

Checks: no null bytes, length <1024, no control characters.

### 4.3 Configuration Validation

```typescript
function validateBucketConfig(config: BucketConfig): ValidationResult
```

Checks: bucket_name non-empty, endpoint_url is valid URL (if provided), region is non-empty string (if provided), access_key_id and secret_access_key are non-empty.

---

## 5. S3 Client Hardening

### 5.1 SDK Retry Configuration

Configure retry in `createS3Client()` instead of wrapping calls:
```typescript
new S3Client({
  maxAttempts: 4,
  retryMode: "adaptive",  // Handles throttling automatically
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    socketTimeout: 30000,
  }),
})
```

### 5.2 Error Classification

Create `web/lib/media/s3-errors.ts` — replace string matching with structured error classification:

```typescript
enum S3ErrorType {
  NotFound,
  AccessDenied,
  Unsupported,    // v2 API not supported (triggers v1 fallback)
  NetworkError,
  Timeout,
  ServerError,    // 500, 503
  Unknown,
}

function classifyS3Error(error: unknown): S3ErrorType
```

Replaces current `msg.includes("not implemented")` pattern.

### 5.3 Pagination Robustness

- Max page count guard (1000 pages) to prevent infinite loops
- Logging of page count and total objects listed
- Handle truncated responses where `IsTruncated` is true but no continuation token

### 5.4 Empty/Edge Cases

- Empty bucket: Return empty array (not error)
- Zero-byte objects: Include in listing but flag in metadata
- Keys with special characters: Ensure proper encoding/decoding
- Missing ETag: Use empty string (not undefined)
- Missing LastModified: Use current timestamp as fallback

---

## 6. Enrichment Hardening

### 6.1 Pre-Enrichment Validation

Before calling Claude API, run `validateImage()`. If invalid, skip enrichment and log the reason. Don't create an `enrich_failed` event for validation failures.

### 6.2 SDK Retry Configuration

Configure Anthropic SDK retry instead of custom wrapper:
```typescript
const client = new Anthropic({
  maxRetries: 3,  // Handles 429, 529, 500 automatically
});
```

The SDK already reads `retry-after` headers and uses exponential backoff.

### 6.3 Response Parsing Hardening

**Bug fix:** Current parsing uses `split("\n", 2)[1]` for markdown fence stripping, which truncates multi-line JSON.

**Correct approach:**
1. Try `JSON.parse(response)` directly (fastest path)
2. If fails, look for content between `` ```json `` and `` ``` `` markers — extract ALL content between them (not just first line)
3. If still fails, return structured error with raw response for debugging
4. Validate parsed object has required fields (description, objects, context, suggested_tags)
5. Coerce field types: ensure `objects` and `suggested_tags` are arrays (sometimes model returns strings)

**Do NOT use regex fallback** like `/{[\s\S]*}/` — it's too greedy and will match incorrectly if Claude includes conversational text around the JSON.

### 6.4 Batch Enrichment Improvements

The `index_bucket` action and CLI `enrich --pending` command do batch enrichment. Improve:
- Use `p-limit` with concurrency of 3 for parallel enrichment
- Continue on individual failures (don't abort batch)
- Return detailed batch result: `{ total, succeeded, failed, skipped, errors: [{key, error}] }`

### 6.5 Cost & Token Tracking

Log enrichment metadata from API response:
- Input tokens and output tokens (from `usage` field)
- Model used
- Image size (bytes)
- Logging only — no billing

---

## 7. Database Operations Hardening

### 7.1 Bug Fix: `upsertWatchedKey`

**Existing bug:** `onConflict: "s3_key"` is wrong — the primary key is `(s3_key, bucket_config_id)`. Also, `ignoreDuplicates: true` silently prevents ETag updates on re-scan.

**Fix:**
1. Add `bucket_config_id` as a parameter to `upsertWatchedKey()`
2. Change to `onConflict: "s3_key,bucket_config_id"`
3. Replace `ignoreDuplicates: true` with proper upsert that updates `etag`, `size_bytes`, and `event_id` on conflict
4. Log when an existing key is updated (indicates re-scan)

### 7.2 Bug Fix: N+1 Enrichment Query

**Existing bug:** `queryEvents()` issues one enrichment query per event. At thousands of photos, this is unacceptably slow.

**Fix:** Replace with a single joined query. The `search_events` RPC already joins events and enrichments, so for search queries this is handled. For non-search queries (show, list), use a single query with left join on enrichments.

### 7.3 Error Wrapping

Wrap all Supabase operations with consistent error handling:
- Map common Postgres error codes: `23505` → "duplicate key", `23503` → "FK violation", `42501` → "RLS denied"
- Include table name, operation, and relevant IDs in error messages
- Use the `withRetry()` helper (section 3.2) for connection-level errors

### 7.4 Search Robustness

Harden `queryEvents()`:
- Handle empty query text (return empty results, not error)
- Log search performance: query text, result count, duration_ms
- Cap `result_limit` at maximum (100) to prevent unbounded queries

---

## 8. Agent Action Hardening

### 8.1 Request Context

Use `AsyncLocalStorage` from section 2.3 — generate request ID at agent action dispatch and wrap the action handler in `runWithRequestId()`. All downstream media library calls automatically include the request ID in logs.

### 8.2 Action Error Standardization

Standardize error responses:
- All errors include: `error`, `errorType` (enum), `details` (optional object)
- Error types: `not_found`, `access_denied`, `validation_error`, `api_error`, `timeout`, `internal`
- Success responses include: `success: true`, `data`, and timing info

### 8.3 Index Bucket Action

The `indexBucket` action is the most complex. Harden:
- Use `p-limit` for parallel enrichment within batch
- Report progress: `{ phase: "listing" | "indexing" | "enriching", current, total }`
- Handle partial failures gracefully
- Return comprehensive result with per-object status

---

## 9. CLI Hardening

### 9.1 Error Reporting

Replace `die()` calls with structured error output:
- User-friendly message on stderr
- Technical details in `--verbose` mode
- Exit codes: 0 (success), 1 (user error), 2 (service error), 3 (internal error)

### 9.2 Watch Command

- Add `--interval` flag for poll interval (default: 60s)
- Add `--max-errors` flag to stop after N consecutive failures (default: 5)
- Log each scan cycle: objects found, new objects, enrichment results
- Handle S3 connection loss gracefully (retry, not crash)

### 9.3 Enrich Command

- Show progress log (current/total)
- Use `p-limit` for concurrency (default: 3)
- Add `--concurrency` flag to override
- Add `--dry-run` flag
- Report results: enriched, failed, skipped

---

## 10. Unit Tests

### 10.1 Test Strategy

All unit tests use **mocked dependencies**. Uses existing Vitest setup with `vi.mock()` and `vi.stubEnv()`. Tests should be written alongside each implementation section, not deferred to the end.

### 10.2 S3 Tests (`web/__tests__/s3-client.test.ts`)

**New test file** focused on the S3 client library (existing `s3-actions.test.ts` tests agent actions).

Test categories:
- **createS3Client**: Config mapping (endpoint, region, forcePathStyle, credentials, retry config)
- **listS3Objects**: Happy path, pagination (multi-page), v2→v1 fallback, empty bucket, max page guard
- **downloadS3Object**: Happy path, not found, access denied, network error
- **uploadS3Object**: Happy path, error handling
- **Error classification**: Each `S3ErrorType` maps correctly from various error shapes

### 10.3 Enrichment Tests (`web/__tests__/enrichment.test.ts`)

**New test file.**

Test categories:
- **enrichImage**: Happy path JSON response, markdown fence stripping (including multi-line JSON fix)
- **Response parsing edge cases**: Missing fields, wrong types (string instead of array), empty arrays
- **MIME type normalization**: image/jpg → image/jpeg
- **Image validation**: Size limit, MIME type check, magic byte validation
- **Client reuse**: Verify singleton behavior

### 10.4 DB Tests (`web/__tests__/db-operations.test.ts`)

**New test file.**

Test categories:
- **queryEvents**: Various filter combinations, empty results, N+1 fix verification
- **insertEvent**: Happy path, duplicate handling, missing required fields
- **insertEnrichment**: Happy path, FK violation
- **upsertWatchedKey**: New key, update existing key (ETag change), composite conflict key fix
- **getStats**: Normal operation, empty database
- **getEnrichStatus**: All enriched, none enriched, partial

### 10.5 Utility Tests (extend `web/__tests__/media-utils.test.ts`)

Add to existing test file:
- **detectContentType**: Unknown extensions, no extension, empty string
- **isMediaKey**: Case sensitivity, paths with multiple dots
- **sha256Bytes**: Empty buffer, known test vector
- **ULID monotonicity**: Verify sequential IDs are ordered
- **humanSize**: Boundary values (0, 1023, 1024, 1048576, etc.)

### 10.6 Validation Tests (`web/__tests__/validation.test.ts`)

**New test file:**
- **validateImage**: Each check (size, MIME, magic bytes, corrupt file)
- **validateS3Key**: Null bytes, long keys, special characters, valid keys
- **validateBucketConfig**: Each required field missing, valid config

### 10.7 Retry Tests (`web/__tests__/retry.test.ts`)

**New test file:**
- Succeeds on first try
- Retries correct number of times
- Uses injectable `delayFn` for deterministic timing (no real delays in tests)
- `shouldRetry` discriminator called correctly
- Final failure throws original error

### 10.8 Logger Tests (`web/__tests__/logger.test.ts`)

**New test file:**
- Output is valid JSON
- Correct log levels
- All output goes to stderr
- Component name included
- Request ID from AsyncLocalStorage included
- Additional metadata fields passed through

---

## 11. Integration Tests

### 11.1 Setup

Create `web/__tests__/integration/` directory with shared setup:
- Requires `supabase start` to be running
- Gets Supabase URL and keys from local config
- Creates test user via Supabase Auth admin API (reference existing pattern in `rls-policies.test.ts`)
- Cleans up test data after each test suite

### 11.2 Test Configuration

Add `vitest.media-integration.config.ts`:
- Include pattern: `__tests__/integration/media-*.test.ts`
- Timeout: 60 seconds
- Add `npm run test:media-integration` script

### 11.3 Database Integration Tests (`web/__tests__/integration/media-db.test.ts`)

- Insert event → query by search → verify found
- Insert event + enrichment → FTS search by description → verify weighted ranking
- Filter combinations: content_type + date range + search text
- RLS isolation: user A can't see user B's events
- Stats accuracy: verify counts match actual data
- Upsert watched key: insert then update with new ETag (verifies bug fix)

### 11.4 S3 Integration Tests (`web/__tests__/integration/media-s3.test.ts`)

Using Supabase Storage's S3 API:
- Create bucket → upload object → list → verify
- Upload multiple objects → paginated listing
- Download uploaded object → verify content matches
- Handle various content types (image, video)

### 11.5 Pipeline Integration Tests (`web/__tests__/integration/media-pipeline.test.ts`)

End-to-end (S3 → event → enrichment → search):
- Upload image to Storage → create S3 client → list objects → create event → verify in DB
- Note: Enrichment integration requires Claude API key, so mock the enrichment call but test everything else end-to-end

---

## 12. Implementation Order

1. **Structured Logger + Request Context** (Section 2)
2. **Retry Helper (Supabase only) + SDK Config** (Section 3)
3. **Input Validation** (Section 4)
4. **S3 Client Hardening** (Section 5)
5. **Enrichment Hardening** (Section 6)
6. **Database Operations Hardening + Bug Fixes** (Section 7)
7. **Agent Action Hardening** (Section 8)
8. **CLI Hardening** (Section 9)
9. **Unit Tests** (Section 10) — or written alongside each section above
10. **Integration Tests** (Section 11)

Each section is independently useful and can be implemented as a separate PR.

---

## 13. Files to Create

```
web/lib/logger.ts                              # Structured logger (stderr)
web/lib/request-context.ts                     # AsyncLocalStorage request ID
web/lib/retry.ts                               # Supabase-only retry helper
web/lib/media/validation.ts                    # Image, S3 key, config validation
web/lib/media/s3-errors.ts                     # S3 error classification
web/__tests__/s3-client.test.ts                # S3 library unit tests
web/__tests__/enrichment.test.ts               # Enrichment library unit tests
web/__tests__/db-operations.test.ts            # DB operations unit tests
web/__tests__/retry.test.ts                    # Retry helper unit tests
web/__tests__/logger.test.ts                   # Logger unit tests
web/__tests__/validation.test.ts               # Validation unit tests
web/__tests__/integration/setup.ts             # Integration test setup
web/__tests__/integration/media-db.test.ts     # DB integration tests
web/__tests__/integration/media-s3.test.ts     # S3 integration tests
web/__tests__/integration/media-pipeline.test.ts # Pipeline integration tests
vitest.media-integration.config.ts             # Integration test config
```

## 14. Files to Modify

```
web/lib/media/s3.ts                # SDK retry config, error classification, logging
web/lib/media/enrichment.ts        # Client reuse, validation, parsing fix, logging
web/lib/media/db.ts                # upsertWatchedKey fix, N+1 fix, error wrapping, logging
web/lib/media/utils.ts             # Minor hardening (null checks)
web/lib/agent/core.ts              # Request context, error standardization, logging
web/bin/smgr.ts                    # Error reporting, progress, logging
web/app/api/whatsapp/route.ts      # Request context, structured logging
web/app/api/health/route.ts        # Structured logging
web/package.json                   # Add p-limit dep, test:media-integration script
```
