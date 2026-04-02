Now I have all the context needed. Here is the section content:

# Section 4: Verification and Cleanup

## Prerequisites

This section depends on all three prior sections being complete:
- **Section 01** (API route integration tests written and passing)
- **Section 02** (mock-heavy unit tests deleted)
- **Section 03** (CLI tests reclassified into `e2e-cli` tier)

Do not begin this section until sections 01, 02, and 03 are all merged or committed.

## Background

After the reorganization work in sections 01-03, the test suite has four tiers: unit, integration, e2e-cli, and e2e-web. This section is a verification pass to confirm everything works end-to-end, clean up any orphaned files, and ensure CI picks up all tiers correctly.

## Verification Checks

All commands run from `/home/user/sitemgr/web`.

### Tests to Run (in order)

```
# Verify: npm run test passes (unit only)
# Verify: npm run test:integration passes
# Verify: npm run test:e2e:cli passes
# Verify: npm run test:e2e passes (Playwright, unchanged)
# Verify: npm run typecheck passes
# Verify: npm run lint passes
# Verify: npm run build passes
# Verify: npm run test:all runs all vitest projects
```

Run each command individually. If any fails, diagnose and fix before proceeding to the next.

### Step 1: Unit tests

```bash
cd /home/user/sitemgr/web && npm run test
```

This runs `vitest run --project unit`. After section 02 deleted ~15 mock-heavy files, only pure-logic tests should remain. Failures here indicate either:
- A remaining test file that imported a deleted helper (e.g., `agent-test-setup.ts`)
- A test file that was supposed to be deleted but was missed
- A type error from a removed dependency

Fix any failures by reading the error output. Common fixes: remove stale imports, delete files that should have been removed in section 02.

### Step 2: Integration tests

```bash
cd /home/user/sitemgr/web && npm run test:integration
```

This runs `vitest run --project integration`. Requires local Supabase running and the Next.js dev server (globalSetup handles the dev server). Failures here indicate:
- A new API route integration test (from section 01) has a bug
- The CLI test files were not fully removed from `__tests__/integration/` (section 03 should have deleted `sitemgr-cli.test.ts` and `sitemgr-e2e.test.ts` from this directory)

Verify that `sitemgr-cli.test.ts` and `sitemgr-e2e.test.ts` no longer appear under `__tests__/integration/`. If they do, delete them.

### Step 3: E2E CLI tests

```bash
cd /home/user/sitemgr/web && npm run test:e2e:cli
```

This runs `vitest run --project e2e-cli`. Same infrastructure as integration (Supabase + dev server). Failures here indicate issues with the merged CLI test files from section 03.

### Step 4: E2E Web tests (Playwright)

```bash
cd /home/user/sitemgr/web && npm run test:e2e
```

Playwright tests. These should be completely unchanged by this spec. If they fail, it is a pre-existing issue, not caused by this work. Note the failure but do not block on it unless it is clearly related to the reorganization.

### Step 5: Typecheck

```bash
cd /home/user/sitemgr/web && npm run typecheck
```

Deleting test files and helpers can leave dangling references. Common typecheck failures after this reorganization:
- Imports of deleted files (e.g., `import { ... } from '../helpers/agent-test-setup'`)
- References to deleted test utilities in `tsconfig.json` includes

### Step 6: Lint

```bash
cd /home/user/sitemgr/web && npm run lint
```

ESLint may flag unused imports or variables after file deletions.

### Step 7: Build

```bash
cd /home/user/sitemgr/web && npm run build
```

Next.js build. Should not be affected by test file changes, but verify.

### Step 8: test:all

```bash
cd /home/user/sitemgr/web && npm run test:all
```

This runs `vitest run` without a `--project` flag, which executes all vitest projects. After section 03 added the `e2e-cli` project to `vitest.config.ts`, this command should run three projects: `unit`, `integration`, and `e2e-cli`.

Verify the output shows all three projects running. If `e2e-cli` is missing, the vitest config was not updated correctly in section 03.

## Cleanup: Orphaned Mock Utilities

After sections 01-03, check for orphaned helper files that are no longer imported by any test.

### File to verify deleted: `/home/user/sitemgr/web/__tests__/helpers/agent-test-setup.ts`

Section 02 should have deleted this file. If it still exists, delete it. Before section 02, this file was imported by:
- `__tests__/s3-actions.test.ts`
- `__tests__/encryption-lifecycle.test.ts`

Both of those test files should have been deleted in section 02. If `agent-test-setup.ts` still exists but has zero importers, delete it.

### Scan for other orphaned helpers

Search for any files under `__tests__/helpers/` that are no longer imported anywhere:

```bash
cd /home/user/sitemgr/web
# For each file in __tests__/helpers/, check if it's imported by any remaining test
for f in __tests__/helpers/*.ts; do
  basename=$(basename "$f" .ts)
  count=$(grep -r "$basename" __tests__/ --include='*.ts' -l | grep -v "$f" | wc -l)
  if [ "$count" -eq 0 ]; then
    echo "ORPHANED: $f"
  fi
done
```

Delete any orphaned helper files found.

### Scan for stale vi.mock references

After deleting mock-heavy tests, there should be no remaining test files that mock Supabase or S3 clients (those belong in integration tests that use real services). Scan:

```bash
cd /home/user/sitemgr/web
grep -r 'vi\.mock.*supabase' __tests__/ --include='*.ts' -l
grep -r 'vi\.mock.*s3' __tests__/ --include='*.ts' -l
```

Any files found should be reviewed. If they are mock-heavy tests that should have been deleted in section 02, delete them. If they are legitimate (e.g., a unit test that mocks only a thin boundary), leave them.

## Verify `test:all` Picks Up All Vitest Projects

The `test:all` script in `package.json` is `vitest run` (no `--project` flag). This runs all projects defined in `vitest.config.ts`. After section 03, the config at `/home/user/sitemgr/web/vitest.config.ts` should have three projects:

1. `unit` - includes `__tests__/**/*.test.ts`, excludes `e2e/**`, `node_modules/**`, `__tests__/integration/**`, and `__tests__/e2e-cli/**`
2. `integration` - includes `__tests__/integration/**/*.test.ts`
3. `e2e-cli` - includes `__tests__/e2e-cli/**/*.test.ts`

Verify this by reading the vitest config file. If `e2e-cli` is missing or the unit project does not exclude `__tests__/e2e-cli/**`, fix the config.

## Test Data Isolation Check

Verify that all new API route integration tests (from section 01) follow proper data isolation:
- Each test file creates its own user via `createTestUser()` or `createTestUserWithToken()` with a unique email (using `Date.now()` or similar)
- Each test file cleans up in `afterAll` via `cleanupUserData()`
- No test file depends on data seeded by another test file

This is a code review check, not an automated test. Read the test files and confirm.

## Files Modified/Deleted in This Section

This section primarily **verifies** rather than creates. Files that may need changes:

- `/home/user/sitemgr/web/__tests__/helpers/agent-test-setup.ts` -- delete if still present (should have been deleted in section 02)
- Any other orphaned helper files found during the scan
- `/home/user/sitemgr/web/vitest.config.ts` -- fix if `e2e-cli` project or unit exclusions are missing
- `/home/user/sitemgr/web/package.json` -- fix `test:all` script if it does not run all projects
- Any remaining test files with stale imports of deleted modules

## Fix Loop Protocol

For each failing check, follow the standard fix loop:

1. Read the error output
2. Diagnose the root cause
3. Fix the code (do not weaken test assertions or disable lint rules)
4. Re-run only the failing check
5. If still failing after 3 genuine attempts with different approaches, escalate with context

Once all eight checks pass, this section and the entire spec 20 implementation is complete.