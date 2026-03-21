# TDD Plan: Integration Test Refactor

This document mirrors `claude-plan.md` and defines what tests to write BEFORE implementing each section.

**Testing context:** Existing codebase using Vitest with Supabase integration tests. Testing patterns documented in `claude-research.md`. Tests use `@supabase/supabase-js` client, admin (service role) client for setup, authenticated clients for assertions.

---

## Section 1: Schema Info Migration

No tests to write before this section — this IS a database migration. Validation happens in Section 4 (schema-contract tests that consume the `schema_info()` RPC).

**Verification after migration:**
- `supabase start` applies migration without errors
- `admin.rpc('schema_info')` returns JSON with expected shape
- Function is NOT callable by authenticated or anon clients

---

## Section 2: Global Setup and Environment Validation

**Tests to verify globalSetup behavior:**

- Test: globalSetup succeeds silently when Supabase is running (integration test suite runs normally)
- Test: globalSetup throws descriptive error when Supabase URL is unreachable
- Test: globalSetup throws descriptive error when NEXT_PUBLIC_SUPABASE_URL is not set and default URL is unreachable

**Note:** These are not formal test files — they're manual verification steps. The globalSetup itself is validated by the fact that integration tests either run or fail with a clear message.

---

## Section 3: Shared Seed Layer (setup.ts Extensions)

**Tests for `seedUserData()`:**

- Test: seedUserData creates all expected records (events, enrichments, watched_keys, bucket_config, conversation, user_profile)
- Test: seedUserData with default options creates 2 events with enrichments, watched_keys, bucket_config, conversation
- Test: seedUserData with `eventCount: 0` creates no events or enrichments
- Test: seedUserData with `withBucketConfig: false` skips bucket_config
- Test: seedUserData returns SeedResult with all created IDs
- Test: seedUserData uses deterministic IDs based on userId (same input → same IDs)
- Test: seedUserData for two different users creates non-overlapping data

**Tests for `assertInsert()`:**

- Test: assertInsert passes silently on successful insert result (no error)
- Test: assertInsert throws with descriptive message including description and error details on failed insert
- Test: assertInsert message includes PostgREST error code when available

**Tests for `cleanupUserData()`:**

- Test: cleanupUserData removes all records created by seedUserData
- Test: cleanupUserData handles partial seeds (some tables empty) without throwing
- Test: cleanupUserData logs warnings for cleanup failures via console.warn

**Note:** These tests run against a live local Supabase. They're effectively integration tests of the test infrastructure itself. Write them first, then implement the helpers.

---

## Section 4: Schema Contract Test Suite

**Test stubs for `schema-contract.test.ts`:**

Group 1 — Table existence:
- Test: all expected application tables exist in public schema (events, enrichments, watched_keys, bucket_configs, conversations, user_profiles)

Group 2 — Column contracts:
- Test: events has expected columns (id, timestamp, device_id, type, content_type, content_hash, local_path, remote_path, metadata, parent_id, user_id)
- Test: bucket_configs does NOT have phone_number column
- Test: conversations has user_id as NOT NULL and still has phone_number as nullable
- Test: user_id is NOT NULL on events, enrichments, watched_keys, bucket_configs
- Test: each table's columns match expected types and nullability

Group 3 — Index existence:
- Test: critical indexes exist (idx_enrichments_fts, idx_events_user_id, idx_events_timestamp, idx_bucket_configs_user_bucket, idx_watched_keys_user_id)

Group 4 — RLS enforcement:
- Test: RLS is enabled on all user-data tables (events, enrichments, watched_keys, bucket_configs, conversations, user_profiles)

Group 5 — NOT NULL constraints:
- Test: inserting with user_id: null is rejected on events
- Test: inserting with user_id: null is rejected on enrichments
- Test: inserting with user_id: null is rejected on watched_keys
- Test: inserting with user_id: null is rejected on bucket_configs

Group 6 — RPC function existence:
- Test: search_events RPC exists and accepts expected parameters
- Test: stats_by_content_type RPC exists and accepts expected parameters
- Test: stats_by_event_type RPC exists and accepts expected parameters
- Test: get_user_id_from_phone RPC exists
- Test: schema_info RPC exists and returns expected JSON shape

Group 7 — Policy structure:
- Test: watched_keys does not have redundant SELECT + ALL policies
- Test: enrichments does not have redundant SELECT + ALL policies
- Test: conversations does not have redundant SELECT + ALL policies

---

## Section 5: Tenant Isolation Test Suite

**Test stubs for `tenant-isolation.test.ts`:**

Setup prerequisites:
- beforeAll creates Alice and Bob via createTestUser()
- beforeAll seeds both users via seedUserData() with assertInsert()
- afterAll cleans up via cleanupUserData() + deleteUser()

Group 1 — Read isolation:
- Test: Alice sees only her events (correct count, no Bob data)
- Test: Alice sees only her enrichments
- Test: Alice sees only her watched_keys
- Test: Alice sees only her bucket_configs
- Test: Alice sees only her conversations
- Test: Alice sees only her user_profiles

Group 2 — Write isolation:
- Test: Alice cannot INSERT event with Bob's user_id
- Test: Alice cannot INSERT bucket_config with Bob's user_id
- Test: Alice cannot INSERT enrichment with Bob's user_id
- Test: Alice cannot UPDATE Bob's events
- Test: Alice cannot DELETE Bob's bucket_configs

Group 3 — Anonymous access:
- Test: anon cannot SELECT from events (empty or denied)
- Test: anon cannot SELECT from each of the 6 tables
- Test: anon cannot INSERT into events
- Test: anon cannot INSERT into each of the 6 tables

Group 4 — RPC scoping:
- Test: Alice's search_events returns only her events
- Test: Alice calling search_events with Bob's user_id returns empty
- Test: Alice's stats_by_content_type reflects only her data
- Test: Alice's stats_by_event_type reflects only her data

Group 5 — Service-role restrictions:
- Test: Alice calling get_user_id_from_phone returns permission denied
- Test: anon calling get_user_id_from_phone returns permission denied
- Test: admin calling get_user_id_from_phone succeeds

Group 6 — Append-only enforcement:
- Test: Alice cannot UPDATE her own events
- Test: Alice cannot DELETE her own events

---

## Section 6: Media Lifecycle Test Suite

**Test stubs for `media-lifecycle.test.ts`:**

Setup prerequisites:
- beforeAll creates user with bucket config and S3 bucket
- beforeAll creates second user for isolation test
- afterAll cleans up S3 objects, bucket, user data

Group 1 — Upload and search:
- Test: uploaded photo with enrichment is found via FTS search matching description
- Test: FTS search with non-matching query returns no results

Group 2 — Filtered search:
- Test: search filtered by content_type returns only matching type
- Test: search filtered by date range returns only events within range

Group 3 — Stats:
- Test: stats_by_content_type returns correct counts for user's data
- Test: stats_by_event_type returns correct counts

Group 4 — Enrichment status:
- Test: enrich status shows correct pending vs enriched counts

Group 5 — Watched key upsert:
- Test: upserting same key with new etag updates (not duplicates) the record

Group 6 — Cross-user isolation:
- Test: User A cannot see User B's events via query

---

## Section 7: Media Storage Test Suite

**Test stubs for `media-storage.test.ts`:**

- Test: should upload an object and list it in the bucket
- Test: should download an uploaded object with correct content
- Test: should return empty list for nonexistent prefix
- Test: should upload and list multiple objects

---

## Section 8: Vitest Configuration Consolidation

**Verification tests (not formal test files):**

- Verify: `vitest run --project unit` runs only unit tests, excludes integration/
- Verify: `vitest run --project integration` runs all 4 integration suites
- Verify: `vitest run` runs both projects
- Verify: schema-contract runs first in integration project (file ordering)
- Verify: old config files deleted without breaking any imports

---

## Section 9: CI Workflow Updates

**Verification (CI pipeline):**

- Verify: `npm run test:integration` runs all 4 suites in CI
- Verify: FTS smoke test step removed from ci.yml
- Verify: `npm run test:media-integration` script removed from package.json
- Verify: CI still extracts env vars and verifies them before tests

---

## Section 10: Old File Cleanup

**Verification:**

- Verify: all 7 old test files deleted (rls-policies, rpc-user-isolation, migration-integrity, rls-audit, media-db, media-pipeline, media-s3)
- Verify: old vitest configs deleted
- Verify: `npm test` (unit) still passes after deletion
- Verify: `npm run test:integration` still passes after deletion
- Verify: no orphan imports or references to deleted files
