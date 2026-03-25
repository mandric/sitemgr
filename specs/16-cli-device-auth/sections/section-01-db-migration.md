Now I have all the context I need. Let me generate the section content.

# Section 01: Database Migration -- `device_codes` Table

## Overview

This section creates the `device_codes` table that tracks pending and completed device authorization requests for the CLI device code auth flow. It includes the table schema, indexes, RLS policies, an RPC function for secure anonymous reads, and corresponding integration tests.

**No dependencies.** This section can be implemented in parallel with section-02 (server helpers). It blocks sections 03, 04, 05, and 08.

## Files to Create/Modify

| File | Action |
|------|--------|
| `supabase/migrations/20260325000000_device_codes.sql` | Create |
| `web/__tests__/integration/device-codes-schema.test.ts` | Create |

The migration timestamp follows the existing pattern (YYYYMMDDHHMMSS). Adjust the timestamp if another migration already uses this value.

## Tests First

Create an integration test file at `/home/user/sitemgr/web/__tests__/integration/device-codes-schema.test.ts`. These tests run against real local Supabase (same pattern as `schema-contract.test.ts`).

The test file should use the existing `schema_info()` RPC (via `getAdminClient()` from `__tests__/integration/setup.ts`) to verify structural properties, plus direct Supabase client calls to verify RLS behavior.

### Test Cases

**Schema validation (via `schema_info()` RPC):**

- `device_codes` table exists in the schema and has RLS enabled.
- Table has all expected columns: `id`, `device_code`, `user_code`, `status`, `user_id`, `device_name`, `email`, `token_hash`, `client_ip`, `expires_at`, `created_at`, `approved_at`, `last_polled_at`.
- Partial unique index on `user_code WHERE status = 'pending'` exists (check index name `idx_device_codes_user_code_pending` in the indexes list).
- Unique index on `device_code` exists (check index name `device_codes_device_code_key`).
- Index on `expires_at` exists (check index name `idx_device_codes_expires_at`).
- `get_device_code_status` function exists in the functions list with argument type `text`.

**RPC function behavior (via admin client inserting test rows, then calling RPC as anon):**

- `get_device_code_status()` returns only `status`, `token_hash`, `email`, and `expires_at` for a matching device_code.
- `get_device_code_status()` returns null/empty for a non-existent device_code.

**RLS policy behavior:**

- Anon role can INSERT into `device_codes` (create an anon client with the anon key, insert a row with required fields, expect no error).
- Anon role CANNOT directly SELECT from `device_codes` (create an anon client, attempt `.from("device_codes").select("*")`, expect empty results or an error -- RLS blocks it).
- Service role can UPDATE `device_codes` (use admin client to update a row, expect no error).

### Test Structure

```typescript
/**
 * Schema and RLS tests for device_codes table.
 * Requires `supabase start` running locally.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { getAdminClient, getSupabaseConfig } from "./setup";

// Tests use schema_info() for structural checks and direct
// client calls for RLS behavior verification.
// Each test that inserts rows should clean up in afterAll.
```

Use the `getSupabaseConfig()` helper to get URL and anon key for creating the anon client. Use `getAdminClient()` for service-role operations (inserting test data, calling `schema_info()`, verifying UPDATE access).

For test data, use a unique `device_code` per test (e.g., `test-dc-${Date.now()}-${randomSuffix}`). Clean up inserted rows in `afterAll` via the admin client.

## Migration SQL

Create the file at `/home/user/sitemgr/supabase/migrations/20260325000000_device_codes.sql`.

The migration must contain these elements in order:

### 1. Table Creation

```sql
CREATE TABLE device_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code text NOT NULL UNIQUE,
  user_code text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'expired', 'denied', 'consumed')),
  user_id uuid REFERENCES auth.users(id),
  device_name text,
  email text,
  token_hash text,
  client_ip inet,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  last_polled_at timestamptz
);
```

Key design points:
- `device_code` has a UNIQUE constraint (provides the unique index automatically).
- `user_code` is NOT unique globally -- only unique among pending rows (handled by partial index below).
- `status` uses a CHECK constraint with the five valid states: `pending`, `approved`, `expired`, `denied`, `consumed`.
- `user_id` is nullable because it is only set on approval.
- `token_hash` is nullable because it is only set on approval and nulled after consumption.

### 2. Indexes

```sql
-- Partial unique index: only one pending row per user_code at a time
CREATE UNIQUE INDEX idx_device_codes_user_code_pending
  ON device_codes (user_code) WHERE status = 'pending';

-- Cleanup queries use expires_at
CREATE INDEX idx_device_codes_expires_at
  ON device_codes (expires_at);
```

The unique index on `device_code` is created automatically by the `UNIQUE` constraint on the column. The partial unique index on `user_code WHERE status = 'pending'` ensures no two pending codes share the same user-facing code, while allowing reuse of codes after they are consumed/expired.

### 3. RLS

```sql
ALTER TABLE device_codes ENABLE ROW LEVEL SECURITY;

-- Anon can insert (CLI initiates the flow before authentication)
CREATE POLICY "Anon can initiate device code flow"
  ON device_codes FOR INSERT
  TO anon
  WITH CHECK (true);

-- No SELECT policy for anon. Reads go through the RPC function.
-- Service role bypasses RLS for all operations (approve endpoint updates rows).
```

There is intentionally no anon SELECT policy. The `get_device_code_status()` RPC function (below) is the only path for anonymous reads, and it returns a minimal subset of columns.

### 4. RPC Function

```sql
CREATE OR REPLACE FUNCTION get_device_code_status(p_device_code text)
RETURNS TABLE (
  status text,
  token_hash text,
  email text,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.status,
    dc.token_hash,
    dc.email,
    dc.expires_at
  FROM device_codes dc
  WHERE dc.device_code = p_device_code;
END;
$$;
```

Key design points:
- `SECURITY DEFINER` bypasses RLS, allowing anon to read through this function without a SELECT policy.
- `SET search_path = public` is a security best practice for SECURITY DEFINER functions (prevents search path injection).
- Returns only the four columns the poll endpoint needs -- never exposes `user_id`, `client_ip`, `token_hash` of other users' rows (the function filters by `device_code`, which is 256-bit entropy and only known to the requesting CLI).

### 5. Function Permissions

```sql
-- Allow anon and authenticated to call the RPC function
GRANT EXECUTE ON FUNCTION get_device_code_status(text) TO anon;
GRANT EXECUTE ON FUNCTION get_device_code_status(text) TO authenticated;
```

### 6. Comment

Add a header comment to the migration file explaining its purpose:

```sql
-- Device code authorization flow table.
-- Tracks pending/approved/expired device authorization requests
-- for the CLI device code auth flow (RFC 8628-inspired).
--
-- RLS: anon can INSERT only. All reads go through get_device_code_status() RPC.
-- Service role bypasses RLS for updates (approve endpoint).
```

## On-Access Cleanup Note

The plan specifies that expired rows older than 1 hour should be cleaned up when inserting a new device code. This cleanup logic is NOT in the migration -- it is handled in the API route (section-03, `POST /api/auth/device`). The migration only creates the `expires_at` index to make cleanup queries efficient.

## Updating Existing Schema Contract Tests

The existing `schema-contract.test.ts` at `/home/user/sitemgr/web/__tests__/integration/schema-contract.test.ts` validates all application tables. After this migration, either:

1. Add `device_codes` to the "should have all expected application tables" test in `schema-contract.test.ts`, OR
2. Keep the `device_codes` schema tests self-contained in the new `device-codes-schema.test.ts` file.

Option 2 is recommended to keep this section's changes isolated. The existing schema-contract tests do not need modification -- they test the tables they know about and do not assert an exhaustive list.

## Verification

After applying the migration (`supabase db reset` or `supabase migration up`), run:

```bash
cd /home/user/sitemgr/web && npm run typecheck && npm run lint && npm run test && npm run test:integration && npm run build
```

All five checks must pass. The new integration tests in `device-codes-schema.test.ts` should be picked up automatically by the integration test project configuration.

## Implementation Notes

### Files Created
- `supabase/migrations/20260325000000_device_codes.sql` — Migration SQL (matches plan exactly)
- `web/__tests__/integration/device-codes-schema.test.ts` — Integration tests (12 test cases)

### Deviations from Plan
1. **Tightened anon INSERT policy** — Changed `WITH CHECK (true)` to constrain `status = 'pending' AND user_id IS NULL AND token_hash IS NULL AND approved_at IS NULL AND email IS NULL`. Prevents anon from inserting pre-approved rows directly via Supabase client. (Code review finding, auto-fixed.)
2. **Added column exclusivity assertion** — RPC test now verifies only expected columns are returned (no leakage).
3. **Added negative test** — "anon CANNOT insert with privileged fields" verifies the tightened policy.

### Test Count
12 integration test cases across 3 describe blocks:
- Schema validation (6 tests)
- RPC behavior (2 tests)
- RLS policies (4 tests, including negative test for privileged fields)