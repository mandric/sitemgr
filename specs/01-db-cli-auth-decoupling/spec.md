# Spec: Decouple db.ts from cli-auth.ts

## Problem

`web/lib/media/db.ts` unconditionally imports from `web/lib/auth/cli-auth.ts` (line 12):

```typescript
import { refreshSession, resolveApiConfig } from "@/lib/auth/cli-auth";
```

This is a **critical production bug**. Every module that imports from `db.ts` — directly or transitively — pulls in `cli-auth.ts`, which:

1. Imports Node-native modules (`node:fs`, `node:os`, `node:readline`) that may not be available or appropriate in all contexts.
2. Calls `resolveApiConfig()`, which throws if `SMGR_API_URL` and `SMGR_API_KEY` are not set.
3. References `homedir()` at module scope to build `CONFIG_DIR` / `CREDENTIALS_FILE` paths.

The web app (Vercel API routes, Server Actions) does **not** set `SMGR_API_URL` / `SMGR_API_KEY` — it uses `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` instead. Importing `db.ts` in any web path causes a runtime failure.

## Affected Web Paths

| File | Usage |
|------|-------|
| `app/api/health/route.ts` | Imports `getAdminClient` from db.ts |
| `components/agent/actions.ts` | Imports `getStats` from db.ts |
| `lib/agent/core.ts` | Imports `getAdminClient` + 8 query functions from db.ts |

All of these break at import time in the Vercel runtime because `cli-auth.ts` is loaded as a side effect.

## Root Cause

`db.ts` serves two contexts that need different Supabase client construction:

- **Web app**: Uses `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (admin) or anon key (user). No session refresh needed — the server is stateless.
- **CLI (`smgr`)**: Uses `SMGR_API_URL` + `SMGR_API_KEY`, plus file-based credential storage and session refresh via `refreshSession()`.

Currently `db.ts` is hardcoded to the CLI path. The two functions it imports from `cli-auth.ts` are:

- `resolveApiConfig()` — reads `SMGR_API_URL` / `SMGR_API_KEY` env vars; used by `getAdminClient()` and `getUserClient()`.
- `refreshSession()` — refreshes a stored JWT from `~/.sitemgr/credentials.json`; used only by `getAuthenticatedClient()`.

## Proposed Fix

### Strategy: Extract CLI-specific client into cli-auth, keep db.ts web-only

1. **Remove the `cli-auth` import from `db.ts`.**

2. **Change `getAdminClient()` and `getUserClient()` in `db.ts` to read web-standard env vars:**
   - `NEXT_PUBLIC_SUPABASE_URL` (or a shared `SUPABASE_URL` alias)
   - `SUPABASE_SERVICE_ROLE_KEY` (admin) / `NEXT_PUBLIC_SUPABASE_ANON_KEY` (user)

3. **Move `getAuthenticatedClient()` out of `db.ts`** and into `cli-auth.ts` (or a new `cli-db.ts` module). This function is only used by `smgr.ts` and needs `refreshSession()` + `resolveApiConfig()`.

4. **In `smgr.ts`**, import `getAuthenticatedClient` from the CLI module instead of `db.ts`. Also have `smgr.ts` supply CLI-specific env vars (`SMGR_API_URL`, `SMGR_API_KEY`) to construct its own admin/user clients, or have `db.ts` accept a config parameter.

### Alternative: Lazy imports

Instead of restructuring, `db.ts` could use dynamic `import()` for `cli-auth.ts` only inside `getAuthenticatedClient()`. This avoids the module-scope side effects but is less clean — the dependency still exists and the function remains in the wrong layer.

**Recommendation: Full extraction (option 1).** It's a clean separation that matches the actual architecture — `db.ts` is a shared data layer, `cli-auth.ts` is CLI-only.

## Files to Change

| File | Change |
|------|--------|
| `web/lib/media/db.ts` | Remove cli-auth import; change `getAdminClient`/`getUserClient` to use web env vars; remove `getAuthenticatedClient` |
| `web/lib/auth/cli-auth.ts` | Add `getAuthenticatedClient` (moved from db.ts), or create new `web/lib/auth/cli-db.ts` |
| `web/bin/smgr.ts` | Update imports — get `getAuthenticatedClient` from cli-auth (or cli-db) |

## Testing

- **Unit**: `getAdminClient()` constructs a client from `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (stub env).
- **Unit**: `getAuthenticatedClient()` (in its new home) still calls `refreshSession()` and uses `SMGR_API_URL` / `SMGR_API_KEY`.
- **Integration**: Existing `media-lifecycle.test.ts` and `smgr-cli.test.ts` continue to pass.
- **Smoke**: `app/api/health/route.ts` responds 200 when deployed to Vercel (no import crash).

## Risks

- **Import path changes** ripple into test files that import from `db.ts`. Verify all test imports still resolve.
- **`getAuthenticatedClient` relocation** means any future code that needs an auth-refreshed client must import from the CLI module, not db.ts. This is the correct constraint — web paths should never use file-based credentials.
