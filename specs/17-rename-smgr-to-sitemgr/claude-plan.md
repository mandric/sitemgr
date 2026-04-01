# Implementation Plan: Rename `smgr` to `sitemgr`

## Overview

The sitemgr project uses two names inconsistently: `sitemgr` (repo, config dir) and `smgr` (CLI binary, env vars, npm script). This plan standardizes everything to `sitemgr` with a clean break — no backwards compatibility shim. This is safe because the project is pre-launch (v1).

The rename touches ~25 files across source code, tests, scripts, CI, and documentation. The config directory (`~/.sitemgr/`) is already correct and needs no changes. Spec files under `specs/` are immutable historical records and must not be modified.

## Section 1: Rename CLI Binary and Update npm Script

**What:** Rename `web/bin/smgr.ts` → `web/bin/sitemgr.ts` and update all internal string references.

**Why:** The CLI binary is the most user-visible artifact. It must be renamed first because tests reference it by path.

**Files to modify:**
- `web/bin/smgr.ts` → rename to `web/bin/sitemgr.ts`
- `web/package.json` — change script entry from `"smgr": "tsx bin/smgr.ts"` to `"sitemgr": "tsx bin/sitemgr.ts"`

**Inside `web/bin/sitemgr.ts`** (after rename), replace every occurrence of "smgr" in:
- Comment header and usage examples (top of file)
- Error messages: all instances of `'smgr login'`, `'smgr bucket ...'`, `'smgr watch'`, `'smgr enrich'`, etc.
- Help text block (~L660-713): this is the densest area, ~30 occurrences of "smgr"
- Environment variable reads: `SMGR_WEB_URL` → `SITEMGR_WEB_URL`, `SMGR_DEVICE_ID` → `SITEMGR_DEVICE_ID`, `SMGR_WATCH_INTERVAL` → `SITEMGR_WATCH_INTERVAL`

**Approach:** Use a global find-and-replace within the file. The word "smgr" only appears as the CLI name or env var prefix, so a blanket replacement of `smgr` → `sitemgr` and `SMGR_` → `SITEMGR_` is safe. Verify no double-replacement (`sitemgr` doesn't become `sitesitemgr`) by checking for the substring `sitemgr` before replacing.

## Section 2: Update Library Code (env var reads)

**What:** Update source files that read `SMGR_*` environment variables or reference the CLI name in messages.

**Files:**

1. **`web/lib/auth/cli-auth.ts`**
   - `SMGR_WEB_URL` → `SITEMGR_WEB_URL` (in `resolveApiConfig` or wherever the env var is read)
   - Error messages: `"run 'smgr login' again"` → `"run 'sitemgr login' again"`

2. **`web/lib/media/s3.ts`**
   - `SMGR_S3_ENDPOINT` → `SITEMGR_S3_ENDPOINT`
   - `SMGR_S3_REGION` → `SITEMGR_S3_REGION`

3. **`web/instrumentation.ts`**
   - Console error prefix `[smgr]` → `[sitemgr]`

**Approach:** Each file has only 2-3 occurrences. Targeted replacements rather than bulk find-replace.

## Section 3: Rename and Update Test Files

**What:** Rename 4 test files and update their internal references to use the new binary name and env vars.

**File renames:**
- `web/__tests__/smgr-cli-auth.test.ts` → `sitemgr-cli-auth.test.ts`
- `web/__tests__/unit/smgr-login-command.test.ts` → `sitemgr-login-command.test.ts`
- `web/__tests__/integration/smgr-cli.test.ts` → `sitemgr-cli.test.ts`
- `web/__tests__/integration/smgr-e2e.test.ts` → `sitemgr-e2e.test.ts`

**Inside each test file**, update:
- Subprocess spawn commands: `tsx bin/smgr.ts` → `tsx bin/sitemgr.ts`
- Environment variable names in test setup: `SMGR_WEB_URL` → `SITEMGR_WEB_URL`, `SMGR_DEVICE_ID` → `SITEMGR_DEVICE_ID`, etc.
- String assertions that match CLI output containing "smgr"
- Test descriptions/comments referencing "smgr"

**Also update test infrastructure files:**
- `web/__tests__/integration/globalSetup.ts` — if it reads `SMGR_API_URL` or `SMGR_API_KEY`
- `web/__tests__/integration/setup.ts` — same

**Approach:** Rename files with `git mv` to preserve history. Then do a targeted find-replace within each file.

## Section 4: Update Scripts, CI, Config Files

**What:** Update all infrastructure files that generate, set, or reference `SMGR_*` env vars.

**Files:**

1. **`scripts/lib.sh`**
   - The env var generation block (~L223-241): rename all `SMGR_*` to `SITEMGR_*`
   - Warning message (~L220): `"CLI 'smgr login'"` → `"CLI 'sitemgr login'"`

2. **`scripts/test-integration.sh`**
   - Test file exclusion reference: `smgr-e2e.test.ts` → `sitemgr-e2e.test.ts`

3. **`.github/workflows/ci.yml`**
   - All `SMGR_*` env vars (~L97-100): rename to `SITEMGR_*`
   - Any `${{ env.SMGR_* }}` references (~L103, L128): update

4. **`web/.env.example`**
   - Rename all `SMGR_*` variables and update comment headers

5. **`Dockerfile`**
   - `ENV SMGR_DEVICE_ID=docker` → `ENV SITEMGR_DEVICE_ID=docker`
   - `ENV SMGR_S3_REGION=us-east-1` → `ENV SITEMGR_S3_REGION=us-east-1`
   - `CMD ["bin/smgr.ts", ...]` → `CMD ["bin/sitemgr.ts", ...]`

6. **`.claude/settings.json`**
   - Permission entry: `Bash(npm run smgr*)` → `Bash(npm run sitemgr*)`

## Section 5: Update Documentation

**What:** Update mutable documentation files that reference `smgr`.

**Files:**

1. **`README.md`**
   - Project tree: `bin/smgr.ts` → `bin/sitemgr.ts`
   - All CLI usage examples: `npm run smgr` → `npm run sitemgr`

2. **`docs/TESTING.md`**
   - Env var debug example: `$SMGR_S3_ENDPOINT` → `$SITEMGR_S3_ENDPOINT`
   - Coverage table: "smgr CLI" → "sitemgr CLI"

3. **`CLAUDE.md`** (if any `smgr` references exist outside spec references)
   - Update any `npm run smgr` or `SMGR_*` references

**Do NOT update:**
- Any files under `specs/` — these are immutable historical records
- `design/` docs — these are historical design artifacts

## Execution Order

The sections should be executed in order (1→5) because:
- Section 1 (binary rename) must happen before section 3 (tests reference the binary path)
- Section 2 (lib code) is independent but logically follows the binary
- Section 3 (tests) depends on section 1's rename
- Section 4 (scripts/CI) is independent of code changes but should follow to avoid confusion
- Section 5 (docs) is always last — it documents the final state

## Verification

After all sections are complete:
1. `grep -r "SMGR_" web/ scripts/ .github/ Dockerfile --include="*.ts" --include="*.sh" --include="*.yml" --include="*.json" --include="*.md" --include="Dockerfile"` should return zero results (excluding `specs/`)
2. `grep -r '"smgr' web/ --include="*.ts"` should return zero results
3. All tests pass: `npm run typecheck && npm run lint && npm run test && npm run test:integration`
4. Build succeeds: `npm run build`
