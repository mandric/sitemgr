# Refactor Integration Tests — Spec

## Problem

The integration tests have three structural problems that showed up in the `phone_number` column removal failure:

1. **Tests are stale and skip silently.** `migration-integrity.test.ts` has 12 tests — all `.todo()`. The 22 RLS tests skipped because a single seed insert failed in `beforeAll`, hiding all the tests that would have passed. When a test suite reports "22 skipped" and nobody investigates, that's the same as having no tests.

2. **Test fixtures are hand-maintained SQL inserts, not migration-driven.** The `rls-policies.test.ts` seed data referenced a `phone_number` column that no longer exists. The production schema evolved through migrations, but the test fixtures were written against a stale mental model of the schema. There is no shared fixture layer — each test file builds its own seed data with inline `admin.from("table").insert({...})` calls.

3. **Test intent is unclear.** The current test names describe _what_ they do ("user A cannot SELECT user B's events") but not _why_ it matters. There's no grouping by business capability. A new contributor can't tell which tests protect critical business logic vs. which are defensive edge cases.

## Goals

- **Test through our code, not Supabase directly.** Integration tests must exercise our application layer — TypeScript modules (`db.ts`, `s3.ts`, `enrichment.ts`), HTTP API routes (`/api/media`, `/api/health`, `/api/whatsapp`), and CLI commands. No test should import `@supabase/supabase-js` directly or call `admin.from("table")` for anything other than test-only setup/teardown (creating auth users, final cleanup). If we're testing search, call `queryEvents()` from `db.ts`, not `client.rpc("search_events")`. If we're testing S3, call `listS3Objects()` / `uploadS3Object()` from `s3.ts`, not raw AWS SDK commands in the test. This way we're validating our code — our retry logic, our error handling, our client factories — not just proving Supabase works.
- **Start the web backend for HTTP-layer tests.** After Supabase is launched and `.env.local` is set, the Next.js dev server starts so tests can `fetch("/api/...")` against our actual API routes. This validates middleware, auth, headers, and the full request lifecycle — not just the functions underneath.
- **Zero skipped tests.** Every test either runs and validates something, or gets deleted. No `.todo()` stubs, no `describe.skipIf` that silently passes.
- **Migration-driven schema.** Tests run against the schema produced by the real migration files in `supabase/migrations/`. The CI job already does this (`supabase start` applies migrations). The fix is that test fixtures must be written against the _current_ schema, not a snapshot — and we need a mechanism to catch drift.
- **BDD-style test organization.** Tests are grouped by business behavior and read like specifications. A product person can scan the test names and understand what the system guarantees.

## Out of Scope

- Adding new business features or changing schema
- E2E / Playwright tests
- Legacy shell-based integration tests (`tests/integration_test.sh`)
- Preview environment setup
- Performance benchmarks

## Design

### Test file structure

Replace the current 6 test files with 4 behavior-oriented suites:

```
web/__tests__/integration/
  setup.ts                        # shared helpers (keep, extend)
  schema-contract.test.ts         # schema verification (replaces migration-integrity.test.ts)
  tenant-isolation.test.ts        # RLS + RPC isolation (replaces rls-policies.test.ts + rpc-user-isolation.test.ts)
  media-lifecycle.test.ts         # upload → enrich → search (replaces media-db.test.ts + media-pipeline.test.ts)
  media-storage.test.ts           # S3 operations (replaces media-s3.test.ts)
```

### Suite 1: Schema Contract (`schema-contract.test.ts`)

Replaces `migration-integrity.test.ts` (currently all `.todo()`). Validates that the schema produced by migrations matches what the application code expects. This is the test that would have caught the `phone_number` drift.

```
Feature: Database schema matches application expectations

  Scenario: All application tables exist
    Given migrations have been applied
    Then these tables exist in public schema:
      | events | enrichments | watched_keys |
      | bucket_configs | conversations | user_profiles |

  Scenario: Table columns match application code
    Given migrations have been applied
    Then events has columns: id, timestamp, device_id, type, content_type, user_id, ...
    And bucket_configs has columns: id, user_id, bucket_name, endpoint_url, ...
    And bucket_configs does NOT have column: phone_number

  Scenario: Required indexes exist for query performance
    Given migrations have been applied
    Then these indexes exist:
      | idx_enrichments_fts | idx_events_user_id | idx_events_timestamp |
      | idx_bucket_configs_user_bucket | idx_watched_keys_user_id |

  Scenario: RLS is enabled on all user-data tables
    Given migrations have been applied
    Then RLS is enabled on: events, enrichments, watched_keys,
         bucket_configs, conversations, user_profiles

  Scenario: NOT NULL constraints enforce data integrity
    Given migrations have been applied
    Then user_id is NOT NULL on: events, enrichments, watched_keys, bucket_configs

  Scenario: RPC functions exist with expected signatures
    Given migrations have been applied
    Then these functions exist: search_events, stats_by_content_type,
         stats_by_event_type, get_user_id_from_phone
```

**Implementation approach:** Call our application code, not raw Supabase SDK.

- **Table/column existence:** Use `insertEvent()` from `db.ts` to insert a valid row — if a column changed, our code (not just PostgREST) fails. Use `queryEvents()` to read it back. This validates that our TypeScript types and query builders match the current schema.
- **NOT NULL constraints:** Use `insertEvent()` with `user_id: null` — assert our code propagates the DB error correctly.
- **RLS enforcement:** Create a user client via `getUserClient()` from `db.ts`, then call `queryEvents()` — assert scoping works through our query layer (overlaps with tenant-isolation, but this suite checks the structural guarantee, not data correctness).
- **RPC functions:** Call `queryEvents({ search: "..." })` from `db.ts` (which calls `search_events` internally), `getStats()` from `db.ts` (which calls `stats_by_content_type` / `stats_by_event_type`). This validates the RPCs exist _and_ that our wrapper code handles them correctly.
- **Indexes and structural metadata:** For things not exposed via our app code (index existence, RLS enabled flag), add a single lightweight `schema_info` RPC function in a test-support migration that queries `pg_indexes`/`pg_policies` and returns the result. Alternatively, skip index-existence checks — if an index is missing, the app still works (just slower), and query performance is better validated by the media-lifecycle suite's search tests.

**Why this matters:** This is the test that prevents the exact failure we hit. If `bucket_configs` loses a column or gains a NOT NULL constraint, this suite tells you immediately — before any seed insert fails cryptically. And because we test through our code, we also catch bugs in our TypeScript layer (wrong column names in queries, mismatched types, broken retry logic).

### Suite 2: Tenant Isolation (`tenant-isolation.test.ts`)

Merges `rls-policies.test.ts` and `rpc-user-isolation.test.ts` into one behavior-oriented suite. Organized by what a tenant _can_ and _cannot_ do.

```
Feature: Multi-tenant data isolation

  Background:
    Given two authenticated users (Alice and Bob) exist
    And Alice owns: 2 events, 1 enrichment, 1 watched_key, 1 bucket_config
    And Bob owns: 1 event, 1 enrichment, 1 watched_key, 1 bucket_config
    And each user has a conversation and a profile

  Scenario: A user can only see their own data
    When Alice queries events
    Then she sees 2 events
    And none belong to Bob

    When Alice queries enrichments
    Then she sees 1 enrichment
    And none belong to Bob

    (repeat for watched_keys, bucket_configs, conversations, user_profiles)

  Scenario: A user cannot create data owned by another user
    When Alice inserts an event with Bob's user_id
    Then the insert is rejected

    When Alice inserts a bucket_config with Bob's user_id
    Then the insert is rejected

    When Alice inserts an enrichment with Bob's user_id
    Then the insert is rejected

  Scenario: Unauthenticated requests are blocked
    When an anonymous client queries any table
    Then the result is empty or access denied

  Scenario: Search results are scoped to the requesting user
    When Alice calls queryEvents({ search: "...", userId: aliceId }) via db.ts
    Then results contain only Alice's events

    When Alice calls queryEvents({ search: "...", userId: bobId }) via db.ts
    Then results are empty (RLS blocks the underlying data)

  Scenario: Stats are scoped to the requesting user
    When Alice calls getStats(aliceClient, { userId: aliceId }) via db.ts
    Then counts reflect only Alice's data

  Scenario: Service-role-only functions are not callable by users
    When Alice calls get_user_id_from_phone
    Then the call is rejected with "permission denied"

    When an anonymous client calls get_user_id_from_phone
    Then the call is rejected with "permission denied"

  Scenario: Records with NULL user_id are invisible to all users
    Given an admin inserts an event with NULL user_id
    When Alice queries events
    Then the NULL-user_id event is not visible
    When Bob queries events
    Then the NULL-user_id event is not visible
```

**Key changes from current tests:**
- **Call our code, not Supabase SDK.** Use `queryEvents()`, `getStats()`, `getEnrichStatus()` from `db.ts` instead of `client.from("events").select()` or `client.rpc("search_events")`. Use `insertEvent()`, `insertEnrichment()`, `upsertWatchedKey()` from `db.ts` for any test-driven writes (seeding still uses admin client directly since that's test-only infra, not app code).
- Merge two test files into one — the RPC isolation tests and RLS tests are both validating the same business guarantee (tenant isolation), just at different layers.
- `beforeAll` seed failures must fail the suite loudly, not skip silently. Use `beforeAll` with explicit assertions that throw, and do NOT wrap the describe in `skipIf`.
- Seed data construction uses a shared helper from `setup.ts` that builds valid fixtures against the current schema (no hardcoded `phone_number` on `bucket_configs`).

### Suite 3: Media Lifecycle (`media-lifecycle.test.ts`)

Merges `media-db.test.ts` and `media-pipeline.test.ts`. Organized around the user journey.

```
Feature: Media lifecycle from upload to search

  Background:
    Given an authenticated user with an S3 bucket configured

  Scenario: Upload a photo and find it via search
    When the user calls uploadS3Object() from s3.ts to upload a JPEG
    And insertEvent() from db.ts records the event
    And insertEnrichment() from db.ts creates description "sunset over mountains"
    Then queryEvents({ search: "sunset" }) from db.ts returns the photo
    And queryEvents({ search: "cat" }) from db.ts returns nothing

  Scenario: Filter search results by content type and date range
    Given the user has photos and videos with enrichments (via insertEvent/insertEnrichment)
    When calling queryEvents({ type: "photo" }) from db.ts
    Then only photos are returned
    When calling queryEvents({ since, until }) from db.ts
    Then only events within that range are returned

  Scenario: Stats reflect the user's actual data
    Given the user has 2 photos and 1 video (via insertEvent from db.ts)
    When the user calls getStats() from db.ts
    Then the response shows photo=2, video=1

  Scenario: Enrichment status tracking
    Given the user has 3 events, 1 enriched (via insertEvent/insertEnrichment from db.ts)
    When the user calls getEnrichStatus() from db.ts
    Then pending=2, enriched=1

  Scenario: Watched key upsert updates metadata on re-scan
    Given upsertWatchedKey() from db.ts was called with etag "abc"
    When upsertWatchedKey() is called again with etag "def"
    Then the stored etag is "def" (updated, not duplicated)

  Scenario: User A cannot see User B's media
    Given User A and User B both have events (via insertEvent from db.ts)
    When User A calls queryEvents() from db.ts
    Then User B's events are not included
```

### Suite 4: Media Storage (`media-storage.test.ts`)

Tests S3 operations through `createS3Client()`, `uploadS3Object()`, `listS3Objects()`, and `downloadS3Object()` from `s3.ts` — not raw AWS SDK calls.

```
Feature: S3-compatible storage operations (via s3.ts)

  Scenario: Upload and list objects in a bucket
    When uploadS3Object() is called from s3.ts
    Then listS3Objects() from s3.ts returns the uploaded object

  Scenario: Download an uploaded object with correct content
    When downloadS3Object() is called from s3.ts
    Then the returned buffer matches what was uploaded

  Scenario: List returns empty for nonexistent prefix
    When listS3Objects() from s3.ts is called with a nonexistent prefix
    Then an empty array is returned

  Scenario: Batch upload multiple objects
    When uploadS3Object() is called multiple times
    Then listS3Objects() returns all uploaded objects
```

### Shared setup (`setup.ts`)

Extend the existing `setup.ts` with two changes:

**1. Re-export our app modules as the primary test API.**

Tests should import from our code, not construct Supabase clients:

```typescript
// Re-export app modules so tests import from setup.ts
export { getAdminClient, getUserClient, queryEvents, showEvent, getStats,
         getEnrichStatus, insertEvent, insertEnrichment, upsertWatchedKey,
         getWatchedKeys, findEventByHash, getPendingEnrichments,
         getModelConfig } from "@/lib/media/db";
export { createS3Client, listS3Objects, downloadS3Object,
         uploadS3Object } from "@/lib/media/s3";

// Test-only helpers that ARE allowed to use Supabase SDK directly:
// - createTestUser() — creates auth users (no app-layer equivalent)
// - cleanupTestData() — deletes all data for a user (admin teardown)
// - seedUserData() — bulk-inserts test fixtures (admin seeding)
```

The rule: **test assertions call our code**; **test setup/teardown can use admin SDK** since user creation and bulk cleanup are test infrastructure, not app behavior.

**2. Keep the existing seed helpers** (`seedUserData`, `assertInsert`, `cleanupUserData`) as-is — these are test-only infra that needs admin access. They stay as raw Supabase SDK calls.

This is the single place where table column lists are maintained for seed data. When a column is added or removed, one file changes — not every test.

### Web server for HTTP-layer tests

**Integration tests that need to validate API routes** (media proxy, WhatsApp webhook, health check) should start the Next.js dev server as part of the vitest global setup:

```typescript
// globalSetup.ts
import { spawn } from "child_process";

export async function setup() {
  // 1. Validate Supabase is running (existing check)
  // 2. Start Next.js dev server
  const server = spawn("npm", ["run", "dev"], { cwd: "web", stdio: "pipe" });
  // Wait for server to be ready (poll http://localhost:3000/api/health)
  // Store server process for teardown
  globalThis.__WEB_SERVER__ = server;
}

export async function teardown() {
  globalThis.__WEB_SERVER__?.kill();
}
```

Tests that exercise HTTP endpoints use `fetch("http://localhost:3000/api/...")` — this validates middleware, auth headers, Next.js routing, and the full request lifecycle. Tests that exercise business logic directly import from `db.ts` / `s3.ts` — faster, no HTTP overhead.

### Removing `skipIf`

Currently, all integration tests use `describe.skipIf(!canRun)` where `canRun` checks for env vars. This means:

- Running `npm run test:integration` without Supabase silently passes with "22 skipped"
- A developer thinks tests passed when they didn't run

**New approach:**
- The vitest integration config files set a custom `test.bail` or use a global setup that validates the environment and fails fast with a clear message: `"Integration tests require a running Supabase instance. Run: supabase start"`
- No `skipIf` in test files. If the integration config is invoked, the tests must run.
- The unit test config (`vitest.config.ts`) already excludes these files, so `npm test` is unaffected.

### CI configuration

The CI workflow (`.github/workflows/ci.yml`) integration test job sequence:

1. Start Supabase (which applies migrations)
2. Extract env vars from `supabase status` → write `.env.local`
3. Create the media S3 bucket
4. **Start Next.js dev server** (needed for HTTP-layer integration tests)
5. Run `npm run test:integration` (single command, all suites)
6. Stop Next.js server on teardown

**Changes needed:**
- Merge `test:integration` and `test:media-integration` into a single vitest config. Consolidate into one config that includes all files in `web/__tests__/integration/` with a 60s timeout.
- Remove the inline FTS smoke test from CI. It duplicates what `media-lifecycle.test.ts` will cover via `queryEvents()`, and inline psql in CI YAML is hard to maintain.
- Single npm script: `npm run test:integration` runs everything.
- The vitest global setup handles starting/stopping the Next.js dev server (not CI YAML), keeping the CI config simple.

### Migration from old to new

| Old file | Disposition |
|----------|-------------|
| `__tests__/rls-policies.test.ts` | Delete. Replaced by `tenant-isolation.test.ts` |
| `__tests__/rpc-user-isolation.test.ts` | Delete. Merged into `tenant-isolation.test.ts` |
| `__tests__/migration-integrity.test.ts` | Delete. Replaced by `schema-contract.test.ts` |
| `__tests__/integration/media-db.test.ts` | Delete. Merged into `media-lifecycle.test.ts` |
| `__tests__/integration/media-pipeline.test.ts` | Delete. Merged into `media-lifecycle.test.ts` |
| `__tests__/integration/media-s3.test.ts` | Rename/rewrite as `media-storage.test.ts` |
| `__tests__/integration/setup.ts` | Keep and extend |

## Constraints

- **No direct Supabase SDK in test assertions.** Tests call our TypeScript modules (`db.ts`, `s3.ts`) or HTTP API routes (`/api/*`). Direct `admin.from()` / `client.rpc()` calls are only allowed in test setup/teardown (user creation, seeding, cleanup).
- Must work on GitHub Actions `ubuntu-latest` with Supabase CLI
- Integration test suite must complete in under 3 minutes (current: ~1 minute)
- Tests must not leave data behind (clean up in `afterAll`)
- No production secrets — tests use local Supabase with default credentials
- Seed helpers must be the single source of truth for table column lists

## Execution Order

1. **Create `schema-contract.test.ts`** — highest value, would have prevented this failure
2. **Create shared `seedUserData()` in `setup.ts`** — prerequisite for suites 2-3
3. **Create `tenant-isolation.test.ts`** — merge and rewrite RLS + RPC tests
4. **Create `media-lifecycle.test.ts`** — merge and rewrite media-db + media-pipeline
5. **Rewrite `media-storage.test.ts`** — BDD naming, minimal changes
6. **Remove `skipIf`, add global setup validation**
7. **Consolidate vitest configs and CI script**
8. **Delete old test files**

Steps 1-2 can be done independently. Steps 3-5 can be parallelized after step 2. Steps 6-8 are cleanup after all suites are green.
