# Combined Specification — 11-service-role-key-audit

## Overview

Audit and refactor Supabase key usage across the codebase:

1. **Remove the ES256 JWT workaround** — delete the manual JWT signing code in `local-dev.sh` and replace with a capability probe
2. **Consolidate env var naming** — `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY` in all server-side code
3. **Keep CLI env vars separate** — `SMGR_API_URL` and `SMGR_API_KEY` are web API vars, not Supabase aliases
4. **Remove direct Supabase admin access from CLI** — CLI uses anon/publishable key through web API only
5. **Refactor integration tests** — replace raw Supabase SDK calls with `db.ts`/`s3.ts` functions
6. **Add Next.js dev server to globalSetup** — auth smoke tests need it

## Architectural Clarification (from interview)

The original spec proposed consolidating 6 env var names down to 4, treating `SMGR_API_URL`/`SMGR_API_KEY` as aliases for Supabase vars. **This was incorrect.**

**The CLI is a web API client, not a direct Supabase client.** Supabase is an implementation detail of the server. The correct model:

| Env var | Purpose | Where used |
|---------|---------|-----------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase endpoint | Web app (browser + server) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase anon JWT | Web app (browser + server) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase admin JWT | Server-only (API routes, instrumentation) |
| `SMGR_API_URL` | Web API endpoint | CLI only |
| `SMGR_API_KEY` | Web API auth key | CLI only |
| `DATABASE_URL` | Direct Postgres | Migrations only |

**Changes from original spec:**
- `SMGR_API_URL` stays (NOT renamed to `NEXT_PUBLIC_SUPABASE_URL`)
- `SMGR_API_KEY` stays (NOT renamed to `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`)
- Only server-side `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY`
- CLI removes `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` entirely (no admin access)

## Migration Strategy

**Hard cut, no fallbacks.** Remove old names entirely. Developers re-run `local-dev.sh` to get updated `.env.local`.

## ES256 Workaround Removal

**No version check.** Instead, use a capability probe — test that the keys from `supabase status` actually work. If they don't, error with a message suggesting the user upgrade Supabase CLI.

Delete lines 61-91 of `local-dev.sh` (the Docker introspection + manual JWT signing). Replace with a simple check that the service role key works against GoTrue's admin endpoint.

## Integration Test Refactor (Full)

Replace raw Supabase SDK calls with `db.ts`/`s3.ts` functions in test assertions:

- `client.from("events").select()` → `queryEvents(client, opts)`
- `admin.from("events").insert()` → `insertEvent(admin, event)`
- Raw AWS SDK → already uses `s3.ts` ✅

**Exception:** Test setup/teardown (auth.admin.createUser, seedUserData) keeps raw SDK — no app-layer equivalent.

**`setup.ts`** adds re-exports of `db.ts` and `s3.ts` modules.

**`globalSetup.ts`** adds Next.js dev server startup (needed for auth smoke tests hitting `/api/*`).

## CLI Changes

- `smgr.ts:getClient()` — remove `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` reading; CLI uses anon/publishable key via `SMGR_API_KEY`
- `cli-auth.ts` — keep `SMGR_API_URL` and `SMGR_API_KEY` as-is (these are correct)
- Focus is user-space operations

## Files to Change

### Scripts
| File | Change |
|------|--------|
| `scripts/local-dev.sh` | Delete ES256 workaround, add capability probe, output `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY` |
| `scripts/setup/verify.sh` | Rename `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY` in checks |

### Application Code
| File | Change |
|------|--------|
| `web/bin/smgr.ts` | Remove `SUPABASE_SECRET_KEY`/`SUPABASE_SERVICE_ROLE_KEY`, use anon key via `SMGR_API_KEY` |
| `web/lib/auth/cli-auth.ts` | No change (already correct) |
| `web/instrumentation.ts` | `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY` |
| `web/app/api/health/route.ts` | Already correct ✅ |
| `web/lib/agent/core.ts` | Already correct ✅ |

### Integration Tests
| File | Change |
|------|--------|
| `web/__tests__/integration/setup.ts` | Rename `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY`, re-export `db.ts`/`s3.ts` |
| `web/__tests__/integration/globalSetup.ts` | Rename, add Next.js dev server startup |
| `web/__tests__/integration/tenant-isolation.test.ts` | Replace raw SDK → `queryEvents()`, `getStats()`, etc. |
| `web/__tests__/integration/media-lifecycle.test.ts` | Replace raw SDK → `insertEvent()`, `queryEvents()`, etc. |
| `web/__tests__/integration/media-storage.test.ts` | Already uses `s3.ts` ✅ |
| `web/__tests__/integration/smgr-cli.test.ts` | Update env var names passed to subprocess |
| `web/__tests__/integration/smgr-e2e.test.ts` | Update env var names passed to subprocess |
| `web/__tests__/integration/auth-smoke.test.ts` | Already uses `db.ts` ✅ |

### CI/CD
| File | Change |
|------|--------|
| `.github/workflows/ci.yml` | `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY` throughout |

### Config/Docs
| File | Change |
|------|--------|
| `web/.env.example` | `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY` |
| `.env.example` | `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY` |
| `docs/ENV_VARS.md` | Document the rename and architecture |

## Research Findings

See `claude-research.md` for full codebase analysis including:
- Current state of all files
- `db.ts` API surface (14 exported functions)
- `s3.ts` API surface (4 exported functions)
- Which tests already use app-layer functions vs raw SDK
