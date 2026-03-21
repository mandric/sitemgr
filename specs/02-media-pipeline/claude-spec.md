# 02-media-pipeline — Synthesized Specification

## Goal

Harden the existing media pipeline through comprehensive test coverage, improved error handling, and production reliability improvements. The pipeline is fully implemented but needs hardening for a medium-scale deployment (a few users, thousands of photos, regular automated syncing).

## Scope

**Full pipeline end-to-end:**
- `web/lib/media/` — S3 client, enrichment, DB operations, utilities, constants
- `web/lib/agent/core.ts` — Action handlers that use media library
- `web/bin/smgr.ts` — CLI commands (watch, enrich, query, stats)
- `web/app/api/` — API routes (WhatsApp webhook, health, media)
- `web/lib/crypto/` — Encryption used for bucket credentials (as dependency)

**Breaking changes are acceptable** — prototype mode, all APIs open to change.

---

## Deliverable 1: Test Coverage

### Unit Tests (Mocked Dependencies)

Target the core media library with mocked Supabase and S3:

**`s3.ts` — gaps to fill:**
- ListObjectsV2 pagination (multiple pages with ContinuationToken)
- V2→V1 fallback trigger conditions (specific error messages)
- Network timeout handling
- Partial response handling (missing keys in S3 object response)
- Provider-specific errors (AWS vs MinIO vs Supabase Storage)
- Empty bucket listing
- ETag normalization edge cases
- `forcePathStyle` configuration for different providers

**`enrichment.ts` — gaps to fill:**
- Rate limit response (429) handling
- Server overloaded (529) handling
- Malformed JSON in Claude response
- Markdown fence stripping edge cases
- Invalid/corrupt image handling
- Large image handling (>20MB)
- MIME type normalization (image/jpg → image/jpeg)
- Empty/missing fields in enrichment response

**`db.ts` — gaps to fill:**
- Connection failure handling
- RLS denial scenarios (wrong user_id)
- Constraint violation handling (duplicate keys, FK violations)
- Empty result sets for all query functions
- `search_events` with various filter combinations
- `getPendingEnrichments` with no pending items
- `upsertWatchedKey` conflict resolution
- `findEventByHash` with no match

**`utils.ts` — gaps to fill:**
- Unknown file extensions
- Files with no extension
- Empty strings and null inputs
- SHA-256 hashing of empty buffer
- ULID monotonicity verification
- `humanSize` boundary values

### Integration Tests (Real Services)

Use local Supabase (`supabase start`) which includes S3-compatible storage:

**Database integration:**
- Insert events and verify they appear in queries
- Insert enrichments and verify FTS search works
- Verify RLS policies block cross-user access
- Verify watched_key upsert idempotency
- Test search_events RPC with real tsvector matching
- Test stats RPCs return correct counts

**S3 integration:**
- Upload objects to Supabase Storage via S3 API
- List objects and verify pagination works
- Download uploaded objects and verify content matches
- Test with various file types (images, video, audio)

**End-to-end pipeline integration:**
- Upload image to Supabase Storage → list via S3 → create event → enrich → verify search finds it

---

## Deliverable 2: Error Handling Hardening

### S3 Error Scenarios
- Network timeouts (configurable timeout, not infinite)
- Partial responses (handle gracefully, log, continue)
- Provider-specific error codes
- Connection refused / DNS resolution failure
- Bucket not found / access denied (clear error messages)

### Claude API Failure Modes
- Rate limit (429): Read `retry-after` header, exponential backoff with jitter
- Overloaded (529): Exponential backoff, configurable max retries
- Malformed JSON response: Fallback parsing, structured error
- Invalid image (wrong format, too large): Pre-validate before API call
- API key invalid/expired: Clear error message, fail fast

### Database Error Handling
- Connection pool exhaustion: Graceful degradation
- RLS denial: Clear error message (not generic 403)
- Constraint violations: Specific error types (duplicate, FK)
- Timeout on long queries: Configurable timeout

### Edge Cases in Media Processing
- Large files (>20MB images): Pre-validate, skip or resize
- Corrupt images: Detect before sending to Claude API
- Unsupported formats (e.g., RAW, TIFF): Graceful skip with logging
- Empty buckets: Return clean empty result, no error
- S3 keys with special characters: URL encoding handling
- Zero-byte files: Skip with warning

---

## Deliverable 3: Retry Logic

### Retry Strategy
- **Exponential backoff** with configurable base delay (default: 1s) and max delay (default: 30s)
- **Jitter** (randomized delay within ±25%) to prevent thundering herd
- **Configurable max retries** (default: 3 for S3, 3 for Claude API)
- **Idempotency-safe**: Only retry idempotent operations (GET/LIST for S3, enrichment for Claude)

### S3 Retry
- Retry on: network error, timeout, 500, 503
- Don't retry on: 403 (access denied), 404 (not found), 400 (bad request)
- Use AWS SDK built-in retry with custom config

### Claude API Retry
- Retry on: 429 (rate limit), 529 (overloaded), network error
- Read `retry-after` header for 429 responses
- Don't retry on: 400 (invalid request), 401 (auth error)
- Track retry count in enrichment metadata

---

## Deliverable 4: Rate Limit Handling

### Claude API Rate Limiting
- Parse `anthropic-ratelimit-requests-remaining` header
- Queue requests when approaching limit
- Configurable concurrency for batch enrichment (default: 3 concurrent)
- Log rate limit events for monitoring

### S3 Rate Limiting
- Configurable concurrency for batch operations (default: 5 concurrent)
- Backoff on 503 (slow down) responses

---

## Deliverable 5: Input Validation

### Image Validation (Pre-Enrichment)
- Check file size (reject >20MB for Claude API)
- Validate MIME type against supported formats (JPEG, PNG, GIF, WebP)
- Detect corrupt/incomplete images (validate header bytes)
- Validate image dimensions (warn if >1568px, as Claude auto-resizes)

### S3 Key Validation
- Validate key doesn't contain null bytes
- Handle URL-encoded special characters
- Validate key length (<1024 bytes)

### Configuration Validation
- Validate bucket_config fields before S3 client creation
- Validate endpoint URL format
- Validate region format

---

## Deliverable 6: Observability & Logging

### Structured Logging
- Replace console.log/error with structured logger
- Include: timestamp, level, component, request_id, duration_ms
- Components: `s3`, `enrichment`, `db`, `agent`, `cli`
- Levels: debug, info, warn, error

### Key Metrics to Log
- S3 operations: list duration, object count, bytes transferred
- Enrichment: API latency, token usage, success/failure rate
- Database: query duration, row counts, error rates
- Pipeline: batch size, throughput, error rate

### Request Tracing
- Generate request ID at pipeline entry (CLI command, API route, agent action)
- Pass through all operations for correlation

---

## Constraints

- **Local development only** — no CI pipeline changes in this plan
- **Prototype mode** — all APIs open to change
- **Medium scale** — a few users, thousands of photos
- **Existing test framework** — Vitest for unit/integration, Playwright for E2E
- **Existing infrastructure** — Supabase (Postgres + Storage), Vercel, AWS SDK v3
