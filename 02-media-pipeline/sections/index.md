<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: npm test
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-logger
section-02-retry-sdk
section-03-validation
section-04-s3-hardening
section-05-enrichment-hardening
section-06-db-hardening
section-07-agent-hardening
section-08-cli-hardening
section-09-unit-tests
section-10-integration-tests
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-logger | - | 04, 05, 06, 07, 08 | Yes |
| section-02-retry-sdk | - | 04, 05, 06 | Yes |
| section-03-validation | - | 04, 05 | Yes |
| section-04-s3-hardening | 01, 02, 03 | 07, 08 | No |
| section-05-enrichment-hardening | 01, 02, 03 | 07, 08 | Yes (parallel with 04) |
| section-06-db-hardening | 01, 02 | 07, 08 | Yes (parallel with 04, 05) |
| section-07-agent-hardening | 01, 04, 05, 06 | 08 | No |
| section-08-cli-hardening | 01, 04, 05, 06 | - | No |
| section-09-unit-tests | 01-08 | 10 | No |
| section-10-integration-tests | 09 | - | No |

## Execution Order

1. **Batch 1** (no dependencies): section-01-logger, section-02-retry-sdk, section-03-validation
2. **Batch 2** (after batch 1): section-04-s3-hardening, section-05-enrichment-hardening, section-06-db-hardening
3. **Batch 3** (after batch 2): section-07-agent-hardening
4. **Batch 4** (after batch 3): section-08-cli-hardening
5. **Batch 5** (after batch 4): section-09-unit-tests
6. **Batch 6** (after batch 5): section-10-integration-tests

## Section Summaries

### section-01-logger
Structured logger (`web/lib/logger.ts`) and request context (`web/lib/request-context.ts`) using AsyncLocalStorage. All output to stderr. Component-based logging with JSON format.

### section-02-retry-sdk
Supabase-only retry helper (`web/lib/retry.ts`) with injectable delay for testing. AWS SDK v3 and Anthropic SDK retry configuration. Anthropic client singleton. `p-limit` dependency for batch concurrency.

### section-03-validation
Image validation (size, MIME, magic bytes), S3 key validation, bucket config validation. All in `web/lib/media/validation.ts`.

### section-04-s3-hardening
S3 error classification enum (`web/lib/media/s3-errors.ts`). SDK retry config in createS3Client. Pagination robustness (max page guard, edge cases). Timeout configuration.

### section-05-enrichment-hardening
Anthropic client reuse (singleton). Response parsing fix (multi-line JSON in markdown fences). Pre-enrichment validation. Batch enrichment with p-limit. Token/cost logging.

### section-06-db-hardening
Bug fix: `upsertWatchedKey` composite conflict key + update behavior. Bug fix: N+1 enrichment query in `queryEvents`. Postgres error code mapping. Search robustness (empty query, result cap). Supabase retry integration.

### section-07-agent-hardening
Request context at action dispatch via AsyncLocalStorage. Error response standardization (errorType enum). indexBucket improvements (p-limit concurrency, partial failure handling, detailed results).

### section-08-cli-hardening
Structured error reporting with exit codes. Watch command: --interval, --max-errors. Enrich command: --concurrency, --dry-run, progress output. User output to stdout, logs to stderr.

### section-09-unit-tests
All unit test files: s3-client.test.ts, enrichment.test.ts, db-operations.test.ts, retry.test.ts, logger.test.ts, request-context.test.ts, validation.test.ts. Extend media-utils.test.ts.

### section-10-integration-tests
Integration test setup (local Supabase). Test config (vitest.media-integration.config.ts). DB integration tests, S3 integration tests, pipeline integration tests.
