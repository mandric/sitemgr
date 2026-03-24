# Implementation Plan: Fix Remaining Integration Test Failures

## Overview

This plan addresses 11 integration test failures across 7 test files, caused by 5 independent root causes. An initial implementation exists on branch `claude/fix-integration-failures-FZf0Y` — this plan identifies four revisions needed based on deeper analysis, external review, and stakeholder input.

The fixes are independent and can be implemented in any order. The plan is organized by root cause, with each section self-contained.

---

## Section 1: Revise Supabase CLI Version in CI (Root Cause E)

### What and Why

Three tests fail because the Supabase CLI's GoTrue container rejects service role JWTs. CLI v2.76.4+ fixed the ES256 JWT signing issue (PR #4821). The existing implementation pins to exact `2.76.4`, but the stakeholder prefers `latest` to automatically receive future fixes.

### Changes Required

**File: `.github/workflows/ci.yml`**

Three `supabase/setup-cli@v1` steps (integration-tests, e2e-tests, deploy jobs) currently have `version: 2.76.4`. Change all three to `version: latest`. Add a comment with the last verified version for rollback reference:

```yaml
- uses: supabase/setup-cli@v1
  with:
    version: latest  # Last verified: 2.76.4 (ES256 JWT fix)
```

### Risk

Using `latest` risks future breakage if a CLI release introduces regressions. If `latest` breaks `supabase start`, the immediate fix is to pin to the last known-good version noted in the comment. CI failures would be caught before merge.

### Tests Fixed

- `local-dev-output.test.ts` — script capability probe
- `auth-smoke.test.ts` — `auth.admin.listUsers()`
- `webhook-service-account.test.ts` — webhook sign-in

---

## Section 2: Add S3 Env Vars to E2E Test (Root Cause B)

### What and Why

The E2E test uploads fixtures to local Supabase Storage via `getS3Config()`, but the `E2E_ENV` object passed to CLI subprocesses lacks S3 endpoint and credentials. The CLI subprocess defaults to real AWS S3, which can't find the locally-uploaded objects. All 5 failures in `smgr-e2e.test.ts` cascade from the first (`watch --once`).

### Changes Required

**File: `web/__tests__/integration/smgr-e2e.test.ts`**

The existing fix correctly calls `getS3Config()` and adds `SMGR_S3_ENDPOINT`, `SMGR_S3_REGION`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` to `E2E_ENV`. No revision needed — this is correct as implemented.

### Tests Fixed

- `watch --once discovers uploaded images`
- `enrich --dry-run lists all pending`
- `enrich --pending processes all images`
- `FTS search for nonsense returns no results`
- `final stats show all enriched`

---

## Section 3: Isolate HOME in CLI Credential Test (Root Cause A)

### What and Why

The test "should fail with exit 1 when SMGR_USER_ID is missing" sets `SMGR_USER_ID: ""` but doesn't override `HOME`. The `requireUserId()` function falls back to `loadCredentials()` which reads `~/.sitemgr/credentials.json` from the test's `tempHome`. Since `beforeAll` writes valid credentials there, the fallback succeeds and the CLI exits 0.

### Changes Required

**File: `web/__tests__/integration/smgr-cli.test.ts`**

The existing fix correctly creates a fresh temp dir with `mkdtempSync` and passes `HOME: emptyHome` alongside `SMGR_USER_ID: ""`. No revision needed.

The CLI error message is: `"Not logged in. Run 'smgr login' or set SMGR_USER_ID environment variable."` — the substring `"SMGR_USER_ID"` is present, so the test assertion `expect(result.stderr).toContain("SMGR_USER_ID")` will pass.

### Tests Fixed

- `should fail with exit 1 when SMGR_USER_ID is missing`

---

## Section 4: Fix content_type Mismatch (Root Cause D)

### What and Why

Events store MIME types (`image/jpeg`, `video/mp4`) but three functions in `web/lib/media/db.ts` filtered on the semantic type `"photo"`:
- `getEnrichStatus()` — `.eq("content_type", "photo")`
- `getStats()` — `contentTypeCounts["photo"] ?? 0`
- `getPendingEnrichments()` — `.eq("content_type", "photo")`

### Changes Required

**File: `web/lib/media/db.ts`** — Revision needed for `getEnrichStatus()`:

The existing fix for `getStats()` and `getPendingEnrichments()` is correct:
- `getStats()`: Changed `contentTypeCounts["photo"]` to sum all `image/*` entries via `Object.entries().filter().reduce()`
- `getPendingEnrichments()`: Changed `.eq("content_type", "photo")` to `.like("content_type", "image/%")`

However, `getEnrichStatus()` was changed to remove the content_type filter entirely, counting **all** `type = "create"` events as `total_media`. This overcounts — video, audio, and document events would inflate `total_media` and `pending`. This is inconsistent with the other two functions.

**Fix:** Add `.like("content_type", "image/%")` to the events query in `getEnrichStatus()`:

```typescript
let eventsQuery = client
  .from("events")
  .select("*", { count: "exact", head: true })
  .eq("type", "create")
  .like("content_type", "image/%");
```

**File: `web/__tests__/integration/smgr-cli.test.ts`** — Content type consistency:
- Line 235: Change `content_type: "photo"` to `content_type: "image/jpeg"` in the FTS test `beforeAll` insert
- Line 348: Change `content_type: "photo"` to `content_type: "image/jpeg"` in the dry-run test `beforeAll` insert

This aligns all test data with the MIME type convention used by `seedUserData()` and the production watch command.

### Tests Fixed

- `media-lifecycle.test.ts` — `should show correct pending and enriched counts`

---

## Section 5: Restrict get_user_id_from_phone with Caller Check (Root Cause C)

### What and Why

Migration `20260321000000_webhook_service_account.sql` re-granted `EXECUTE` on `get_user_id_from_phone` to the entire `authenticated` role. This was needed for the webhook service account but is too broad — any authenticated user can resolve phone → user_id, breaking tenant isolation.

The existing fix creates migration `20260322000000_restrict_get_user_id_from_phone.sql` with a `SECURITY DEFINER` function that checks the caller. However, it uses `SELECT email FROM auth.users WHERE id = auth.uid()` which requires a table lookup. Per research findings and stakeholder decision, use `auth.jwt() ->> 'email'` instead — it reads directly from JWT claims, is faster, and follows Supabase best practices.

### Changes Required

**File: `supabase/migrations/20260322000000_restrict_get_user_id_from_phone.sql`**

Revise the function body to use JWT claims instead of auth.users table lookup. Include comments explaining the deliberate grant-plus-body-check pattern:

```sql
-- SECURITY NOTE: EXECUTE remains granted to 'authenticated' (from migration
-- 20260321000000) because the webhook service account uses the authenticated role.
-- The security boundary is this function body's caller check, NOT the GRANT.
-- If this function is dropped and recreated, ensure the caller check is preserved.

CREATE OR REPLACE FUNCTION get_user_id_from_phone(p_phone_number TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID;
BEGIN
    -- Allow service_role unconditionally
    -- (current_setting with missing_ok=TRUE returns NULL if unset;
    --  NULL = 'service_role' is FALSE, so we safely fall through)
    IF current_setting('role', TRUE) = 'service_role' THEN
        NULL;
    ELSE
        -- Check caller email from JWT claims (no table lookup needed)
        -- For anon callers: auth.jwt() returns NULL, ->> 'email' is NULL,
        -- IS DISTINCT FROM fires — correct fail-closed behavior
        IF (auth.jwt() ->> 'email') IS DISTINCT FROM 'webhook@sitemgr.internal' THEN
            RAISE EXCEPTION 'permission denied for function get_user_id_from_phone';
        END IF;
    END IF;

    SELECT id INTO v_user_id
    FROM public.user_profiles
    WHERE phone_number = p_phone_number;

    RETURN v_user_id;
END;
$$;
```

Key improvements over existing implementation:
1. **`auth.jwt() ->> 'email'`** instead of `auth.users` table query — faster, no I/O
2. **`SET search_path = ''`** — security best practice for SECURITY DEFINER functions (prevents search_path injection)
3. **`public.user_profiles`** — fully qualified table reference (required when search_path is empty)
4. **Security comments** — document the grant-plus-body-check pattern and edge case behavior

### Rollback Safety

This migration only tightens security — the function signature is unchanged. Safe to deploy independently of application code since no callers are affected (webhook continues to work, regular users were already getting errors from the tenant isolation test).

### Tests Fixed

- `tenant-isolation.test.ts` — `should deny Alice access to get_user_id_from_phone`

---

## Implementation Order

All fixes are independent. Suggested order:

1. **Section 5** (migration revision) — Highest impact security change
2. **Section 4** (content_type fixes) — Both db.ts and test fixes needed
3. **Section 1** (CLI version) — Revert to `latest` with fallback comment
4. Sections 2 & 3 — Already correct, no changes needed

## Verification

After all changes, run:
```bash
cd web && npx vitest run --project integration
```

Expected: 0 test files failed, 125 tests passed, 16 skipped.

## Backlog: Migrate Integration Tests to API-Level Testing

The content_type mismatch (Root Cause D) is a symptom of tests inserting data at the wrong abstraction level. Tests call `insertEvent()` directly with hand-crafted `content_type: "photo"`, bypassing the real code path where `detectContentType()` maps file extensions to MIME types like `image/jpeg`. If data entered through the CLI or API routes, this class of bug couldn't occur.

A future spec should:
1. Add integration tests that exercise `/api/*` Next.js routes (the `globalSetup.ts` already starts a dev server)
2. Reduce raw `insertEvent()` / admin client inserts in favor of going through the CLI or API where possible
3. Keep direct-lib and admin-level tests for edge cases (tenant isolation, cross-user seeding) that API routes don't expose

This would make tests less brittle to internal refactors and catch layer integration bugs earlier.

---

## Files Changed (Summary)

| File | Action |
|------|--------|
| `.github/workflows/ci.yml` | Change CLI version to `latest` with fallback comment |
| `web/__tests__/integration/smgr-cli.test.ts` | Change `content_type: "photo"` to `"image/jpeg"` in 2 places |
| `web/lib/media/db.ts` | Add `.like("content_type", "image/%")` to `getEnrichStatus()` |
| `supabase/migrations/20260322000000_restrict_get_user_id_from_phone.sql` | Use `auth.jwt()` claims, add `SET search_path = ''`, add security comments |
| `web/__tests__/integration/smgr-e2e.test.ts` | No change (already correct) |
