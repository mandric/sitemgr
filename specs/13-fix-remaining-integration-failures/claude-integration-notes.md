# Integration Notes — Opus Review Feedback

## Integrating

### 1. getEnrichStatus overcounting (Section 4)
**Integrating.** The reviewer correctly identified that removing `.eq("content_type", "photo")` entirely means all `create` events (including video, audio, document) count as `total_media`. This is inconsistent with `getPendingEnrichments()` which filters `.like("content_type", "image/%")` and `getStats()` which sums only `image/*` entries. Will add `.like("content_type", "image/%")` to `getEnrichStatus()`.

### 2. Migration comment about grant-plus-body-check pattern (Section 5)
**Integrating.** Adding a comment to the migration explaining the deliberate pattern: `GRANT EXECUTE TO authenticated` remains because the webhook service account uses the authenticated role, but the function body enforces per-caller restrictions.

### 3. CI fallback version comment (Section 1)
**Integrating.** Adding a comment with the last verified version (2.76.4) so future debuggers know what to fall back to if `latest` breaks.

### 4. Line number corrections (Section 4)
**Integrating.** Fixing references to lines 235 and 348.

### 5. Verification command (General)
**Integrating.** Adding a verification section with the exact command to run.

## Not Integrating

### 1. Section 3 error message concern
**Not integrating.** Verified that `requireUserId()` prints "Not logged in. Run 'smgr login' or set SMGR_USER_ID environment variable." — the string "SMGR_USER_ID" is present as a substring, so the test assertion `expect(result.stderr).toContain("SMGR_USER_ID")` will pass.

### 2. E2E test `s3Config` at module scope fragility (Section 2)
**Not integrating.** This is an existing design concern, not introduced by this fix. `getS3Config()` reads env vars which are available at module load time. Out of scope for this fix.

### 3. auth.jwt() behavior documentation for service_role/anon
**Not integrating in plan.** These are correct observations but adding them as plan prose is unnecessary — they're implementation details the reviewer confirmed are already handled correctly. Will add brief SQL comments in the migration.
