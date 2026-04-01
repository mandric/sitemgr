# Spec 17: Rename `smgr` to `sitemgr` Everywhere

## Problem

The codebase uses two names inconsistently: `sitemgr` (repo name, config dir) and `smgr` (CLI binary, env vars, npm script, internal references). This causes confusion.

## Goal

Standardize on `sitemgr` everywhere. Clean break, no backwards compatibility shim.

## Scope

### 1. File Renames (5 files)

| Old Path | New Path |
|----------|----------|
| `web/bin/smgr.ts` | `web/bin/sitemgr.ts` |
| `web/__tests__/smgr-cli-auth.test.ts` | `web/__tests__/sitemgr-cli-auth.test.ts` |
| `web/__tests__/unit/smgr-login-command.test.ts` | `web/__tests__/unit/sitemgr-login-command.test.ts` |
| `web/__tests__/integration/smgr-cli.test.ts` | `web/__tests__/integration/sitemgr-cli.test.ts` |
| `web/__tests__/integration/smgr-e2e.test.ts` | `web/__tests__/integration/sitemgr-e2e.test.ts` |

**Note:** Spec files under `specs/` are immutable historical records — do NOT rename.

### 2. Environment Variables (all SMGR_ → SITEMGR_)

| Old | New |
|-----|-----|
| `SMGR_WEB_URL` | `SITEMGR_WEB_URL` |
| `SMGR_DEVICE_ID` | `SITEMGR_DEVICE_ID` |
| `SMGR_WATCH_INTERVAL` | `SITEMGR_WATCH_INTERVAL` |
| `SMGR_S3_ENDPOINT` | `SITEMGR_S3_ENDPOINT` |
| `SMGR_S3_REGION` | `SITEMGR_S3_REGION` |
| `SMGR_S3_BUCKET` | `SITEMGR_S3_BUCKET` |
| `SMGR_API_URL` | `SITEMGR_API_URL` |
| `SMGR_API_KEY` | `SITEMGR_API_KEY` |
| `SMGR_AUTO_ENRICH` | `SITEMGR_AUTO_ENRICH` |
| `SMGR_OLLAMA_URL` | `SITEMGR_OLLAMA_URL` |
| `SMGR_VISION_MODEL` | `SITEMGR_VISION_MODEL` |

### 3. NPM Script

`package.json` script `"smgr"` → `"sitemgr"`, pointing to new `bin/sitemgr.ts`.

### 4. Source Code Updates

**`web/bin/sitemgr.ts`** (after rename):
- Comment header, usage examples
- All error messages referencing "smgr" (login prompts, help text, bucket commands)
- Help text block (~50 lines)
- Env var reads: `SMGR_WEB_URL`, `SMGR_DEVICE_ID`, `SMGR_WATCH_INTERVAL`

**`web/lib/auth/cli-auth.ts`**:
- `SMGR_WEB_URL` env var read
- Error messages: "run 'smgr login' again"

**`web/lib/media/s3.ts`**:
- `SMGR_S3_ENDPOINT`, `SMGR_S3_REGION` env var reads

**`web/instrumentation.ts`**:
- Console error prefix `[smgr]` → `[sitemgr]`

### 5. Test Files (after rename)

- `sitemgr-cli-auth.test.ts`: Update all string references to `smgr`
- `sitemgr-login-command.test.ts`: Update string references
- `sitemgr-cli.test.ts`: Update subprocess command (`tsx bin/sitemgr.ts`), env var names
- `sitemgr-e2e.test.ts`: Update subprocess command, env var names

### 6. Config & Scripts

- **`.env.example`**: Rename all `SMGR_*` vars, update comments
- **`Dockerfile`**: Update env vars (`SMGR_DEVICE_ID`, `SMGR_S3_REGION`), CMD path
- **`.claude/settings.json`**: Update `Bash(npm run smgr*)` → `Bash(npm run sitemgr*)`
- **`scripts/lib.sh`**: Update env var generation block, warning message
- **`scripts/test-integration.sh`**: Update test file reference
- **`.github/workflows/ci.yml`**: Update all `SMGR_*` env var names

### 7. Documentation (mutable files only)

- **`README.md`**: Update project tree, CLI usage examples
- **`docs/TESTING.md`**: Update env var references, coverage table

### 8. Out of Scope

- `~/.sitemgr/` config directory — already correct
- Files under `specs/` — immutable historical records
- No backwards compatibility / deprecation / fallback logic

## Acceptance Criteria

- No references to `SMGR_` env vars remain in non-spec files
- CLI binary is `sitemgr` (file renamed, usage/help text updated)
- NPM script is `npm run sitemgr`
- All tests pass with new names
- `.env.example`, Dockerfile, CI workflow, and scripts updated
- CLAUDE.md and README updated
