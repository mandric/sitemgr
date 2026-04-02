Now I have a complete picture. Let me produce the section content.

# Section 3: Rename and Update Test Files

## Overview

This section renames 4 test files from `smgr-*` to `sitemgr-*` and updates all test files (including non-renamed ones) that reference `SMGR_*` environment variables, spawn `bin/smgr.ts`, or contain `smgr` in string literals and describe blocks.

**Dependencies:** Section 1 (CLI binary rename) and Section 2 (library code updates) must be completed first. Tests reference the binary path `bin/sitemgr.ts` and expect `SITEMGR_*` env vars to be read by the library code.

## Substring Hazard

The string `smgr` appears inside the existing word `sitemgr` (e.g., `~/.sitemgr/`). Never use unbounded `smgr` to `sitemgr` replacement. Use targeted replacements:
- `SMGR_` prefix becomes `SITEMGR_`
- `bin/smgr.ts` becomes `bin/sitemgr.ts`
- Standalone `smgr` in string literals, describe blocks, and comments becomes `sitemgr`
- After all replacements, verify no `sitesitemgr` exists

## Pre-Implementation Verification

Before making changes, confirm the file inventory matches expectations:

1. Verify these 4 files exist and will be renamed:
   - `/home/user/sitemgr/web/__tests__/smgr-cli-auth.test.ts`
   - `/home/user/sitemgr/web/__tests__/unit/smgr-login-command.test.ts`
   - `/home/user/sitemgr/web/__tests__/integration/smgr-cli.test.ts`
   - `/home/user/sitemgr/web/__tests__/integration/smgr-e2e.test.ts`

2. Verify these additional files contain `SMGR_` references and need updating (but not renaming):
   - `/home/user/sitemgr/web/__tests__/unit/cli-auth-device-flow.test.ts`
   - `/home/user/sitemgr/web/__tests__/integration/device-auth.test.ts`
   - `/home/user/sitemgr/web/__tests__/integration/globalSetup.ts`
   - `/home/user/sitemgr/web/__tests__/integration/setup.ts`

## File Renames

Use `git mv` to preserve history:

```
git mv web/__tests__/smgr-cli-auth.test.ts web/__tests__/sitemgr-cli-auth.test.ts
git mv web/__tests__/unit/smgr-login-command.test.ts web/__tests__/unit/sitemgr-login-command.test.ts
git mv web/__tests__/integration/smgr-cli.test.ts web/__tests__/integration/sitemgr-cli.test.ts
git mv web/__tests__/integration/smgr-e2e.test.ts web/__tests__/integration/sitemgr-e2e.test.ts
```

## Content Updates Per File

### File: `web/__tests__/sitemgr-cli-auth.test.ts` (renamed from `smgr-cli-auth.test.ts`)

Two changes:
- Line 4: describe block string `"smgr CLI security checks (static analysis)"` becomes `"sitemgr CLI security checks (static analysis)"`
- Line 5: file read path `"bin/smgr.ts"` becomes `"bin/sitemgr.ts"`

### File: `web/__tests__/unit/sitemgr-login-command.test.ts` (renamed from `smgr-login-command.test.ts`)

One change:
- Line 7: path resolve `"../../bin/smgr.ts"` becomes `"../../bin/sitemgr.ts"`

### File: `web/__tests__/integration/sitemgr-cli.test.ts` (renamed from `smgr-cli.test.ts`)

Multiple changes:
- Line 4 comment: `tsx bin/smgr.ts` becomes `tsx bin/sitemgr.ts`
- Line 28: `CLI_PATH` resolve `"../../bin/smgr.ts"` becomes `"../../bin/sitemgr.ts"`
- Line 43: env var `SMGR_WEB_URL` becomes `SITEMGR_WEB_URL`
- Line 44: env var `SMGR_DEVICE_ID` becomes `SITEMGR_DEVICE_ID`
- Line 131: assertion string `"smgr — S3-event-driven media indexer"` becomes `"sitemgr — S3-event-driven media indexer"`
- Line 132: assertion string `"smgr query"` becomes `"sitemgr query"`
- Line 133: assertion string `"smgr stats"` becomes `"sitemgr stats"`
- Line 139: assertion string `"smgr — S3-event-driven media indexer"` becomes `"sitemgr — S3-event-driven media indexer"`
- Lines 145, 171, 223, 277, 319, 336, 367: describe block strings `"smgr stats"`, `"smgr query"`, `"smgr query --search"`, `"smgr show"`, `"smgr enrich --status"`, `"smgr enrich --dry-run"`, `"smgr enrich error cases"` all become `"sitemgr ..."` equivalents

### File: `web/__tests__/integration/sitemgr-e2e.test.ts` (renamed from `smgr-e2e.test.ts`)

Multiple changes:
- Line 33: `CLI_PATH` resolve `"../../bin/smgr.ts"` becomes `"../../bin/sitemgr.ts"`
- Line 53: env var `SMGR_WEB_URL` becomes `SITEMGR_WEB_URL`
- Line 54: env var `SMGR_DEVICE_ID` becomes `SITEMGR_DEVICE_ID`
- Line 97: comment `SMGR_WEB_URL and SMGR_DEVICE_ID` becomes `SITEMGR_WEB_URL and SITEMGR_DEVICE_ID`
- Line 102: describe block `"smgr e2e pipeline"` becomes `"sitemgr e2e pipeline"`

### File: `web/__tests__/unit/cli-auth-device-flow.test.ts` (not renamed)

Two changes:
- Line 49: `vi.stubEnv("SMGR_WEB_URL", ...)` becomes `vi.stubEnv("SITEMGR_WEB_URL", ...)`
- Line 165: test description `"uses SMGR_WEB_URL for fetch calls, not SMGR_API_URL"` becomes `"uses SITEMGR_WEB_URL for fetch calls, not SITEMGR_API_URL"`

### File: `web/__tests__/integration/device-auth.test.ts` (not renamed)

One change:
- Line 14: `process.env.SMGR_WEB_URL` becomes `process.env.SITEMGR_WEB_URL`

### File: `web/__tests__/integration/globalSetup.ts` (not renamed)

Multiple changes:
- Line 53: `SMGR_API_URL: process.env.SMGR_API_URL` becomes `SITEMGR_API_URL: process.env.SITEMGR_API_URL`
- Line 54: `SMGR_API_KEY: process.env.SMGR_API_KEY` becomes `SITEMGR_API_KEY: process.env.SITEMGR_API_KEY`
- Line 73: `process.env.SMGR_API_URL` becomes `process.env.SITEMGR_API_URL`
- Line 74: `process.env.SMGR_API_KEY` becomes `process.env.SITEMGR_API_KEY`
- Line 114: comment referencing `SMGR_*` becomes `SITEMGR_*`
- Line 122: `process.env.SMGR_API_URL` becomes `process.env.SITEMGR_API_URL`
- Line 125: `process.env.SMGR_API_KEY` becomes `process.env.SITEMGR_API_KEY`

### File: `web/__tests__/integration/setup.ts` (not renamed)

Two changes:
- Line 11: `process.env.SMGR_API_URL` becomes `process.env.SITEMGR_API_URL`
- Line 12: `process.env.SMGR_API_KEY` becomes `process.env.SITEMGR_API_KEY`

## Post-Implementation Verification

Run these checks from `/home/user/sitemgr/web`:

1. **Old files gone:** Confirm that none of the 4 original file paths exist:
   ```
   ls web/__tests__/smgr-cli-auth.test.ts web/__tests__/unit/smgr-login-command.test.ts web/__tests__/integration/smgr-cli.test.ts web/__tests__/integration/smgr-e2e.test.ts
   ```
   All should fail (file not found).

2. **New files present:** Confirm the 4 renamed files exist at their new paths.

3. **No remaining SMGR_ references in test files:**
   ```
   grep -rn "SMGR_" web/__tests__/
   ```
   Must return zero results.

4. **No remaining bin/smgr.ts references in test files:**
   ```
   grep -rn "bin/smgr\.ts" web/__tests__/
   ```
   Must return zero results.

5. **No double-replacement (sitesitemgr):**
   ```
   grep -rn "sitesitemgr" web/__tests__/
   ```
   Must return zero results.

6. **Unit tests pass:**
   ```
   npm run test
   ```

7. **Integration tests pass:**
   ```
   npm run test:integration
   ```

## No New Tests Needed

This is a rename operation. The existing test suite IS the validation. All existing tests must continue to pass after the rename with updated references. No new test logic or test files are created.