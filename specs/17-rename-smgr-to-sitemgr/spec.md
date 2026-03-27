# Spec 17: Rename `smgr` to `sitemgr` everywhere

## Problem

The codebase uses two names inconsistently:
- **`sitemgr`**: repo name, config dir (`~/.sitemgr`), project references
- **`smgr`**: CLI binary (`smgr.ts`), env vars (`SMGR_API_URL`, `SMGR_API_KEY`, `SMGR_S3_BUCKET`, etc.), internal references

This causes confusion when reading code, writing docs, and onboarding.

## Goal

Standardize on `sitemgr` everywhere. One name, no abbreviations.

## Scope

### CLI binary
- Rename `web/bin/smgr.ts` to `web/bin/sitemgr.ts`
- Update `package.json` bin entry (if any)
- Update all references in tests, docs, usage text

### Environment variables
- `SMGR_API_URL` → `SITEMGR_API_URL`
- `SMGR_API_KEY` → `SITEMGR_API_KEY`
- `SMGR_S3_BUCKET` → `SITEMGR_S3_BUCKET`
- `SMGR_S3_ENDPOINT` → `SITEMGR_S3_ENDPOINT`
- `SMGR_S3_REGION` → `SITEMGR_S3_REGION`
- `SMGR_S3_PREFIX` → `SITEMGR_S3_PREFIX`
- `SMGR_DEVICE_ID` → `SITEMGR_DEVICE_ID`
- `SMGR_WATCH_INTERVAL` → `SITEMGR_WATCH_INTERVAL`
- `SMGR_AUTO_ENRICH` → `SITEMGR_AUTO_ENRICH`

### Files to update
- `web/bin/smgr.ts` (rename + update all internal references)
- `web/lib/auth/cli-auth.ts` (`resolveApiConfig` reads `SMGR_API_URL`/`SMGR_API_KEY`)
- `web/__tests__/smgr-cli-auth.test.ts` (rename + update)
- `web/__tests__/unit/smgr-login-command.test.ts` (rename + update)
- `web/__tests__/integration/globalSetup.ts` (reads `SMGR_API_URL`/`SMGR_API_KEY`)
- `web/__tests__/integration/setup.ts` (reads `SMGR_API_URL`/`SMGR_API_KEY`)
- `scripts/lib.sh` (generates env vars)
- `scripts/setup.sh`
- `scripts/test-integration.sh`
- `.env.example`
- `CLAUDE.md` (references throughout)
- CI workflow files (`.github/workflows/`)
- Any other files referencing `SMGR_` or `smgr` binary name

### Config directory
- `~/.sitemgr/` — already correct, no change needed

## Acceptance criteria

- [ ] No references to `SMGR_` env vars remain (except in this spec as historical record)
- [ ] CLI binary is `sitemgr` (file renamed, usage text updated)
- [ ] All tests pass with new env var names
- [ ] `.env.example` and env generation scripts updated
- [ ] CLAUDE.md updated

## Notes

- This is a breaking change for anyone with existing `.env` files or scripts using `SMGR_*` vars
- Consider a deprecation period where both names work (read `SITEMGR_*` with fallback to `SMGR_*`) — but for v1 pre-launch, a clean break is simpler
- The config dir `~/.sitemgr/` stays as-is (already uses the full name)
