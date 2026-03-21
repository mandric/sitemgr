# Code Review Interview: Sections 01-04

**Date:** 2026-03-19

## Auto-fixes Applied

### 1. Add `set -euo pipefail` to extraction step
**Action:** FIX (auto)
**Reason:** If `supabase status -o json` fails, the step should fail immediately rather than writing 'null' values to GITHUB_ENV. Low risk, clear benefit.

### 2. Add 'null' string check to verification step
**Action:** FIX (auto)
**Reason:** `jq -r` returns the literal string "null" for missing JSON keys. The `-z` check alone wouldn't catch this, allowing invalid values to pass verification. Added `|| [ "${!var}" = "null" ]` condition.

## Items Let Go

### 3. STORAGE_S3_URL not in verification list
Pre-existing gap. The media tests don't use S3 env vars directly (they derive S3 config from the Supabase URL). Not worth expanding scope.

### 4. S3 key text parsing fragility
Pre-existing, acknowledged in the plan. Would require Supabase CLI changes to fix properly.

### 5. Bucket creation error suppression
Pre-existing. Out of scope for this task.
