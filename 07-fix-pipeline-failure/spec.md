# 07-fix-pipeline-failure — Analysis & Spec

## Executive Summary

**Every CI run on `main` for the last 10+ pushes has failed.** All test jobs (lint, build, unit, integration, E2E) pass successfully. The sole failure is in the **Deploy to Production** job, specifically the `supabase db push` step. The root cause is a database migration that tries to enforce `NOT NULL` on `user_id` columns, but production data contains NULL values that weren't fully backfilled.

There is also one intermittent secondary failure: an integration test (`media integration tests`) failed in one of the 10 runs examined (run `23319524674`), which blocked deploy via the `needs` gate rather than the migration itself.

## Root Cause Analysis

### Primary Failure: Migration `20260315000002_schema_cleanup.sql`

**Error:**
```
ERROR: column "user_id" of relation "bucket_configs" contains null values (SQLSTATE 23502)
At statement: 3
ALTER TABLE bucket_configs ALTER COLUMN user_id SET NOT NULL
```

**Migration chain (in order):**
1. `20260306000002_add_user_id_to_bucket_configs.sql` — Added nullable `user_id` column to `bucket_configs`
2. `20260315000000_backfill_user_id.sql` — Backfills `user_id` via `phone_number → user_profiles` join
3. `20260315000002_schema_cleanup.sql` — Enforces `NOT NULL` on `user_id` across 5 tables, drops `phone_number`

**Why it fails:** The backfill migration (#2) only updates rows where a matching `user_profiles` entry exists (`WHERE bc.phone_number = up.phone_number`). Any `bucket_configs` rows whose `phone_number` doesn't match a `user_profiles` row are left with `user_id = NULL`. When migration #3 then runs `ALTER TABLE bucket_configs ALTER COLUMN user_id SET NOT NULL`, Postgres rejects it because those orphaned rows still have NULL.

**This is a data-dependent migration bug** — it works in CI (local Supabase starts empty, migrations create clean schema) but fails against production (which has pre-existing data with orphaned phone numbers).

### Secondary Issue: Intermittent Integration Test Failure

Run `23319524674` had `Integration Tests (Supabase Local)` fail on the "Run media integration tests" step. This is separate from the migration issue but also blocks deploy since `deploy.needs` includes `integration-tests`. This appears intermittent (1 of 10 runs).

### Structural Problem: CI Reports Green, Deploy Fails

The pipeline design has a fundamental gap: **tests run against a fresh local Supabase instance** (all migrations applied to an empty DB), but **deploy runs migrations against production** (which has existing data). There's no CI step that validates migrations against a production-like dataset.

## Proposed Fix

### Option A: Fix the Migration (Recommended)

Create a new migration that handles the orphaned rows before enforcing NOT NULL. This is the most direct fix.

**New migration: `20260320000000_fix_backfill_orphans.sql`**

This migration must be ordered to run **before** `20260315000002_schema_cleanup.sql` in the pending queue. Since both `20260315000002` and `20260316000000` are the two pending migrations (as shown in the dry-run output), we need to:

1. **Squash/replace** the two pending migrations (`20260315000002_schema_cleanup.sql` and `20260316000000_test_schema_info.sql`) into new migrations that first handle orphans, then enforce constraints.

**OR** (simpler):

2. **Manually fix production data** by running backfill SQL against production, then re-run the pipeline. But this doesn't prevent recurrence and requires manual Supabase access.

**OR** (most robust):

3. **Rewrite `20260315000002_schema_cleanup.sql`** to handle orphans inline — delete or assign orphaned rows before enforcing NOT NULL. Since this migration hasn't been applied to production yet (it's still pending), we can safely modify it.

### Recommended Implementation: Rewrite the Pending Migration

Since `20260315000002_schema_cleanup.sql` has never been applied to production (it's in the pending queue), we can safely modify it to handle orphan rows:

```sql
-- Before enforcing NOT NULL, handle rows that the backfill couldn't resolve
-- (phone_number exists but has no matching user_profiles entry)

-- Option 1: Delete orphaned bucket_configs (if they're truly orphaned/unused)
DELETE FROM bucket_configs WHERE user_id IS NULL;

-- Option 2: Or assign to a default/system user (if data should be preserved)
-- UPDATE bucket_configs SET user_id = '<system-user-uuid>' WHERE user_id IS NULL;

-- Same for other tables
DELETE FROM events WHERE user_id IS NULL;
DELETE FROM enrichments WHERE user_id IS NULL;
DELETE FROM watched_keys WHERE user_id IS NULL;
DELETE FROM conversations WHERE user_id IS NULL;

-- THEN enforce NOT NULL (now safe)
ALTER TABLE events ALTER COLUMN user_id SET NOT NULL;
-- ... etc
```

The choice between DELETE and UPDATE-to-default depends on whether the orphaned production data has value. This needs a product decision.

### Pipeline Hardening (Recommended Follow-up)

To prevent this class of failure in the future:

1. **Add `--dry-run` validation as a separate CI step** that runs earlier (not just in deploy). The dry-run currently runs but doesn't catch data-dependent issues since it only checks schema compatibility, not data constraints.

2. **Add a "migration safety check" step** that validates pending migrations contain guards for data-dependent DDL (e.g., `SET NOT NULL` should be preceded by a `DELETE/UPDATE WHERE ... IS NULL` or wrapped in a `DO $$ ... END $$` block that checks first).

3. **Consider `supabase db push --include-seed` or a staging environment** that has production-like data for testing migrations before they hit production.

## Scope

### In Scope
- Modify `20260315000002_schema_cleanup.sql` to handle NULL `user_id` rows before enforcing NOT NULL
- Verify the fix works with the existing migration chain
- Ensure `20260316000000_test_schema_info.sql` is unaffected

### Out of Scope
- Intermittent integration test flakiness (separate issue)
- Preview environment setup
- Staging/production-like data in CI (future hardening)
- Issues already addressed in `06-fix-ci-pipeline/spec.md` (E2E timeout, tenant-isolation assertions, dangling handles — these appear to have been fixed in PR #37)

## Decision Required

Before implementing, one product decision is needed:

**What should happen to `bucket_configs` rows (and related `events`, `enrichments`, `watched_keys`, `conversations`) where `user_id` is NULL because the phone number doesn't match any `user_profiles` entry?**

- **Option A: Delete them** — They're orphaned data from before web auth migration. Simple, clean.
- **Option B: Preserve them** — Assign to a system/default user, or skip NOT NULL enforcement on those specific rows.
- **Option C: Fail loudly** — Add a pre-check migration that lists orphaned rows and aborts with a human-readable message, so an operator can manually decide.

## Key Files

| File | Change |
|------|--------|
| `supabase/migrations/20260315000002_schema_cleanup.sql` | Add orphan handling before NOT NULL enforcement |
| `.github/workflows/ci.yml` | No changes needed for the primary fix |

## Verification

After the fix:
- `supabase db push --dry-run` should show the two pending migrations
- `supabase db push` should apply both without error
- The Deploy to Production job should go green
- All 6 CI jobs should pass on main
