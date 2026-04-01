# Codebase Research: smgr → sitemgr Rename

## Files to Rename (7 files)

| File | New Name |
|------|----------|
| `web/bin/smgr.ts` | `web/bin/sitemgr.ts` |
| `web/__tests__/smgr-cli-auth.test.ts` | `web/__tests__/sitemgr-cli-auth.test.ts` |
| `web/__tests__/unit/smgr-login-command.test.ts` | `web/__tests__/unit/sitemgr-login-command.test.ts` |
| `web/__tests__/integration/smgr-cli.test.ts` | `web/__tests__/integration/sitemgr-cli.test.ts` |
| `web/__tests__/integration/smgr-e2e.test.ts` | `web/__tests__/integration/sitemgr-e2e.test.ts` |
| `specs/09-local-dev-setup/sections/section-06-smgr-e2e.md` | Historical record, skip per CLAUDE.md |
| `specs/09-local-dev-setup/sections/.prompts/section-06-smgr-e2e-prompt.md` | Historical record, skip |

## Environment Variables (11 vars)

| Old | New | Used In |
|-----|-----|---------|
| `SMGR_WEB_URL` | `SITEMGR_WEB_URL` | `smgr.ts`, `cli-auth.ts`, `.env.example`, `scripts/lib.sh`, CI |
| `SMGR_DEVICE_ID` | `SITEMGR_DEVICE_ID` | `smgr.ts`, `.env.example`, `scripts/lib.sh`, CI, Dockerfile |
| `SMGR_WATCH_INTERVAL` | `SITEMGR_WATCH_INTERVAL` | `smgr.ts`, `.env.example` |
| `SMGR_S3_ENDPOINT` | `SITEMGR_S3_ENDPOINT` | `s3.ts`, `scripts/lib.sh` |
| `SMGR_S3_REGION` | `SITEMGR_S3_REGION` | `s3.ts`, `scripts/lib.sh`, Dockerfile |
| `SMGR_S3_BUCKET` | `SITEMGR_S3_BUCKET` | `scripts/lib.sh` |
| `SMGR_API_URL` | `SITEMGR_API_URL` | `scripts/lib.sh`, CI (legacy) |
| `SMGR_API_KEY` | `SITEMGR_API_KEY` | `scripts/lib.sh` (legacy) |
| `SMGR_AUTO_ENRICH` | `SITEMGR_AUTO_ENRICH` | `scripts/lib.sh`, CI |
| `SMGR_OLLAMA_URL` | `SITEMGR_OLLAMA_URL` | CI workflow |
| `SMGR_VISION_MODEL` | `SITEMGR_VISION_MODEL` | CI workflow |

## Code References by File

### `web/bin/smgr.ts` (heaviest)
- Comment header (L3), usage examples (L6-12)
- Error messages: L45, L96, L131-134, L147, L216, L235, L339, L414, L483, L573, L628, L637
- Help text: L660-713 (extensive, "smgr" appears ~30 times)
- Env var reads: L490 (`SMGR_WATCH_INTERVAL`), L498 (`SMGR_DEVICE_ID`), L711 (`SMGR_WEB_URL`), L712 (`SMGR_DEVICE_ID`), L713 (`SMGR_WATCH_INTERVAL`)

### `web/lib/auth/cli-auth.ts`
- L78, L81: reads `SMGR_WEB_URL` (via `resolveApiConfig` or similar)
- L119, L139: error messages "run 'smgr login' again"

### `web/lib/media/s3.ts`
- L36: `SMGR_S3_ENDPOINT`
- L37: `SMGR_S3_REGION`

### `web/instrumentation.ts`
- L29, L32: console error prefixed with `[smgr]`

### Config/Scripts
- `web/.env.example`: L13, L15-16
- `web/package.json`: L19 bin script `"smgr": "tsx bin/smgr.ts"`
- `.claude/settings.json`: L9 `Bash(npm run smgr*)`
- `Dockerfile`: L16-17 (env vars), L20 (CMD)
- `scripts/lib.sh`: L220 warning msg, L223-241 env var generation
- `scripts/test-integration.sh`: L113 test file exclusion
- `.github/workflows/ci.yml`: L97-100 env vars, L103/L128 references

### Documentation (mutable)
- `README.md`: L18, L36, L76-85
- `docs/TESTING.md`: L215, L284-287

### Specs (immutable per CLAUDE.md)
- All files under `specs/` are historical records — do NOT update during rename

## Testing Infrastructure
- Framework: Vitest + Playwright
- Unit tests: `npm run test` (vitest)
- Integration tests: `npm run test:integration` (vitest with different config)
- E2E tests: `npm run test:e2e` (Playwright)
- CLI tests spawn subprocess: `tsx bin/smgr.ts <command>`
- Tests set `SMGR_WEB_URL`, `SMGR_DEVICE_ID` env vars in subprocess env

## Key Decisions
- `~/.sitemgr/` config dir already correct — no change needed
- Specs are immutable — don't rename files or references in `specs/`
- Clean break, no backwards compatibility shim (per spec)
