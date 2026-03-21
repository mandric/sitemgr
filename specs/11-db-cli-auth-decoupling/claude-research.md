# Research: Decouple db.ts from cli-auth.ts

## Codebase Research

### Architecture Overview

The project has two distinct runtime contexts sharing `db.ts`:

1. **Web app** (Vercel): API routes (`/api/health`, `/api/whatsapp`), Server Actions (`components/agent/actions.ts`), and agent core (`lib/agent/core.ts`)
2. **CLI** (`bin/smgr.ts`): Command-line tool for media management

Both contexts need Supabase database access but construct clients differently.

### db.ts Structure (460 lines)

**Imports from cli-auth (line 12):**
```typescript
import { refreshSession, resolveApiConfig } from "@/lib/auth/cli-auth";
```

**Three client factories:**
| Factory | Uses cli-auth | Context |
|---------|--------------|---------|
| `getAdminClient()` | `resolveApiConfig()` → `SMGR_API_URL` + `SUPABASE_SECRET_KEY` | Both |
| `getUserClient()` | `resolveApiConfig()` → `SMGR_API_URL` + `SMGR_API_KEY` | Both |
| `getAuthenticatedClient()` | `refreshSession()` + `resolveApiConfig()` | CLI only |

**Eleven data functions** (all downstream of the factories):
`queryEvents`, `showEvent`, `getStats`, `getEnrichStatus`, `insertEvent`, `insertEnrichment`, `upsertWatchedKey`, `getWatchedKeys`, `findEventByHash`, `getPendingEnrichments`, `getModelConfig`

### cli-auth.ts Structure (182 lines)

**Module-scope side effects:**
- Imports `node:fs`, `node:os`, `node:readline`
- Defines `CONFIG_DIR = join(homedir(), ".sitemgr")` at module scope
- Defines `CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json")` at module scope

**`resolveApiConfig()` implementation:**
- Reads `SMGR_API_URL` env var (throws if missing)
- Reads `SMGR_API_KEY` env var (throws if missing)
- Returns `{ url, anonKey }`

**`refreshSession()` implementation:**
- Loads stored credentials from `~/.sitemgr/credentials.json`
- If token expires in < 60s, refreshes via Supabase Auth
- Returns `StoredCredentials | null`

### Consumer Analysis

**Web consumers (break at import time):**
- `app/api/health/route.ts` → imports `getAdminClient`
- `components/agent/actions.ts` → imports `getStats`
- `lib/agent/core.ts` → imports `getAdminClient` + 8 data functions

**CLI consumer:**
- `bin/smgr.ts` → imports 11 data functions from db.ts + `login`, `clearCredentials`, `loadCredentials` from cli-auth

**Barrel export:**
- `lib/media/index.ts` → `export * from "./db"` (passes everything through)

### Existing Supabase Client Patterns in Web Layer

The web layer already has its own Supabase client construction in `lib/supabase/`:
- `lib/supabase/server.ts` — Creates server client using `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` with cookie-based auth
- `app/api/media/[id]/route.ts` — Uses `lib/supabase/server` (does NOT import db.ts)

This confirms the web layer uses `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, not `SMGR_API_URL` / `SMGR_API_KEY`.

### Environment Variables by Context

| Env Var | Web (Vercel) | CLI (smgr) |
|---------|-------------|------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Set | Not used |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Set | Not used |
| `SUPABASE_SERVICE_ROLE_KEY` | Set | Not used |
| `SMGR_API_URL` | Not set | Set |
| `SMGR_API_KEY` | Not set | Set |
| `SUPABASE_SECRET_KEY` | Not set | Set |

### Testing Setup

- **Framework:** Vitest with two profiles (unit, integration)
- **Unit tests:** `vi.stubEnv()` for `SMGR_API_URL`, `SMGR_API_KEY`, `SUPABASE_SECRET_KEY`; mock `createClient`
- **Integration tests:** Set `SMGR_API_URL`/`SMGR_API_KEY` via env; spawn child processes
- **Key test file:** `__tests__/db-operations.test.ts` (548 lines) — tests all db.ts functions with mocked Supabase client

### Agent Core Usage Pattern

`lib/agent/core.ts` (949 lines) exclusively uses `getAdminClient()` — never `getUserClient()` or `getAuthenticatedClient()`. It needs service-role access to bypass RLS for WhatsApp bot operations (user lookup by phone number, cross-user queries).

---

## Web Research

### Next.js Module Splitting

**Key principle:** Next.js bundles API routes for serverless/edge deployment. Any top-level import in a route file gets bundled, including transitive dependencies. If `db.ts` imports `cli-auth.ts` which imports `node:fs`, the bundler must include `node:fs` — which fails on Edge Runtime and adds unnecessary weight on Node.js serverless.

**Recommended patterns:**
- **Separate entry points per context** — Don't share a single module across web and CLI if they have different dependency requirements
- **`optimizePackageImports`** in `next.config.js` — Helps with barrel exports from node_modules but doesn't solve custom barrel exports
- **Dynamic `import()`** — Lazy-loads modules only when needed; avoids top-level side effects. Good for optional features but not ideal for core dependencies

### Supabase Client Per-Environment

**Supabase's official recommendation (docs):**
- **Browser:** `createBrowserClient(url, anonKey)`
- **Server Components/Actions:** `createServerClient(url, anonKey, { cookies })` via `@supabase/ssr`
- **Route Handlers:** Same as server components
- **Service role (admin):** `createClient(url, serviceRoleKey)` — bypasses RLS, use server-side only

**Pattern:** Create separate utility files per context (`lib/supabase/browser.ts`, `lib/supabase/server.ts`, `lib/supabase/admin.ts`). Each reads its own env vars and constructs the appropriate client. Never share a single factory across contexts.

### Barrel Export Problems

**Known issues with `export * from "./module"`:**
- Forces bundlers to evaluate ALL exported modules even if only one export is used
- Transitive dependencies get pulled in unconditionally
- TypeScript type-checking slows down with large barrel files
- Tree-shaking is unreliable with side-effectful modules

**Recommended fixes:**
1. **Named re-exports** — `export { queryEvents, showEvent } from "./db"` instead of `export *`
2. **Direct imports** — Import from the specific module, not the barrel: `from "@/lib/media/db"` not `from "@/lib/media"`
3. **Remove barrel entirely** — If the barrel only re-exports one module, it adds no value
4. **`sideEffects: false`** in package.json — Tells bundlers it's safe to tree-shake, but doesn't help if modules have actual side effects (like cli-auth.ts does)
