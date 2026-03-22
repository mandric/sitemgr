# Combined Specification: Fix Integration CI Env Vars

## Problem Statement

After the service-role-key-audit refactor (spec 11), two CI pipeline stages fail due to missing `NEXT_PUBLIC_*` environment variables:

1. **Integration tests** — Dev server timeout (60s). The health endpoint needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, but the CI integration test job only sets `SMGR_*` equivalents.

2. **Production deploy** — Smoke test returns 503 "degraded". The deployed health endpoint calls `getUserClient` with `NEXT_PUBLIC_*` vars that may not resolve correctly in production.

## Root Cause

The spec 11 refactor made two simultaneous changes:
- `health/route.ts`: Switched from `getAdminClient(SUPABASE_SERVICE_ROLE_KEY)` to `getUserClient(NEXT_PUBLIC_*)`
- `globalSetup.ts`: Added dev server spawning + health polling

The CI configuration was not updated to provide the new env vars the health endpoint requires.

## Scope

**In scope:**
- Add `NEXT_PUBLIC_*` env vars to CI integration test job (`$GITHUB_ENV`)
- Add defensive env var mapping in `globalSetup.ts` (`SMGR_API_URL` → `NEXT_PUBLIC_SUPABASE_URL`)
- Improve `smoke_test` function in `scripts/lib.sh` (retry logic, diagnostic output)

**Out of scope:**
- JWS/service role key issue (separate investigation)
- Vercel dashboard configuration (already confirmed as correct)

## Design Decisions

### Env var propagation: `$GITHUB_ENV` (not `.env.local`)

For CI, we'll use `$GITHUB_ENV` to add the `NEXT_PUBLIC_*` vars. This is consistent with the existing pattern for `SMGR_*` vars in the integration test job. The E2E job uses `.env.local` but that's because Playwright has a different server lifecycle.

### Defensive mapping in globalSetup

The `globalSetup.ts` will explicitly map `SMGR_API_URL` → `NEXT_PUBLIC_SUPABASE_URL` and `SMGR_API_KEY` → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the dev server spawn environment. This makes globalSetup resilient — if CI forgets to set the `NEXT_PUBLIC_*` vars, the dev server still works because the `SMGR_*` vars are always present.

The mapping is: use `NEXT_PUBLIC_*` if already set, otherwise fall back to `SMGR_*`.

### Smoke test improvements

The `smoke_test` function will be enhanced with:
- Response body output on failure (already partially there but could be clearer)
- Retry logic with backoff for transient cold-start failures
- Clearer error messages distinguishing connection errors from degraded status

## Affected Files

| File | Change |
|------|--------|
| `.github/workflows/ci.yml` | Add `NEXT_PUBLIC_*` to integration test env config |
| `web/__tests__/integration/globalSetup.ts` | Defensive `SMGR_*` → `NEXT_PUBLIC_*` mapping in spawn env |
| `scripts/lib.sh` | Improve `smoke_test` with retries and better diagnostics |

## Environment Variable Mapping

Both naming conventions point to the same values:

| App var (Next.js) | CLI/Test var | Value (local Supabase) |
|-------------------|-------------|----------------------|
| `NEXT_PUBLIC_SUPABASE_URL` | `SMGR_API_URL` | `http://127.0.0.1:54321` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `SMGR_API_KEY` | Supabase anon key |

## Validation

- Push to `claude/fix-pipeline-O8zyY` branch
- CI integration tests should pass (dev server starts, health returns 200)
- All existing integration tests should continue to pass
- No code changes to the health endpoint itself (it's correct as-is)

## Risk Assessment

- **CI config change:** Zero risk — additive env var configuration
- **globalSetup change:** Very low risk — defensive fallback, doesn't change behavior when vars are present
- **Smoke test change:** Low risk — purely diagnostic/retry improvements
