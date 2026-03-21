# Section 10: Old File Cleanup and Migration

## Overview

Delete old test files and configs after all new suites are green. This is the final step — do NOT delete until all new tests pass.

## Context

After sections 01-09, the codebase has both old and new test files. The old files are no longer referenced by the new vitest config (which uses `--project integration` targeting `__tests__/integration/`), but they still exist on disk. The unit test project may still try to pick up some of them if they're in its include path.

**Prerequisites:**
- All 4 new test suites pass: schema-contract, tenant-isolation, media-lifecycle, media-storage
- Vitest config consolidated (section-08)
- CI workflow updated (section-09)

## What to Delete

### Old test files (7 files)

| File | Why it's safe to delete |
|------|------------------------|
| `web/__tests__/rls-policies.test.ts` | Replaced by `tenant-isolation.test.ts` |
| `web/__tests__/rpc-user-isolation.test.ts` | Merged into `tenant-isolation.test.ts` |
| `web/__tests__/migration-integrity.test.ts` | Replaced by `schema-contract.test.ts` (was all `.todo()`) |
| `web/__tests__/rls-audit.test.ts` | All `it.todo()` stubs absorbed into tenant-isolation + schema-contract. Phone_number auth path tests (Finding 4) are obsolete — phone auth removed in migration `20260315000001`. |
| `web/__tests__/integration/media-db.test.ts` | Merged into `media-lifecycle.test.ts` |
| `web/__tests__/integration/media-pipeline.test.ts` | Merged into `media-lifecycle.test.ts` |
| `web/__tests__/integration/media-s3.test.ts` | Replaced by `media-storage.test.ts` |

### Old vitest configs (2 files)

| File | Why it's safe to delete |
|------|------------------------|
| `web/vitest.integration.config.ts` | Replaced by `--project integration` in unified config |
| `web/vitest.media-integration.config.ts` | Replaced by `--project integration` in unified config |

### Config updates after deletion

After deleting the old files, update the unit project's `exclude` list in `vitest.config.ts`:

**Remove these exclusions (files no longer exist):**
- `__tests__/rls-policies.test.ts`
- `__tests__/rpc-user-isolation.test.ts`
- `__tests__/migration-integrity.test.ts`
- `__tests__/rls-audit.test.ts`

The `__tests__/integration/**` exclusion stays (the integration project handles those files).

## Deletion Order

1. Delete old test files (7 files)
2. Delete old vitest configs (2 files)
3. Update `vitest.config.ts` to remove stale exclusions
4. Verify everything still works

## Verification

After all deletions:

1. **Unit tests pass:**
   ```bash
   cd web && npm test
   ```
   Should run unit tests only, no errors about missing files.

2. **Integration tests pass:**
   ```bash
   cd web && npm run test:integration
   ```
   Should run all 4 new suites.

3. **No orphan imports:**
   ```bash
   grep -r "rls-policies\|rpc-user-isolation\|migration-integrity\|rls-audit\|media-db\|media-pipeline\|media-s3" web/__tests__/ web/vitest.*.ts
   ```
   Should return no results (except possibly in the new test files that reference the old names in comments).

4. **CI clean:**
   Push to a branch and verify the GitHub Actions workflow runs cleanly.

## Files to Create/Modify

| File | Action |
|------|--------|
| `web/__tests__/rls-policies.test.ts` | DELETE |
| `web/__tests__/rpc-user-isolation.test.ts` | DELETE |
| `web/__tests__/migration-integrity.test.ts` | DELETE |
| `web/__tests__/rls-audit.test.ts` | DELETE |
| `web/__tests__/integration/media-db.test.ts` | DELETE |
| `web/__tests__/integration/media-pipeline.test.ts` | DELETE |
| `web/__tests__/integration/media-s3.test.ts` | DELETE |
| `web/vitest.integration.config.ts` | DELETE |
| `web/vitest.media-integration.config.ts` | DELETE |
| `web/vitest.config.ts` | MODIFY — remove stale exclusions |

## Acceptance Criteria

1. All 9 files deleted
2. `npm test` (unit) passes with no missing file errors
3. `npm run test:integration` runs all 4 new suites
4. No orphan references to deleted file names
5. Stale exclusions removed from vitest config
6. CI pipeline runs clean
