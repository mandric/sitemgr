# Implementation Plan: Rename `smgr` to `sitemgr`

## Overview

The sitemgr project uses two names inconsistently: `sitemgr` (repo, config dir) and `smgr` (CLI binary, env vars, npm script). This plan standardizes everything to `sitemgr` with a clean break — no backwards compatibility shim. This is safe because the project is pre-launch (v1).

The rename touches ~30 files across source code, tests, scripts, CI, and documentation. The config directory (`~/.sitemgr/`) is already correct and needs no changes. Spec files under `specs/` are immutable historical records and must not be modified.

### Critical: Substring Hazard

The string `smgr` appears inside the existing word `sitemgr` (e.g., `~/.sitemgr/`, `sitemgr.internal`). A naive `sed s/smgr/sitemgr/g` would produce `sitesitemgr`. All replacements must use one of:
- **Targeted prefix matching**: replace `SMGR_` → `SITEMGR_`, `'smgr ` → `'sitemgr `, `"smgr"` → `"sitemgr"`, `bin/smgr.ts` → `bin/sitemgr.ts`
- **Word-boundary matching**: `\bsmgr\b` (but be careful — `smgr` is not always delimited by word boundaries in env var names like `SMGR_`)
- **Never** use unbounded `smgr` → `sitemgr` replacement

The safe approach: replace `SMGR_` with `SITEMGR_` (prefix match), and replace standalone `smgr` only in specific known contexts (CLI name in strings, comments, help text). Always verify no `sitesitemgr` appears after replacement.

## Section 1: Rename CLI Binary and Update npm Script

**What:** Rename `web/bin/smgr.ts` → `web/bin/sitemgr.ts` and update all internal string references.

**Why:** The CLI binary is the most user-visible artifact. It must be renamed first because tests reference it by path.

**Files to modify:**
- `web/bin/smgr.ts` → rename to `web/bin/sitemgr.ts` (use `git mv`)
- `web/package.json` — change script entry from `"smgr": "tsx bin/smgr.ts"` to `"sitemgr": "tsx bin/sitemgr.ts"`

**Inside `web/bin/sitemgr.ts`** (after rename), replace:
- Comment header and usage examples (top of file)
- Error messages: all instances of `'smgr login'`, `'smgr bucket ...'`, `'smgr watch'`, `'smgr enrich'`, etc.
- Help text block (~L660-713): densest area, ~30 occurrences of "smgr"
- Environment variable reads: `SMGR_WEB_URL` → `SITEMGR_WEB_URL`, `SMGR_DEVICE_ID` → `SITEMGR_DEVICE_ID`, `SMGR_WATCH_INTERVAL` → `SITEMGR_WATCH_INTERVAL`

**Approach:** Two-pass replacement: (1) `SMGR_` → `SITEMGR_` for env vars, (2) standalone `smgr` in string literals, comments, and help text → `sitemgr`. Verify no `sitesitemgr` exists afterward.

## Section 2: Update Library Code (env var reads)

**What:** Update source files that read `SMGR_*` environment variables or reference the CLI name in messages.

**Files:**

1. **`web/lib/auth/cli-auth.ts`**
   - `SMGR_WEB_URL` → `SITEMGR_WEB_URL` (env var read)
   - `SMGR_API_URL` → `SITEMGR_API_URL` (if referenced)
   - Error messages: `"run 'smgr login' again"` → `"run 'sitemgr login' again"`

2. **`web/lib/media/s3.ts`**
   - `SMGR_S3_ENDPOINT` → `SITEMGR_S3_ENDPOINT`
   - `SMGR_S3_REGION` → `SITEMGR_S3_REGION`

3. **`web/instrumentation.ts`**
   - Console error prefix `[smgr]` → `[sitemgr]`

**Approach:** Each file has only 2-3 occurrences. Targeted replacements.

## Section 3: Rename and Update Test Files

**What:** Rename 4 test files and update all test files (including non-renamed ones) that reference `smgr`.

**File renames (use `git mv`):**
- `web/__tests__/smgr-cli-auth.test.ts` → `sitemgr-cli-auth.test.ts`
- `web/__tests__/unit/smgr-login-command.test.ts` → `sitemgr-login-command.test.ts`
- `web/__tests__/integration/smgr-cli.test.ts` → `sitemgr-cli.test.ts`
- `web/__tests__/integration/smgr-e2e.test.ts` → `sitemgr-e2e.test.ts`

**Inside each renamed test file**, update:
- Subprocess spawn commands: `tsx bin/smgr.ts` → `tsx bin/sitemgr.ts`
- Environment variable names: `SMGR_WEB_URL` → `SITEMGR_WEB_URL`, `SMGR_DEVICE_ID` → `SITEMGR_DEVICE_ID`, `SMGR_API_URL` → `SITEMGR_API_URL`, `SMGR_API_KEY` → `SITEMGR_API_KEY`, etc.
- String assertions matching CLI output containing "smgr"
- Test descriptions/comments referencing "smgr"

**Additional test files to update (not renamed, but contain SMGR_ references):**
- `web/__tests__/unit/cli-auth-device-flow.test.ts` — has `SMGR_WEB_URL` stub and `SMGR_API_URL` in test description
- `web/__tests__/integration/device-auth.test.ts` — reads `SMGR_WEB_URL` (~line 14)
- `web/__tests__/integration/globalSetup.ts` — reads `SMGR_API_URL`, `SMGR_API_KEY`
- `web/__tests__/integration/setup.ts` — reads `SMGR_API_URL`, `SMGR_API_KEY`

**Approach:** Rename files with `git mv` to preserve history. Then targeted find-replace within each file for `SMGR_` → `SITEMGR_` and `smgr` → `sitemgr` in string contexts.

## Section 4: Update Scripts, CI, Config Files

**What:** Update all infrastructure files that generate, set, or reference `SMGR_*` env vars.

**Files:**

1. **`scripts/lib.sh`**
   - The env var generation block (~L223-241): rename all `SMGR_*` to `SITEMGR_*` (includes `SMGR_API_URL`, `SMGR_API_KEY`, `SMGR_WEB_URL`, `SMGR_S3_ENDPOINT`, `SMGR_S3_BUCKET`, `SMGR_S3_REGION`, `SMGR_DEVICE_ID`, `SMGR_AUTO_ENRICH`)
   - Warning message (~L220): `"CLI 'smgr login'"` → `"CLI 'sitemgr login'"`

2. **`scripts/setup/verify.sh`**
   - 5 references to `SMGR_API_URL` and `SMGR_API_KEY` — rename to `SITEMGR_*`

3. **`scripts/test-integration.sh`**
   - Test file exclusion reference: `smgr-e2e.test.ts` → `sitemgr-e2e.test.ts`

4. **`.github/workflows/ci.yml`**
   - All `SMGR_*` env vars (~L97-100): `SMGR_DEVICE_ID`, `SMGR_AUTO_ENRICH`, `SMGR_OLLAMA_URL`, `SMGR_VISION_MODEL` → `SITEMGR_*`
   - Any `${{ env.SMGR_* }}` references (~L103, L128): update to `SITEMGR_*`

5. **`web/.env.example`**
   - Rename all `SMGR_*` variables (`SMGR_WEB_URL`, `SMGR_DEVICE_ID`) and update comment headers

6. **`Dockerfile`** (repo root)
   - `ENV SMGR_DEVICE_ID=docker` → `ENV SITEMGR_DEVICE_ID=docker`
   - `ENV SMGR_S3_REGION=us-east-1` → `ENV SITEMGR_S3_REGION=us-east-1`
   - `CMD ["bin/smgr.ts", ...]` → `CMD ["bin/sitemgr.ts", ...]`

7. **`.claude/settings.json`**
   - Permission entry: `Bash(npm run smgr*)` → `Bash(npm run sitemgr*)`

**Note:** `.env.local` is auto-regenerated by `scripts/lib.sh`, so existing local dev setups will self-heal on next `npm run setup:env`. No manual intervention needed for local `.env.local` files.

## Section 5: Update Documentation

**What:** Update mutable documentation files that reference `smgr`.

**Files:**

1. **`README.md`**
   - Project tree: `bin/smgr.ts` → `bin/sitemgr.ts`
   - All CLI usage examples: `npm run smgr` → `npm run sitemgr`

2. **`docs/TESTING.md`**
   - Env var debug example: `$SMGR_S3_ENDPOINT` → `$SITEMGR_S3_ENDPOINT`
   - Coverage table: "smgr CLI" → "sitemgr CLI"

3. **`CLAUDE.md`**
   - Update `Bash(npm run smgr*)` reference (if present beyond settings.json)
   - Update any `SMGR_*` env var references
   - Update any CLI usage examples

**Do NOT update:**
- Any files under `specs/` — immutable historical records per CLAUDE.md
- `design/` docs — historical design artifacts

## Execution Order

The sections should be executed in order (1→5) because:
- Section 1 (binary rename) must happen before section 3 (tests reference the binary path)
- Section 2 (lib code) is independent but logically follows the binary
- Section 3 (tests) depends on section 1's rename
- Section 4 (scripts/CI) is independent of code changes but should follow to avoid confusion
- Section 5 (docs) is always last — it documents the final state

## Verification

After all sections are complete:
1. **No double-replacements:** `grep -r "sitesitemgr" web/ scripts/ .github/ Dockerfile CLAUDE.md README.md docs/` — must return zero results
2. **No remaining SMGR_ references:** `grep -rn "SMGR_" web/ scripts/ .github/ Dockerfile CLAUDE.md README.md docs/ .env.example --include="*.ts" --include="*.sh" --include="*.yml" --include="*.json" --include="*.md" --include="Dockerfile" --include=".env.example"` — must return zero results (excluding `specs/` and `node_modules/`)
3. **No remaining smgr CLI references:** `grep -rn "'smgr\b\|\"smgr\b" web/ --include="*.ts"` — must return zero results
4. **All tests pass:** `npm run typecheck && npm run lint && npm run test && npm run test:integration`
5. **Build succeeds:** `npm run build`
