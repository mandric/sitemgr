# Research Findings

## Part 1: Codebase Analysis

### Existing Integration Test Files

The codebase has **6 integration test files** across 2 vitest configs:

#### Media Integration Tests (`vitest.media-integration.config.ts`, 60s timeout)
- **`web/__tests__/integration/media-db.test.ts`** (294 lines) — Tests FTS search, RLS isolation, stats, watched_keys upsert. Creates two test users (A, B) to verify isolation. Uses admin client for writes, user client for reads.
- **`web/__tests__/integration/media-pipeline.test.ts`** (156 lines) — E2E pipeline: S3 upload → list → DB create event → search. Creates dynamic test bucket `test-pipeline-${Date.now()}`. Tracks `uploadedKeys` for cleanup.
- **`web/__tests__/integration/media-s3.test.ts`** (87 lines) — S3 client operations: upload, list, download. Uses `TINY_JPEG` fixture (23-byte minimal JPEG). Clean and well-structured.

#### Database & Security Integration Tests (`vitest.integration.config.ts`, 30s timeout)
- **`web/__tests__/rls-policies.test.ts`** (302 lines) — Comprehensive RLS validation across 6 tables. Creates two auth users. Seeds in dependency order. Tests cross-tenant isolation, anon blocking, insert restrictions, NULL user_id cases, SECURITY DEFINER restrictions. **Uses `describe.skipIf(!canRun)`.**
- **`web/__tests__/rpc-user-isolation.test.ts`** (192 lines) — RPC function `p_user_id` enforcement. Tests `search_events`, `stats_by_content_type`, `stats_by_event_type`, `get_user_id_from_phone`. Uses hardcoded test UUIDs.
- **`web/__tests__/migration-integrity.test.ts`** (64 lines) — **All `it.todo()` stubs.** Placeholder for schema verification, data preservation, edge cases.

#### Shared Setup (`web/__tests__/integration/setup.ts`, 95 lines)
Exports:
- `getSupabaseConfig()` — URL, anonKey, serviceKey from env vars
- `getAdminClient()` — service role client (bypasses RLS)
- `createTestUser(email?)` — creates auth user, signs in, returns `{ userId, client }`
- `cleanupTestData(userId)` — deletes in dependency order
- `getS3Config()` — S3-compatible endpoint config
- `TINY_JPEG` — 23-byte minimal valid JPEG buffer

### Vitest Configurations

| Config | Include | Timeout | Purpose |
|--------|---------|---------|---------|
| `vitest.config.ts` | All except integration | Default (5s) | Unit tests |
| `vitest.integration.config.ts` | rls-policies, rpc-user-isolation, migration-integrity | 30s | DB/security |
| `vitest.media-integration.config.ts` | `media-*.test.ts` | 60s | Media pipeline |

### CI Workflow (`.github/workflows/ci.yml`)

The `integration-tests` job:
1. Checkout, node v20, Supabase CLI
2. `supabase start` (applies migrations, starts Auth/Storage)
3. Extracts env vars from `supabase status -o json` via jq
4. Verifies critical env vars are non-null (prevents silent skip)
5. Runs `npm run test:integration` (DB tests)
6. Runs `npm run test:media-integration` (media tests)
7. Runs inline FTS smoke test via psql (duplicates media-lifecycle coverage)
8. `supabase stop`

### Database Schema (12 Migrations)

Final schema after all migrations:
- `events(id, timestamp, device_id, type, content_type, content_hash, local_path, remote_path, metadata, parent_id, user_id NOT NULL)`
- `enrichments(event_id FK→events, description, objects[], context, tags[], fts TSVECTOR, user_id NOT NULL)`
- `watched_keys(s3_key, first_seen, event_id FK→events, etag, size_bytes, user_id NOT NULL)`
- `bucket_configs(user_id NOT NULL, bucket_name, endpoint_url, access_key_id, secret_access_key, key_version, UNIQUE(user_id, bucket_name))`
- `conversations(user_id NOT NULL PK, history JSONB, updated_at)`
- `user_profiles(id PK, phone_number, ...)`

Key evolution: phone_number was originally PK on bucket_configs → user_id added → data migrated → phone_number dropped. This is the exact drift that caused the test failure.

### Test Patterns in Use

1. **User creation:** `admin.auth.admin.createUser()` → `signInWithPassword()` → get authenticated client
2. **Seeding order:** user_profiles → events → enrichments → watched_keys → bucket_configs → conversations
3. **Cleanup order:** reverse of seeding + `auth.admin.deleteUser()`
4. **RLS verification:** Insert as admin, query as user client, assert only own data visible
5. **Dynamic naming:** `test-${Date.now()}-${Math.random()}` for test resources
6. **skipIf pattern:** `describe.skipIf(!canRun)` — hides 22+ tests when env vars missing

### NPM Test Scripts
```json
"test": "vitest run",
"test:integration": "vitest run --config vitest.integration.config.ts",
"test:media-integration": "vitest run --config vitest.media-integration.config.ts"
```

---

## Part 2: Web Research — Best Practices (2025-2026)

### 1. Vitest Integration Testing Patterns

**Projects configuration (Vitest 3.2+):** The recommended approach replaces deprecated `vitest.workspace`. Define inline projects in root `vitest.config.ts`:

```typescript
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['**/*.unit.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['**/*.integration.test.{ts,tsx}'],
          testTimeout: 30000,
          hookTimeout: 30000,
          fileParallelism: false,
        },
      },
    ],
  },
});
```

Run selectively: `vitest --project unit` or `vitest --project integration`.

**Global Setup/Teardown:** Use `globalSetup` for shared resources (database, server). Tests consume via `inject()`. Runs in separate scope — can't share variables directly.

**Test Isolation:**
- Each worker gets isolated environment by default
- `fileParallelism: false` for tests sharing external state (database)
- Per-test cleanup via `beforeEach`/`afterEach`

**Recommended Timeouts:** 30s per test for DB operations, 60s for S3/network operations.

### 2. Supabase RLS Testing Strategies

**Approach A — pgTAP (database-level):**
- Tests run inside PostgreSQL transactions with automatic rollback
- `basejump-supabase_test_helpers` provides `create_supabase_user()`, `authenticate_as()`, `clear_authentication()`, `rls_enabled()`
- Run via `supabase test db`
- Best for: policy logic verification, comprehensive RLS audits

**Approach B — Vitest + Supabase JS Client (application-level):**
- Tests through actual PostgREST API (full-stack verification)
- Service role for setup, anon/authenticated for assertions
- Unique identifiers per suite for parallel safety
- Best for: integration validation, real client behavior

**Multi-tenant isolation checklist:**
1. Cross-tenant reads blocked (assert empty)
2. Cross-tenant writes blocked (assert RLS error)
3. CI gate: `rls_enabled('public')` catches missing RLS
4. Index policy columns (btree on user_id, org_id) — 100x+ perf improvement
5. Cache `auth.uid()` with `(SELECT auth.uid())` for per-query evaluation

### 3. BDD-Style Test Organization in TypeScript

**Naming convention — "should ... when ...":**
```typescript
describe('PaymentService', () => {
  describe('when processing a refund', () => {
    it('should return the full amount when within 30-day window', () => {});
    it('should throw InsufficientFundsError when merchant balance is zero', () => {});
  });
});
```

**Given/When/Then with nested describes:**
```typescript
describe('BankAccount', () => {
  describe('given a balance of 1000', () => {
    describe('when the account is locked', () => {
      it('then a deposit of 100 should be rejected', () => {});
    });
  });
});
```

**Practical rules:**
1. Start with "should" + verb
2. Include the trigger condition
3. Use business language, not technical
4. Group by behavior/feature, not method name
5. AAA pattern (Arrange-Act-Assert) within each test

### 4. GitHub Actions + Supabase CI Patterns

**Reference workflow:**
1. `supabase/setup-cli@v1` — installs CLI
2. `supabase start` — pulls Docker images, applies migrations
3. Extract connection info from `supabase status --output json`
4. Run pgTAP tests: `supabase test db`
5. Run Vitest integration tests

**Key considerations:**
- Docker pre-installed on `ubuntu-latest`
- First `supabase start` pulls images (~2-3 min)
- Path-filter triggers to save CI minutes
- Use `supabase db push --dry-run` on PRs for migration preview
- Separate test and deploy workflows

---

## Cross-Cutting Recommendations

1. **Consolidate vitest configs** using Vitest `projects` — single config with `unit` and `integration` projects
2. **Use `globalSetup`** to validate Supabase is running (fail fast with clear error instead of `skipIf`)
3. **BDD naming** with `describe('when condition', () => it('should behavior'))` pattern
4. **Shared seed helpers** as single source of truth for table schemas
5. **Application-level RLS tests** (Vitest + Supabase client) match how the app actually consumes the API — more valuable than pgTAP for this project's needs
6. **Remove inline FTS smoke test** from CI — covered by media-lifecycle tests
