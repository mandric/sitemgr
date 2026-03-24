# Research Findings

## Current CI Pipeline Structure

The CI workflow (`.github/workflows/ci.yml`) has 5 jobs:

| Job | Purpose | Dependencies |
|-----|---------|-------------|
| `lint` | ESLint, TypeScript check, shellcheck | None |
| `build` | Next.js build | None |
| `unit-tests` | `vitest run` (unit only) | None |
| `integration-tests` | Supabase start → FTS smoke → stop | None |
| `e2e-tests` | Playwright against local Supabase | None |
| `deploy` | Vercel + Supabase push | All above |

All 5 prerequisite jobs run in parallel. Deploy depends on all 5.

## Integration Test Suites (Not in CI)

### DB Integration Tests (`npm run test:integration`)
- Config: `web/vitest.integration.config.ts`
- Files: `rls-policies.test.ts`, `rpc-user-isolation.test.ts`, `migration-integrity.test.ts`
- Timeout: 30s
- Requires: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`
- Uses `describe.skipIf(!canRun)` pattern — silently skips if env vars missing

### Media Pipeline Tests (`npm run test:media-integration`)
- Config: `web/vitest.media-integration.config.ts`
- Files: `__tests__/integration/media-*.test.ts` (media-db, media-s3, media-pipeline)
- Timeout: 60s
- Requires same Supabase vars plus S3 env vars
- Shared setup in `__tests__/integration/setup.ts`

## Environment Variable Gap

CI currently exports:
```
SUPABASE_URL         → tests need NEXT_PUBLIC_SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY → tests need NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY  → ✅ matches
```

The `NEXT_PUBLIC_` prefix is critical — without it, tests silently skip via the `canRun` guard.

## S3 Config for Media Tests

The `setup.ts` file constructs S3 config from the Supabase URL:
```typescript
endpoint: `${SUPABASE_URL}/storage/v1/s3`
```

The S3 env vars (`SMGR_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`) are already set in the CI job's "Configure environment for smgr" step. However, `setup.ts` uses the Supabase service key directly as S3 credentials — it doesn't read `AWS_*` vars. So the media tests only need the Supabase env vars, not the AWS ones.

## Storage Bucket

CI creates a `media` bucket. The media tests use Supabase Storage API (not raw S3), so they interact with whatever buckets exist. The `media` bucket should be sufficient.
