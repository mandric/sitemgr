# Integration Notes — Opus Review

## Suggestions INTEGRATED

### 1. SDK Built-in Retry (Critical)
**Reviewer:** AWS SDK v3 and Anthropic SDK both have built-in retry. Custom `withRetry()` will double-retry.
**Action:** Restructure section 3. Leverage SDK retry for S3 and Claude API. Only add custom retry for Supabase operations (which don't have built-in retry). Add a spike step to verify SDK retry behavior.

### 2. AsyncLocalStorage for Request ID (Architecture)
**Reviewer:** Threading `requestId` through every function signature is invasive. Use Node's `AsyncLocalStorage`.
**Action:** Replace section 8.1's approach. Create a request context using `AsyncLocalStorage` that automatically propagates request ID without changing any function signatures.

### 3. Defer RateLimiter Class (Simplification)
**Reviewer:** Over-engineered for medium scale. Handle 429 in retry logic instead.
**Action:** Remove `web/lib/rate-limiter.ts` from the plan. Handle 429 via SDK retry config and Anthropic SDK's built-in backoff. Remove section 4 (Rate Limit Handling) as a standalone deliverable.

### 4. Use `p-limit` Instead of Custom ConcurrencyLimiter (Pragmatism)
**Reviewer:** Reinventing the wheel for a prototype. `p-limit` is 4KB, zero deps.
**Action:** Use `p-limit` package. Remove custom `web/lib/concurrency.ts`.

### 5. Logger Output to stderr (CLI Usability)
**Reviewer:** JSON logs to stdout will break CLI piping.
**Action:** All structured log output goes to stderr. CLI user-facing output (tables, JSON results) stays on stdout.

### 6. Distinguish User-Facing Output from Operational Logging
**Reviewer:** Can't blindly replace all console.log with structured logger.
**Action:** Add a note in section 2 that CLI user-facing output uses a separate `output()` function (simple console.log wrapper), while operational logging uses the structured logger.

### 7. Fix `upsertWatchedKey` Bug (Bug Fix)
**Reviewer:** `onConflict: "s3_key"` wrong — PK is `(s3_key, bucket_config_id)`. Also `ignoreDuplicates: true` prevents ETag updates.
**Action:** Add explicit bug fix to section 7. Change to proper composite conflict key and upsert behavior.

### 8. Fix N+1 Enrichment Query (Performance)
**Reviewer:** `queryEvents` issues one enrichment query per event. Slow at thousands of photos.
**Action:** Add to section 7.3 — replace N+1 with a single joined query.

### 9. Fix `parseJsonResponse` Bug (Bug Fix)
**Reviewer:** Multi-line JSON after markdown fence is truncated by `split("\n", 2)[1]`.
**Action:** Add explicit fix to section 6.3. Use proper fence extraction that captures all content between fences.

### 10. Injectable Delay in Retry Helper (Testability)
**Reviewer:** Testing real timing is flaky. Accept injectable delay function.
**Action:** Add `delayFn` parameter to retry config for testability.

### 11. Validation Test File Contradiction
**Reviewer:** Section 13 lists `validation.test.ts` but section 10.5 says extend `media-utils.test.ts`.
**Action:** Use a new `validation.test.ts` file for validation-specific tests. Remove the validation items from section 10.5.

### 12. Reference Existing RLS Test Pattern for Auth Tokens
**Reviewer:** Integration test setup doesn't explain how to get auth tokens.
**Action:** Reference the existing `rls-policies.test.ts` pattern for creating test users and obtaining tokens.

## Suggestions NOT INTEGRATED

### A. Use Existing Integration Config Instead of New Config
**Reviewer:** Having two integration configs increases maintenance burden.
**Reason for not integrating:** The existing `vitest.integration.config.ts` is for RLS/RPC tests that require specific database state. Media integration tests have different setup/teardown needs (S3 buckets, test images). Keeping them separate is cleaner than adding conditional setup logic. The overhead of one more config file is minimal.

### B. Add Agent Action Tests to Section 10
**Reviewer:** No tests for `core.ts` changes in the unit test section.
**Reason for not integrating:** The existing `agent-core.test.ts` already has comprehensive agent action tests. The changes to core.ts (request ID, error standardization) are thin wrappers that will be exercised by existing tests. Adding more mocked agent tests would be low value-add.

### C. Add CLI Tests
**Reviewer:** No tests for CLI hardening.
**Reason for not integrating:** CLI testing via process spawning is high effort, low reliability. The CLI is a thin wrapper around library functions that are thoroughly tested. The library hardening + library tests provide sufficient coverage. CLI-specific testing can be added later if needed.

### D. Implement as Individual PRs
**Reviewer:** Consider individual PRs per section.
**Reason for not integrating:** This is an implementation strategy decision, not a plan content decision. The implementer can choose to split into PRs. The plan's section structure already supports this.
