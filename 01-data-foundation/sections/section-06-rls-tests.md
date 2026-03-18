Now I have all the context needed. Let me produce the section content.

# Section 06: RLS Integration Tests

## Overview

This section creates an integration test suite that runs against a local Supabase instance (`supabase start`) and verifies that Row Level Security policies correctly enforce tenant isolation. The tests cover all six tables: `events`, `enrichments`, `watched_keys`, `bucket_configs`, `conversations`, and `user_profiles`.

**Dependencies:**
- **section-02-rls-audit** must be complete (policies audited and any fixes applied)
- **section-03-client-refactor** must be complete (`getAdminClient()` and `getUserClient()` exist)

**File to create:** `/home/user/sitemgr/web/__tests__/rls-policies.test.ts`

---

## Prerequisites

These tests are **integration tests** that require a running local Supabase instance. They connect to the local Supabase Postgres and Auth services to create real users, insert real data, and verify RLS enforcement.

Before running:
```
cd /home/user/sitemgr && supabase start
```

The tests use the local Supabase URL and keys provided by `supabase status`:
- URL: `http://127.0.0.1:54321`
- Anon key: from `supabase status`
- Service role key: from `supabase status`

Per the project conventions in CLAUDE.md, the Supabase URL and keys for integration tests are set in CI (not via `vi.stubEnv()`) because the tests connect to a real running Supabase instance.

---

## Test Infrastructure

The test file needs helper utilities for creating and authenticating test users. These are internal to the test file (not shared library code).

### Admin Client for Test Setup

Use the service role key (via `getAdminClient()` from section-03) to create test users and seed data. The admin client bypasses RLS, which is necessary for test setup and teardown.

### Test User Creation

Use the Supabase Admin Auth API (`supabase.auth.admin.createUser()`) to create two test users with known UUIDs. Then create authenticated clients for each user using `supabase.auth.signInWithPassword()` or by generating JWTs.

### Test Data Seeding

Insert test data via the admin client (bypasses RLS) so that:
- User A owns a set of records across all tables
- User B owns a separate set of records across all tables

### Teardown

After all tests, delete test data and test users via the admin client.

---

## Tests

The test file `/home/user/sitemgr/web/__tests__/rls-policies.test.ts` should contain the following test cases organized by concern.

### Test Setup Infrastructure

```
Test: test setup creates two distinct authenticated users
Test: test setup creates test data owned by each user
Test: test teardown cleans up test users and data
Test: Supabase client can authenticate as specific test user
```

The `beforeAll` block should:
1. Create two users (User A, User B) via admin auth API
2. Create a `user_profiles` row for each user (with distinct phone numbers)
3. Insert test records into every table (`events`, `enrichments`, `watched_keys`, `bucket_configs`, `conversations`) owned by each user via the admin client
4. Create authenticated Supabase clients for User A and User B

The `afterAll` block should:
1. Delete all test data from each table via admin client
2. Delete both test users via admin auth API

### Cross-Tenant Isolation (per table)

For each of the six tables (`events`, `enrichments`, `watched_keys`, `bucket_configs`, `conversations`, `user_profiles`):

```
Test: user A cannot SELECT user B's events
Test: user A cannot SELECT user B's bucket_configs
Test: user A cannot SELECT user B's enrichments
Test: user A cannot SELECT user B's watched_keys
Test: user A cannot SELECT user B's conversations
Test: user A cannot SELECT user B's user_profiles
```

Each test authenticates as User A, queries the table, and asserts that only User A's records are returned (User B's records are invisible). The expected row count should match the number of records seeded for User A.

### Anon Blocking (per table)

```
Test: anon user cannot SELECT from events table
Test: anon user cannot SELECT from bucket_configs table
Test: anon user cannot SELECT from enrichments table
Test: anon user cannot SELECT from watched_keys table
Test: anon user cannot SELECT from conversations table
Test: anon user cannot SELECT from user_profiles table
```

Create a Supabase client using the anon key with no auth session. Query each table and verify the result is empty (zero rows returned) or an error is returned. The current RLS policies do not have `TO authenticated` restrictions (that is added in section-08), so depending on the policy structure, anon requests may return empty results rather than errors.

### Insert Restrictions

```
Test: user A cannot INSERT event with user B's user_id
Test: user A cannot INSERT bucket_config with user B's user_id
Test: user A cannot INSERT enrichment with user B's user_id
```

Authenticate as User A and attempt to insert a record with `user_id` set to User B's ID. The insert should be rejected by RLS (the `WITH CHECK` clause). Assert that the insert returns an error.

### NULL user_id Safety

```
Test: NULL user_id + NULL phone_number does not grant universal access
```

This test verifies that if a record somehow has `NULL` for both `user_id` and `phone_number`, it is not visible to any authenticated user. Insert such a record via the admin client, then query as User A and User B, and confirm neither sees it.

This is especially important for the `bucket_configs` table which has the dual-auth OR condition in its current policies: `auth.uid() = user_id OR (user_id IS NULL AND phone_number = auth.jwt()->>'phone')`. A record with both fields NULL should NOT match the phone condition (NULL != any phone claim).

### Phone-Based Access (Dual Auth Period)

```
Test: phone_number auth path grants access to matching records only
```

This test is relevant only during the dual-auth transition period (before section-08 removes the phone path). For `bucket_configs` specifically:
1. Insert a record via admin client with `user_id = NULL` and `phone_number` matching User A's phone
2. Authenticate as User A (whose JWT contains the matching phone claim)
3. Query `bucket_configs` and verify User A sees this phone-matched record
4. Authenticate as User B (different phone) and verify User B does NOT see it

### SECURITY DEFINER Function Restrictions

```
Test: get_user_id_from_phone() is not callable by anon role
Test: get_user_id_from_phone() restricted to authorized callers only
```

Create an anon client (no auth) and attempt to call the `get_user_id_from_phone()` RPC. Verify it is either rejected or restricted depending on the fix applied in section-02. If the function has been moved to a private schema or restricted to service role, the anon call should fail.

---

## Test File Structure

The test file at `/home/user/sitemgr/web/__tests__/rls-policies.test.ts` should follow this structure:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";

/**
 * RLS Policy Integration Tests
 *
 * Requires local Supabase running: `supabase start`
 * These tests verify that Row Level Security policies correctly
 * enforce tenant isolation across all tables.
 *
 * Uses real Supabase Auth to create test users and authenticate
 * as different users to verify cross-tenant access is blocked.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY ?? "";

// Admin client (service role) for test setup/teardown — bypasses RLS
// User A client — authenticated as test user A
// User B client — authenticated as test user B
// Anon client — no auth session

describe("RLS Policy Integration Tests", () => {
  // beforeAll: create users, seed data, create auth clients
  // afterAll: cleanup data and users

  describe("test infrastructure", () => {
    // Verify setup created two users and test data
  });

  describe("cross-tenant isolation", () => {
    // Per-table: user A sees own data, not user B's
  });

  describe("anon blocking", () => {
    // Per-table: anon client gets zero results
  });

  describe("insert restrictions", () => {
    // User A cannot insert with user B's user_id
  });

  describe("NULL safety", () => {
    // NULL user_id + NULL phone_number grants no access
  });

  describe("phone-based access", () => {
    // Dual-auth phone path grants access to matching records only
  });

  describe("SECURITY DEFINER restrictions", () => {
    // get_user_id_from_phone() restricted
  });
});
```

---

## Key Implementation Details

### Creating Authenticated Clients

To test RLS as a specific user, create a Supabase client authenticated as that user. The approach:

1. Use the admin client to create a user with `auth.admin.createUser({ email, password, email_confirm: true })`
2. Create a regular client with the anon key
3. Call `client.auth.signInWithPassword({ email, password })` to get an authenticated session
4. The returned client now has the user's JWT and all queries go through RLS

### Test Data Requirements

Each table needs at least one record per user. The test data should use distinct, identifiable values so assertions can verify the correct records are returned.

For `events`, each record needs: `id` (unique TEXT), `timestamp`, `device_id`, `type`, `user_id`.

For `enrichments`, each record needs: `event_id` (must reference an existing event), `description`, `user_id`.

For `watched_keys`, each record needs: `s3_key` (unique TEXT), `first_seen`, `user_id`.

For `bucket_configs`, each record needs: `id` (UUID), `user_id`, `bucket_name`, `region`, `access_key_id`, `secret_access_key`.

For `conversations`, each record needs: `phone_number` (unique TEXT, since it is the primary key), `user_id`.

For `user_profiles`, the user profile records are created as part of user setup, with `id` = the user's auth UUID.

### Handling the Anon Client

The anon client is created with the publishable (anon) key and no `signIn` call. This simulates an unauthenticated request. The client's `auth.uid()` will return NULL, and `auth.jwt()` will have no claims.

### Expected Behavior with Current Policies

Based on the current RLS policies in `/home/user/sitemgr/supabase/migrations/20260306000005_add_rls_policies.sql`:

- `events`, `enrichments`, `watched_keys`, `conversations`: policies use `auth.uid() = user_id` only. Anon users get zero results. Cross-tenant queries return zero results.
- `bucket_configs`: policies use `auth.uid() = user_id OR (user_id IS NULL AND phone_number = auth.jwt()->>'phone')`. This is the dual-auth pattern that needs extra testing for NULL safety.
- `user_profiles`: policies use `auth.uid() = id` (from migration `20260306000003`).

### Running These Tests

These tests should be excluded from the default `vitest run` command (which runs unit tests). Options:

1. Add a separate script in `package.json`: `"test:integration": "vitest run --config vitest.integration.config.ts"`
2. Or use a file naming convention like `*.integration.test.ts` and filter in the main vitest config
3. Or use a test tag/describe skip pattern that checks for Supabase availability

The recommended approach is option 1: create a separate vitest config at `/home/user/sitemgr/web/vitest.integration.config.ts` that includes only `__tests__/rls-policies.test.ts` (and future integration tests) and add a `test:integration` script to `package.json`.

The integration vitest config should be identical to the main config but with an `include` pattern targeting integration test files, and the main config should exclude them.

---

## Files to Create or Modify

| File | Action |
|------|--------|
| `/home/user/sitemgr/web/__tests__/rls-policies.test.ts` | Create — main RLS integration test file |
| `/home/user/sitemgr/web/vitest.integration.config.ts` | Create — vitest config for integration tests |
| `/home/user/sitemgr/web/package.json` | Modify — add `test:integration` script |