# Research: Fix Integration CI Env Vars

## Codebase Research

### 1. CI Workflow Structure (`.github/workflows/ci.yml`)

Five jobs: lint, build, unit-tests run in parallel. Integration tests and E2E tests run independently. Deploy runs after all pass (main only).

**Integration Test Job (lines 64-163):**
- Starts local Supabase via `supabase start`
- Extracts connection details with `supabase status -o json`
- Sets env vars via `$GITHUB_ENV`: `SMGR_API_URL`, `SMGR_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, storage/S3 vars, Ollama vars
- **Does NOT set** `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- Runs `cd web && npm run test:integration`

**E2E Test Job (lines 165-216):**
- Also starts local Supabase
- **Does set** `NEXT_PUBLIC_*` vars by writing `.env.local`:
  ```yaml
  printf '%s\n' \
    "NEXT_PUBLIC_SUPABASE_URL=${{ env.SUPABASE_URL }}" \
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${{ env.SUPABASE_PUBLISHABLE_KEY }}" \
    > .env.local
  ```

**Deploy Job (lines 222-303):**
- Links to Supabase project, runs migrations, creates bucket
- Calls `smoke_test` from `scripts/lib.sh` on `$VERCEL_APP_URL`

### 2. Environment Variable Mapping

The codebase uses two parallel naming conventions for the same values:

| Purpose | App code (Next.js) | CLI/Test code |
|---------|-------------------|---------------|
| Supabase URL | `NEXT_PUBLIC_SUPABASE_URL` | `SMGR_API_URL` |
| Supabase anon key | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `SMGR_API_KEY` |

Both point to the same Supabase instance. The `NEXT_PUBLIC_` prefix is required for Next.js client-side access; the `SMGR_` prefix is used by the CLI and test infrastructure.

**Files using `NEXT_PUBLIC_*` vars:**
- `web/app/api/health/route.ts` — health endpoint
- `web/app/api/whatsapp/route.ts` — webhook handler
- `web/__tests__/health-route.test.ts` — unit test (stubs via `vi.stubEnv`)

**Files using `SMGR_*` vars:**
- `web/__tests__/integration/globalSetup.ts` — Supabase validation
- `web/__tests__/integration/setup.ts` — test fixtures
- CLI code

### 3. Health Endpoint (`web/app/api/health/route.ts`)

```typescript
const supabase = getUserClient({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
});
```

Previously used `getAdminClient` with `SUPABASE_SERVICE_ROLE_KEY`. Changed in spec 11 to eliminate service role key from app runtime. The `getUserClient` function validates inputs:
```typescript
export function getUserClient(config: SupabaseUserConfig) {
  if (!config.url) throw new Error("url is required for user client");
  if (!config.anonKey) throw new Error("anonKey is required for user client");
  return createSupabaseClient(config.url, config.anonKey);
}
```

### 4. globalSetup.ts

The integration test global setup was extended to spawn a Next.js dev server:

1. Validates Supabase connectivity using `SMGR_API_URL` + `SMGR_API_KEY` (works fine)
2. Checks if port 3000 is in use (if so, skips spawning)
3. Spawns `npm run dev` with `{ ...process.env, PORT: "3000" }` — inherits all env vars
4. Polls `http://localhost:3000/api/health` for 60 seconds

**The bug:** The spawned process inherits `process.env` which has `SMGR_*` vars but not `NEXT_PUBLIC_*` vars. The dev server starts but the health endpoint can't create a Supabase client.

### 5. Local Dev Setup (`scripts/local-dev.sh`)

The `print_setup_env_vars()` function generates `.env.local` with both naming conventions:
```bash
NEXT_PUBLIC_SUPABASE_URL=${api_url}
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${anon_key}
SMGR_API_URL=${api_url}
SMGR_API_KEY=${anon_key}
```

This works locally because `.env.local` is loaded by Next.js dev server. In CI, no `.env.local` exists for integration tests.

### 6. `.env.example` Files

Both `.env.example` (root) and `web/.env.example` document all required vars including `NEXT_PUBLIC_*`.

### 7. Smoke Test (`scripts/lib.sh`)

```bash
smoke_test() {
  local deploy_url="${1:-${VERCEL_APP_URL:-}}"
  http_code=$(curl -sS -o /tmp/health.json -w '%{http_code}' "${deploy_url}/api/health")
  status=$(jq -r '.status // empty' /tmp/health.json)
  if [ "$status" != "ok" ]; then
    echo "HEALTH CHECK FAILED (status: $status)"
    return 1
  fi
}
```

### 8. Testing Infrastructure

- **Framework:** Vitest (unit + integration), Playwright (E2E)
- **Config:** `web/vitest.config.ts` — two projects: "unit" and "integration"
- Integration project uses `globalSetup: ["__tests__/integration/globalSetup.ts"]`
- Integration tests run serially (`fileParallelism: false`)
- Test timeouts: 60s per test, 30s for hooks
- Unit tests for health endpoint use `vi.stubEnv` to set `NEXT_PUBLIC_*` vars

### 9. next.config.ts

Minimal — no custom env configuration:
```typescript
const nextConfig: NextConfig = { cacheComponents: true };
```

---

## Web Research

### Next.js `NEXT_PUBLIC_*` Env Var Behavior

**Build time vs runtime:**
- During `next build`, `NEXT_PUBLIC_*` vars are **inlined** as string literals into the JS bundle. Runtime changes are ignored.
- During `next dev`, `NEXT_PUBLIC_*` vars are read **dynamically** from `process.env` — no build step, so they work if set in the environment.
- In **API routes** (server-side), `process.env` is always read at runtime regardless of prefix.

**Key implication for our bug:** Since integration tests spawn `next dev` (not a built app), the dev server reads `NEXT_PUBLIC_*` from `process.env` at request time. If these vars aren't in the environment, `process.env.NEXT_PUBLIC_SUPABASE_URL` is `undefined`.

**Env file loading in `next dev`:**
- Next.js automatically loads `.env`, `.env.local`, `.env.development`, `.env.development.local`
- This is why E2E tests work — they write `.env.local` before running
- Integration tests don't create `.env.local`, relying solely on `$GITHUB_ENV`

Sources:
- [Next.js Environment Variables Guide](https://nextjs.org/docs/pages/guides/environment-variables)
- [Next.js env config reference](https://nextjs.org/docs/app/api-reference/config/next-config-js/env)

### GitHub Actions Env Var Patterns for Next.js

**Two approaches:**
1. **`$GITHUB_ENV`** — Vars set via `echo "VAR=val" >> $GITHUB_ENV` are available in all subsequent steps as `process.env.VAR`. Child processes inherit them.
2. **`.env.local` file** — Writing vars to `web/.env.local` before running `next dev`. Next.js loads this automatically.

Both work for `next dev`. The `.env.local` approach is slightly more robust because it goes through Next.js's own env loading pipeline. The `$GITHUB_ENV` approach is simpler and sufficient since the dev server inherits the CI environment.

**Recommendation:** Use `$GITHUB_ENV` for consistency with the existing pattern in the integration test job. Add two lines to the "Configure environment" step.

### Vitest globalSetup Dev Server Patterns

**Common pattern:** Spawn dev server in globalSetup, poll health endpoint, teardown in globalTeardown. This is exactly what the codebase does.

**Key considerations:**
- Child process inherits `process.env` from the vitest process
- If vitest runs with env vars set via `$GITHUB_ENV`, the spawned dev server gets them
- Using `next dev` in CI is acceptable for integration tests (vs `next build` + `next start` for performance-sensitive scenarios)
- 60s timeout is generous but appropriate for CI cold starts

---

## Summary of Findings

The root cause is a straightforward env var gap introduced during the spec 11 refactor:

1. Health endpoint changed from admin client → user client (needs `NEXT_PUBLIC_*` vars)
2. globalSetup added dev server spawning (makes health endpoint reachable)
3. CI integration job was not updated to provide `NEXT_PUBLIC_*` vars
4. Local dev and E2E tests are unaffected because they use `.env.local`

The fix is to add two `NEXT_PUBLIC_*` env vars to the CI integration test configuration, mapping from the existing `SMGR_*` values.
