# Codebase Research: Test Suite Structure

## Overview
- **Total Test Files**: 41 (8,780 lines)
- **Vitest Configuration**: Two projects (unit and integration)
- **E2E Framework**: Playwright (1 test suite, 4 tests)

## Test File Organization

### Root Level Unit Tests (26 files in `web/__tests__/`)

**Pure Logic Tests (No Mocks):**
- `device-codes.test.ts` — device/user code generation
- `encryption.test.ts` — core encrypt/decrypt roundtrips with real crypto
- `encryption-rotation.test.ts` — key rotation lifecycle
- `encryption-versioned.test.ts` — versioned encryption with key labels
- `validation.test.ts` — input validation rules
- `retry.test.ts` — retry logic with exponential backoff
- `media-utils.test.ts` — media utility functions

**Mock-Heavy Unit Tests:**
- `s3-client.test.ts` — Mocks: `@aws-sdk/client-s3`, `@smithy/node-http-handler`, logger, validation
- `supabase-client.test.ts` — Mocks: `@supabase/supabase-js`
- `encryption-lifecycle.test.ts` — Mocks: Anthropic, media/db, media/s3, enrichment (real encryption though)
- `db-operations.test.ts` — Mocks: Supabase client, logger, request-context, retry, encryption
- `agent-core.test.ts` — Mocks: Anthropic, media/db, media/s3, enrichment, request-context, logger, crypto
- `s3-actions.test.ts` — Mocks: AWS S3, logger, database operations
- `enrichment.test.ts` — Mocks: Anthropic SDK, image validation, logger
- `agent-actions.test.ts` — Mocks: multiple dependencies
- `phone-migration-app.test.ts` — Mocks: Supabase, logger
- `request-context.test.ts` — Tests async context tracking
- `logger.test.ts` — Mocks: console methods (spyOn)
- `health-route.test.ts` — Mocks: Supabase client
- `instrumentation.test.ts` — Mocks: OpenTelemetry
- `device-approve-form.test.ts` — No vi.mock blocks
- `device-approve-route.test.ts` — Mocks: Supabase server client
- `device-initiate-route.test.ts` — Mocks: multiple dependencies
- `device-token-route.test.ts` — Mocks: Supabase, request-context
- `whatsapp-route.test.ts` — Mocks: Supabase, logger

### Unit Subdirectory (4 files in `web/__tests__/unit/`)
- `api-auth.test.ts` — Mocks: multiple dependencies
- `cli-auth-device-flow.test.ts` — Mocks: child_process, fs, spyOn fetch
- `cli-open-browser.test.ts` — Mocks: child_process
- `sitemgr-login-command.test.ts` — Minimal test

### Integration Tests (11 files in `web/__tests__/integration/`)

**Setup Files:**
- `setup.ts` — Helpers: `createTestUser()`, `seedUserData()`, `cleanupUserData()`, `getAdminClient()`, `getS3Config()`, `TINY_JPEG`
- `globalSetup.ts` — Validates Supabase, optionally spawns Next.js dev server, health checks

**Test Files:**
- `auth-smoke.test.ts` — Auth sanity checks
- `device-auth.test.ts` — Device auth flows
- `device-codes-schema.test.ts` — DB schema validation
- `media-lifecycle.test.ts` — Media pipeline: upload → watch → enrich → query
- `media-storage.test.ts` — Supabase Storage operations
- `model-configs.test.ts` — Model configuration DB operations
- `schema-contract.test.ts` — DB schema contracts
- `tenant-isolation.test.ts` — Multi-tenant isolation
- `webhook-service-account.test.ts` — Webhook service account
- `sitemgr-cli.test.ts` — CLI subprocess tests (390 lines)
- `sitemgr-e2e.test.ts` — Full pipeline test (375 lines)
- `sitemgr-cli-auth.test.ts` — Static security analysis of CLI source

## CLI Test Details

### `sitemgr-cli.test.ts` (390 lines)
Tests CLI commands via subprocess (`tsx bin/sitemgr.ts`):
- help/usage, exit codes
- `sitemgr stats` — valid JSON output, auth failure
- `sitemgr query` — table format, JSON format, --limit, --device filter
- `sitemgr query --search` — FTS search, empty results
- `sitemgr show` — event details, enrichment, errors, nonexistent
- `sitemgr enrich --status`, `--dry-run`, error cases

Setup: creates test user, seeds 3 events with enrichments, writes credentials file, temp HOME.

### `sitemgr-e2e.test.ts` (375 lines)
Full pipeline test (sequential, long timeouts):
1. `watch --once` discovers uploaded images (60s)
2. `enrich --dry-run` lists pending (30s)
3. `enrich --pending` processes all images (300s — moondream on CPU)
4. FTS search returns results from enrichment descriptions (30s)
5. FTS search for nonsense returns nothing (30s)
6. Final stats show all enriched (30s)

Requires: Supabase + Next.js + S3 + local Ollama with moondream:1.8b

### `sitemgr-cli-auth.test.ts` (32 lines)
Static analysis: verifies CLI source doesn't import admin client or reference service role keys.

## Vitest Configuration

**Unit project:** excludes `e2e/**`, `integration/**`
**Integration project:** includes `__tests__/integration/**/*.test.ts`, 60s timeout, sequential

### package.json Scripts
```
test              → vitest run --project unit
test:integration  → vitest run --project integration
test:e2e          → playwright test
```

No `test:e2e:cli` script exists yet.

## Playwright E2E Setup

- Config: `playwright.config.ts` — Desktop Chrome only, parallel, base URL localhost:3000
- Tests: `e2e/agent.spec.ts` (210 lines) — UI tests for chat interface
- Uses Mailpit for email confirmation
- 2 active tests, 2 skipped (AI-dependent)

## Test Helpers

`__tests__/helpers/agent-test-setup.ts` — Shared mock setup for agent tests:
- Mock Supabase chain builders (select → eq → maybeSingle, etc.)
- Mock S3 send
- Test constants (PHONE, fakeBucketConfig)

## Mock Categorization Summary

| Category | Files | Examples |
|----------|-------|---------|
| Supabase-heavy | 10+ | db-operations, device-*, health-route, whatsapp-route |
| S3-heavy | 3 | s3-client, s3-actions, encryption-lifecycle |
| Anthropic/LLM | 3 | agent-core, enrichment, agent-actions |
| Child process | 2 | cli-auth-device-flow, cli-open-browser |
| Pure logic | 7 | encryption, validation, retry, media-utils, device-codes |

## Testing Infrastructure Notes

- Integration tests use `createTestUser()` + `seedUserData()` pattern
- CLI tests spawn `tsx bin/sitemgr.ts` with temp HOME directories
- globalSetup handles Next.js dev server lifecycle
- Supabase must be running for integration tests
- `fileParallelism: false` for integration (sequential execution)
