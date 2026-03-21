# Section 04: Schema Contract Test Suite

## Overview

Create `web/__tests__/integration/schema-contract.test.ts` — a new test suite that validates the database schema produced by migrations matches what the application code expects. This is the highest-value test in the refactor — it would have caught the `phone_number` column removal that broke production.

## Context

The project has 12 Supabase migrations. The most recent (`20260315000002_schema_cleanup.sql`) dropped `phone_number` from `bucket_configs`, made `user_id` NOT NULL, and migrated `conversations` PK from `phone_number` to `user_id`. The old `migration-integrity.test.ts` was entirely `.todo()` stubs — providing zero protection.

**Prerequisites from earlier sections:**
- Section 01: `schema_info()` RPC function exists (returns tables, columns, indexes, functions, policies)
- Section 02: `globalSetup.ts` validates Supabase connectivity (no `skipIf` needed)
- Section 03: `assertInsert()` available from setup.ts

## What to Build

### File: `web/__tests__/integration/schema-contract.test.ts`

Use BDD naming: `describe('when [context]', () => it('should [behavior]'))`.

### Setup

`beforeAll`:
- Get admin client via `getAdminClient()` from setup.ts
- Call `admin.rpc('schema_info')` once and store the result for all tests
- If the RPC call fails, throw immediately (schema_info migration may not have been applied)

No `afterAll` needed — this suite is mostly read-only.

### Test Group 1: Table existence

```
describe('database tables', () => {
  it('should have all expected application tables')
    // Expected tables: events, enrichments, watched_keys, bucket_configs, conversations, user_profiles
    // Use schema_info.tables array
    // Assert each expected table exists in the result
})
```

### Test Group 2: Column contracts

```
describe('table columns', () => {
  describe('events', () => {
    it('should have all expected columns')
      // Expected: id, timestamp, device_id, type, content_type, content_hash,
      //           local_path, remote_path, metadata, parent_id, user_id
    it('should have user_id as NOT NULL')
  })

  describe('bucket_configs', () => {
    it('should have all expected columns')
      // Expected: user_id, bucket_name, endpoint_url, access_key_id,
      //           secret_access_key, key_version
    it('should NOT have phone_number column')
      // THE key assertion — this is the exact drift that caused the failure
    it('should have user_id as NOT NULL')
  })

  describe('enrichments', () => {
    it('should have all expected columns')
      // Expected: event_id, description, objects, context, tags, fts, user_id
    it('should have user_id as NOT NULL')
  })

  describe('watched_keys', () => {
    it('should have all expected columns')
      // Expected: s3_key, first_seen, event_id, etag, size_bytes, user_id
    it('should have user_id as NOT NULL')
  })

  describe('conversations', () => {
    it('should have user_id as NOT NULL and as primary key')
    it('should still have phone_number as a nullable column')
      // phone_number was NOT dropped from conversations (only from bucket_configs)
  })

  describe('user_profiles', () => {
    it('should have expected columns')
      // Expected: id, phone_number (and whatever other columns exist)
  })
})
```

### Test Group 3: Index existence

```
describe('database indexes', () => {
  it('should have FTS index on enrichments')
    // idx_enrichments_fts
  it('should have user_id index on events')
    // idx_events_user_id
  it('should have timestamp index on events')
    // idx_events_timestamp
  it('should have unique user_bucket index on bucket_configs')
    // idx_bucket_configs_user_bucket
  it('should have user_id index on watched_keys')
    // idx_watched_keys_user_id
})
```

### Test Group 4: RLS enforcement

```
describe('row level security', () => {
  it('should be enabled on all user-data tables')
    // Check RLS flag for: events, enrichments, watched_keys,
    //   bucket_configs, conversations, user_profiles
    // Use schema_info.tables[].has_rls
})
```

### Test Group 5: NOT NULL constraints (application-layer validation)

```
describe('NOT NULL constraints', () => {
  it('should reject events with null user_id')
    // admin.from('events').insert({ ...validEvent, user_id: null })
    // Assert error returned
  it('should reject enrichments with null user_id')
  it('should reject watched_keys with null user_id')
  it('should reject bucket_configs with null user_id')
  // Clean up any accidentally inserted rows in afterEach
})
```

### Test Group 6: RPC function existence

```
describe('RPC functions', () => {
  it('should have search_events with expected parameters')
    // admin.rpc('search_events', { p_user_id: 'test-uuid', p_query: 'test' })
    // Assert no "function does not exist" error
  it('should have stats_by_content_type')
  it('should have stats_by_event_type')
  it('should have get_user_id_from_phone')
  it('should have schema_info')
})
```

### Test Group 7: Policy structure

```
describe('RLS policy structure', () => {
  it('should not have redundant SELECT + ALL policies on watched_keys')
    // Use schema_info.policies to check for policy deduplication
    // After migration cleanup, each table should have clean policy sets
  it('should not have redundant SELECT + ALL policies on enrichments')
  it('should not have redundant SELECT + ALL policies on conversations')
})
```

### Data Handling

- Most tests are metadata checks (no data insertion needed)
- Group 5 (NOT NULL) inserts test data — use `afterEach` to clean up any partial inserts
- Group 6 (RPC existence) calls functions with test parameters — results are irrelevant, only checking the function exists

## Files to Create/Modify

| File | Action |
|------|--------|
| `web/__tests__/integration/schema-contract.test.ts` | CREATE |

## Acceptance Criteria

1. All 7 test groups pass against a fresh `supabase start`
2. `bucket_configs` phone_number assertion catches the exact drift that caused the original failure
3. No `describe.skipIf` — relies on globalSetup for environment validation
4. Uses `schema_info()` RPC for metadata (not direct SQL)
5. Minimal seed data — mostly metadata checks
6. BDD naming throughout
