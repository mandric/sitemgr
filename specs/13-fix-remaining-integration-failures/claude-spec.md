# Spec: Fix Remaining Integration Test Failures

## Problem

11 integration test failures across 7 test files on `main`, broken into 5 independent root causes (A–E). These are longstanding issues, not regressions.

## Root Causes

### A — CLI credential fallback masks missing SMGR_USER_ID
The test sets `SMGR_USER_ID: ""` but doesn't override `HOME`, so the credential file fallback in `requireUserId()` succeeds. Fix: override `HOME` to an empty temp dir.

### B — E2E pipeline missing S3 env vars
`E2E_ENV` lacks `SMGR_S3_ENDPOINT`, `SMGR_S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. CLI subprocess defaults to real AWS S3, finds nothing. Fix: pass S3 config from `getS3Config()`.

### C — `get_user_id_from_phone` granted to all authenticated users
Migration 20260321 re-granted EXECUTE to `authenticated` role (needed for webhook service account), but this is too broad. Fix: internal caller check allowing only `service_role` and `webhook@sitemgr.internal`.

### D — content_type mismatch in getEnrichStatus/getStats/getPendingEnrichments
Events store MIME types (`image/jpeg`) but queries filter on `"photo"`. Fix: use `image/%` LIKE prefix or remove content_type filter.

### E — Supabase CLI version incompatibility
GoTrue rejects service role JWTs with older CLI versions. Fix: pin CLI version in CI.

## Interview Decisions

1. **Content type consistency**: Fix test inserts to use MIME types (`image/jpeg`) instead of semantic types (`photo`) for consistency with `seedUserData()`.
2. **JWT check approach**: Use `auth.jwt() ->> 'email'` instead of querying `auth.users` table — faster, no table lookup.
3. **CLI version**: Use `latest` instead of pinning to exact version.
4. **Scope**: Revise the existing implementation (already committed) based on research findings.

## Existing Implementation to Revise

The branch `claude/fix-integration-failures-FZf0Y` has a commit with all 5 fixes. Based on research and interview, three changes need revision:

1. **Migration uses `auth.users` table lookup** → should use `auth.jwt() ->> 'email'` (faster, recommended by Supabase docs)
2. **CI pins to exact `2.76.4`** → should use `latest` per user preference
3. **Content type in FTS test inserts** still uses `"photo"` → should be `"image/jpeg"` for consistency
