# TDD Plan: Rename `smgr` to `sitemgr`

This is a rename operation, not a feature addition. The existing test suite IS the test plan — all existing tests must continue to pass after the rename. No new test logic is needed; the tests themselves are being renamed and updated.

## Testing Context

- **Framework:** Vitest (unit + integration), Playwright (E2E)
- **Test commands:** `npm run test` (unit), `npm run test:integration`, `npm run test:e2e`
- **Convention:** Tests in `web/__tests__/`, co-located by tier (`unit/`, `integration/`)

## Section 1: Rename CLI Binary and Update npm Script

**Pre-implementation checks:**
- Verify `npm run smgr -- --help` works before starting (baseline)

**Post-implementation checks:**
- Verify `npm run sitemgr -- --help` produces correct help text with "sitemgr" not "smgr"
- Verify `npm run smgr` no longer exists (exits with npm "missing script" error)
- Spot-check help output contains `sitemgr login`, `sitemgr bucket`, `sitemgr watch` etc.

No new tests needed — existing tests will validate after Section 3 updates them.

## Section 2: Update Library Code (env var reads)

**Post-implementation checks:**
- `grep -rn "SMGR_" web/lib/` should return zero results
- `grep -rn "'smgr " web/lib/` should return zero results

No new tests — existing unit tests for cli-auth and s3 will validate after Section 3 updates env var names.

## Section 3: Rename and Update Test Files

**This is the critical section for TDD.** All test files must be updated to match the new names.

**Pre-implementation verification:**
- List all test files containing `SMGR_` or `smgr`: confirm the inventory matches the plan

**Post-implementation checks:**
- All renamed test files exist at new paths
- Old test file paths no longer exist
- `npm run test` passes (unit tests)
- `npm run test:integration` passes (integration tests)
- No test file contains `SMGR_` env var references
- No test file spawns `bin/smgr.ts`

**Test stubs to verify in renamed files:**
- `sitemgr-cli-auth.test.ts`: device code auth flow still passes with `SITEMGR_WEB_URL`
- `sitemgr-login-command.test.ts`: login command tests pass with updated env vars
- `sitemgr-cli.test.ts`: CLI command tests spawn `bin/sitemgr.ts` correctly
- `sitemgr-e2e.test.ts`: E2E pipeline tests use `SITEMGR_*` env vars
- `cli-auth-device-flow.test.ts`: `SITEMGR_WEB_URL` stub works
- `device-auth.test.ts`: integration test reads `SITEMGR_WEB_URL`

## Section 4: Update Scripts, CI, Config Files

**Post-implementation checks:**
- `grep -rn "SMGR_" scripts/ .github/ Dockerfile .env.example .claude/settings.json` returns zero results
- `scripts/lib.sh` generates `SITEMGR_*` env vars (run the function and check output)
- CI workflow references `SITEMGR_*` vars only

No new tests — CI pipeline itself validates this when it runs.

## Section 5: Update Documentation

**Post-implementation checks:**
- `grep -rn "SMGR_\|npm run smgr\|bin/smgr" README.md docs/TESTING.md CLAUDE.md` returns zero results (excluding historical spec references)
- No `sitesitemgr` anywhere in the repo

No new tests — documentation changes don't need test coverage.

## Final Verification

After all sections complete:
1. `npm run typecheck` passes
2. `npm run lint` passes
3. `npm run test` passes
4. `npm run test:integration` passes
5. `npm run build` succeeds
6. Zero `SMGR_` references outside `specs/` and `node_modules/`
7. Zero `sitesitemgr` anywhere
