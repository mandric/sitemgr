# 13-fix-remaining-integration-failures — Spec

## Overview

Fix the 9 remaining integration test failures (across 7 test files) that are pre-existing on `main`. These break down into 4 independent root causes. None are regressions from spec 12 — they are longstanding issues that have been masked or accumulated over time.

## Current Failures

Both `main` and `claude/fix-pipeline-O8zyY` show identical results: **7 files failed, 9 tests failed, 116 passed, 16 skipped**.

| # | Test File | Test Name | Error | Root Cause |
|---|-----------|-----------|-------|------------|
| 1 | `smgr-cli.test.ts` | should fail with exit 1 when SMGR_USER_ID is missing | `expected +0 to be 1` | A — credentials fallback |
| 2 | `smgr-e2e.test.ts` | watch --once discovers uploaded images | exit code 1 | B — missing S3 env vars |
| 3 | `smgr-e2e.test.ts` | enrich --dry-run lists all pending | exit code 1 | B — cascade from #2 |
| 4 | `smgr-e2e.test.ts` | enrich --pending processes all images | exit code 1 | B — cascade from #2 |
| 5 | `smgr-e2e.test.ts` | FTS search for nonsense returns no results | exit code 1 | B — cascade from #2 |
| 6 | `smgr-e2e.test.ts` | final stats show all enriched | exit code 1 | B — cascade from #2 |
| 7 | `tenant-isolation.test.ts` | should deny Alice access to get_user_id_from_phone | `expected null not to be null` | C — overly broad GRANT |
| 8 | `media-lifecycle.test.ts` | should show correct pending and enriched counts | `expected -2 to be >= 1` | D — content_type mismatch |
| 9 | `local-dev-output.test.ts` | print_setup_env_vars | Service role key rejected by GoTrue (HTTP 500) | E — Supabase CLI version |
| 10 | `auth-smoke.test.ts` | can list users via auth.admin API | `code: "unexpected_failure"` | E — Supabase CLI version |
| 11 | `webhook-service-account.test.ts` | (entire file) | Webhook sign-in failed: Database error querying schema | E — Supabase CLI version |

---

## Root Cause A — `smgr stats` exits 0 when SMGR_USER_ID is empty

**Affected tests:** 1 (`smgr-cli.test.ts`)

### Analysis

The test calls `runCli(["stats"], { SMGR_USER_ID: "" })` and expects exit code 1. But the CLI exits 0.

**Why:** `requireUserId()` in `web/bin/smgr.ts:106-118` checks `process.env.SMGR_USER_ID` first (empty string is falsy → falls through), then falls back to `loadCredentials()` which reads `~/.sitemgr/credentials.json`. The test's `cliEnv()` helper sets `HOME: tempHome` — and `beforeAll` writes a valid credentials file to `tempHome/.sitemgr/credentials.json`. So the fallback succeeds and the CLI runs happily with the credential-file user ID.

The test overrides `SMGR_USER_ID` to empty string but does **not** override `HOME`, so the subprocess still sees the credentials file.

### Fix

**Option 1 (fix the test):** Override `HOME` to a fresh temp directory with no credentials file:
```typescript
it("should fail with exit 1 when SMGR_USER_ID is missing", async () => {
  const emptyHome = mkdtempSync(resolve(tmpdir(), "smgr-no-creds-"));
  const result = await runCli(["stats"], { SMGR_USER_ID: "", HOME: emptyHome });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("SMGR_USER_ID");
});
```

**Option 2 (fix the test name):** Rename to "should fail with exit 1 when not authenticated" since the intent is testing the "no auth available" path, not specifically the env var.

**Recommendation:** Option 1. The test intent is clear — test the "no credentials anywhere" path. It just needs proper isolation.

### Key Files
- `web/__tests__/integration/smgr-cli.test.ts` (lines 164-168)
- `web/bin/smgr.ts` (lines 106-118, `requireUserId()`)
- `web/lib/auth/cli-auth.ts` (lines 34-41, `loadCredentials()`)

---

## Root Cause B — E2E pipeline missing S3 endpoint env vars

**Affected tests:** 5 (`smgr-e2e.test.ts` — all failures cascade from the first)

### Analysis

The `smgr-e2e.test.ts` beforeAll uploads 3 JPEG fixtures to Supabase Storage using `getS3Config()` which returns the correct local S3 endpoint (`http://127.0.0.1:54321/storage/v1/s3`). However, when it invokes the CLI via `runCli(["watch", "--once"], { ...E2E_ENV, SMGR_S3_BUCKET: "media" })`, the `E2E_ENV` object is:

```typescript
const E2E_ENV: Record<string, string> = {
  SMGR_S3_BUCKET: "media",
  SMGR_S3_PREFIX: S3_PREFIX + "/",
  SMGR_AUTO_ENRICH: "false",
};
```

Missing: `SMGR_S3_ENDPOINT` and `SMGR_S3_REGION`.

The CLI's `createS3Client()` in `web/lib/media/s3.ts:35-37` falls back to `process.env.SMGR_S3_ENDPOINT`. Without it, the AWS SDK defaults to real AWS S3, which obviously can't find the locally-uploaded fixtures. The watch command finds 0 objects, and all downstream tests (enrich, search, stats) cascade-fail.

### Fix

Add S3 endpoint and region to `E2E_ENV`:

```typescript
const E2E_ENV: Record<string, string> = {
  SMGR_S3_BUCKET: "media",
  SMGR_S3_PREFIX: S3_PREFIX + "/",
  SMGR_AUTO_ENRICH: "false",
  SMGR_S3_ENDPOINT: getS3Config().endpoint,  // http://127.0.0.1:54321/storage/v1/s3
  SMGR_S3_REGION: "local",
};
```

Also need to pass AWS credentials so the S3 client can authenticate:

```typescript
const s3Config = getS3Config();
const E2E_ENV: Record<string, string> = {
  SMGR_S3_BUCKET: "media",
  SMGR_S3_PREFIX: S3_PREFIX + "/",
  SMGR_AUTO_ENRICH: "false",
  SMGR_S3_ENDPOINT: s3Config.endpoint,
  SMGR_S3_REGION: s3Config.region,
  S3_ACCESS_KEY_ID: s3Config.credentials.accessKeyId,
  S3_SECRET_ACCESS_KEY: s3Config.credentials.secretAccessKey,
};
```

### Key Files
- `web/__tests__/integration/smgr-e2e.test.ts` (lines 95-101, `E2E_ENV`)
- `web/__tests__/integration/setup.ts` (lines 78-86, `getS3Config()`)
- `web/lib/media/s3.ts` (lines 35-58, `createS3Client()`)

---

## Root Cause C — `get_user_id_from_phone` granted to all authenticated users

**Affected tests:** 1 (`tenant-isolation.test.ts`)

### Analysis

Migration `20260313000000_rpc_user_isolation.sql` correctly restricts `get_user_id_from_phone` to `service_role` only:

```sql
REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) TO service_role;
```

But later migration `20260321000000_webhook_service_account.sql` re-grants it:

```sql
-- Grant get_user_id_from_phone to authenticated role
GRANT EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) TO authenticated;
```

This grants the function to **all** authenticated users, not just the webhook service account. Alice (a regular authenticated user) can now call the function, so `error` is `null` and the test fails.

### Fix

The webhook service account needs access to `get_user_id_from_phone`, but granting to the entire `authenticated` role is too broad. Postgres doesn't support per-user GRANTs on functions directly — permissions are role-based. Two options:

**Option 1 (recommended) — Guard inside the function body:**

Create a new migration that revokes the broad grant and adds an internal check:

```sql
-- Revoke the overly broad grant
REVOKE EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_user_id_from_phone(TEXT) TO authenticated;

-- Replace function to include caller check
CREATE OR REPLACE FUNCTION get_user_id_from_phone(p_phone_number TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_caller_email TEXT;
BEGIN
    -- Only allow service_role or the webhook service account
    IF current_setting('role', TRUE) = 'service_role' THEN
        -- Service role: allow
        NULL;
    ELSE
        -- Check if caller is the webhook service account
        SELECT email INTO v_caller_email
        FROM auth.users WHERE id = auth.uid();

        IF v_caller_email IS DISTINCT FROM 'webhook@sitemgr.internal' THEN
            RAISE EXCEPTION 'permission denied for function get_user_id_from_phone';
        END IF;
    END IF;

    SELECT id INTO v_user_id
    FROM user_profiles
    WHERE phone_number = p_phone_number;

    RETURN v_user_id;
END;
$$;
```

**Option 2 — Keep revoked from authenticated, use service_role in webhook handler:**

Revert the grant and have the webhook handler use a different mechanism (e.g., pass user_id directly instead of resolving from phone). This is a larger change and affects the webhook route.

**Recommendation:** Option 1. It's surgical, doesn't affect the webhook handler, and maintains the principle of least privilege.

### Key Files
- `supabase/migrations/20260313000000_rpc_user_isolation.sql` (lines 75-79)
- `supabase/migrations/20260321000000_webhook_service_account.sql` (lines 109-112)
- `web/__tests__/integration/tenant-isolation.test.ts` (lines 256-263)

---

## Root Cause D — `getEnrichStatus` content_type mismatch

**Affected tests:** 1 (`media-lifecycle.test.ts`)

### Analysis

`getEnrichStatus()` in `web/lib/media/db.ts:261-297` counts events with `.eq("content_type", "photo")` but counts enrichments without any content_type filter. The test creates events with MIME types (`image/jpeg`, `video/mp4`), never `"photo"`.

Result: `total = 0` (no events match `content_type = "photo"`), `enriched = 2`, so `pending = 0 - 2 = -2`.

The mismatch exists because events are stored with MIME content types (`image/jpeg`) but the query filters for the semantic type `"photo"`. These were likely out of sync since the beginning.

### Fix

Change `getEnrichStatus` to filter by MIME type prefix instead of the literal `"photo"`:

```typescript
let eventsQuery = client
  .from("events")
  .select("*", { count: "exact", head: true })
  .eq("type", "create")
  .like("content_type", "image/%");
```

Or, if the intent is to count all media (photos + videos), remove the content_type filter entirely and just count `type = "create"` events:

```typescript
let eventsQuery = client
  .from("events")
  .select("*", { count: "exact", head: true })
  .eq("type", "create");
```

The enrichments query should also be scoped to match — either by joining to events or by filtering enrichments whose linked event has the matching content_type.

**Recommendation:** Remove the `content_type` filter from events query (count all "create" events as media) since the enrichment count already includes all enrichments regardless of type. This makes `pending` correct: `total_create_events - enriched_count`.

### Key Files
- `web/lib/media/db.ts` (lines 261-297, `getEnrichStatus()`)
- `web/__tests__/integration/media-lifecycle.test.ts` (lines 236-239)
- `web/__tests__/integration/setup.ts` (line 176, event seeding uses `"image/jpeg"`)

---

## Root Cause E — Supabase CLI version incompatibility (GoTrue JWT rejection)

**Affected tests:** 3 (`local-dev-output.test.ts`, `auth-smoke.test.ts`, `webhook-service-account.test.ts`)

### Analysis

Three tests fail because the Supabase CLI version in CI generates service role key JWTs that GoTrue rejects with HTTP 500. This is a known issue documented in spec 11:

- Supabase CLI ≥ 2.78 switched GoTrue to ES256 JWT signing
- CLI versions 2.71–2.76.3 had a bug where `auth.admin.*` calls fail ([supabase/cli#4818](https://github.com/supabase/cli/issues/4818))
- CLI ≥ 2.76.4 fixed this

The failures cascade:

1. **`local-dev-output.test.ts`**: `scripts/local-dev.sh` capability probe curls GoTrue admin endpoint with service role key → HTTP 500 → script exits 1 → test fails.

2. **`auth-smoke.test.ts`**: `admin.auth.admin.listUsers()` calls GoTrue admin endpoint → `"Database error finding users"`, `code: "unexpected_failure"` → test fails.

3. **`webhook-service-account.test.ts`**: `webhookClient.auth.signInWithPassword()` fails with `"Database error querying schema"` → entire test file throws in `beforeAll` → all tests in file skip/fail.

### Fix

Pin Supabase CLI to >= 2.76.4 in CI:

```yaml
# .github/workflows/ci.yml
- uses: supabase/setup-cli@v1
  with:
    version: 2.76.4  # Minimum version with ES256 JWT fix
```

Or use `latest` if the project tracks latest:

```yaml
- uses: supabase/setup-cli@v1
  with:
    version: latest
```

Also add a version check in `scripts/local-dev.sh` to give a clearer error message (already partially done — the capability probe catches it, but the version recommendation could be more precise).

### Key Files
- `.github/workflows/ci.yml` (Supabase CLI setup step)
- `scripts/local-dev.sh` (lines 65-79, capability probe)
- `web/__tests__/integration/auth-smoke.test.ts` (lines 29-33)
- `web/__tests__/integration/webhook-service-account.test.ts` (lines 45-51)
- `web/__tests__/integration/local-dev-output.test.ts` (lines 14-18)

---

## Implementation Order

These fixes are independent and can be implemented in any order (or in parallel). Suggested priority:

1. **Root Cause E** (Supabase CLI version) — Fixes 3 test files, likely a one-line CI change
2. **Root Cause B** (S3 env vars) — Fixes 5 tests in one file, straightforward env var addition
3. **Root Cause A** (credentials fallback) — Fixes 1 test, simple test isolation fix
4. **Root Cause D** (content_type mismatch) — Fixes 1 test, requires care to align query semantics
5. **Root Cause C** (RLS grant) — Fixes 1 test, requires a new migration with security implications

## Expected Outcome

After all fixes: **0 test files failed, 10 test files passed, 0 tests failed, 141 tests (125 passed + 16 skipped)**.

## Dependencies

- Spec 12 (env var fix for `NEXT_PUBLIC_*`) — already implemented and merged
- Spec 11 (service-role-key-audit) — already implemented, created the conditions for Root Cause E
- No forward dependencies — this is a stabilization spec
