# 13-fix-remaining-integration-failures — Implementation Plan

## Overview

Fix 11 test failures across 7 test files, broken into 5 independent root causes (A–E). Fixes are ordered by impact and complexity.

---

## Step 1: Root Cause E — Pin Supabase CLI version in CI

**Files to modify:** `.github/workflows/ci.yml`

**Change:** Pin Supabase CLI to `2.76.4` (minimum version with ES256 JWT fix) in all three `supabase/setup-cli@v1` steps instead of `latest`.

**Why not `latest`:** Pinning ensures reproducible builds and prevents future breakage if a CLI release introduces another regression.

**Fixes:** `local-dev-output.test.ts`, `auth-smoke.test.ts`, `webhook-service-account.test.ts` (3 files, 3 tests)

---

## Step 2: Root Cause B — Add S3 env vars to E2E test

**Files to modify:** `web/__tests__/integration/smgr-e2e.test.ts`

**Change:** Import `getS3Config` from `setup.ts` and add S3 endpoint, region, and AWS credentials to `E2E_ENV`:

```typescript
const s3Config = getS3Config();
const E2E_ENV: Record<string, string> = {
  SMGR_S3_BUCKET: "media",
  SMGR_S3_PREFIX: S3_PREFIX + "/",
  SMGR_AUTO_ENRICH: "false",
  SMGR_S3_ENDPOINT: s3Config.endpoint,
  SMGR_S3_REGION: s3Config.region,
  S3_ACCESS_KEY_ID: s3Config.accessKeyId,
  S3_SECRET_ACCESS_KEY: s3Config.secretAccessKey,
};
```

**Fixes:** All 5 `smgr-e2e.test.ts` failures (1 file, 5 tests)

---

## Step 3: Root Cause A — Isolate HOME in CLI credential test

**Files to modify:** `web/__tests__/integration/smgr-cli.test.ts`

**Change:** Override `HOME` to a fresh temp dir (no credentials file) in the "should fail with exit 1 when SMGR_USER_ID is missing" test:

```typescript
it("should fail with exit 1 when SMGR_USER_ID is missing", async () => {
  const emptyHome = mkdtempSync(resolve(tmpdir(), "smgr-no-creds-"));
  const result = await runCli(["stats"], { SMGR_USER_ID: "", HOME: emptyHome });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("SMGR_USER_ID");
});
```

Need to ensure `mkdtempSync`, `resolve`, `tmpdir` are imported (likely already are from existing test setup).

**Fixes:** 1 test in `smgr-cli.test.ts`

---

## Step 4: Root Cause D — Fix content_type mismatch in getEnrichStatus

**Files to modify:** `web/lib/media/db.ts`

**Change:** In `getEnrichStatus()`, remove the `.eq("content_type", "photo")` filter from the events query. Replace with just `.eq("type", "create")` — count all create events as media since enrichments are already counted without a content_type filter.

```typescript
// Before:
.eq("content_type", "photo")

// After: (remove the line entirely)
```

**Fixes:** 1 test in `media-lifecycle.test.ts`

---

## Step 5: Root Cause C — Guard get_user_id_from_phone with caller check

**Files to create:** `supabase/migrations/20260322000000_restrict_get_user_id_from_phone.sql`

**Change:** New migration that:
1. Keeps `GRANT EXECUTE ... TO authenticated` (needed for webhook service account)
2. Replaces the function body with an internal caller check — only allows `service_role` or the webhook service account (`webhook@sitemgr.internal`)
3. Regular authenticated users get `RAISE EXCEPTION 'permission denied'`

```sql
CREATE OR REPLACE FUNCTION get_user_id_from_phone(p_phone_number TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_caller_email TEXT;
BEGIN
    IF current_setting('role', TRUE) = 'service_role' THEN
        NULL; -- allow
    ELSE
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

**Fixes:** 1 test in `tenant-isolation.test.ts`

---

## Verification

After all fixes, run:
```bash
cd web && npx vitest run --config vitest.integration.config.ts
```

Expected: 0 test files failed, all 125 tests pass, 16 skipped.

## Risk Assessment

- **Steps 1–3:** Zero risk — test-only or CI config changes
- **Step 4:** Low risk — aligns query with actual data semantics
- **Step 5:** Medium risk — modifies a security-critical function, but the change is additive (adds a guard, doesn't remove functionality)
