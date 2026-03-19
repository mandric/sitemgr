# Section 03: Add DB Integration Test Step

## Context

The DB integration tests (`rls-policies.test.ts`, `rpc-user-isolation.test.ts`, `migration-integrity.test.ts`) validate database security policies and migration consistency. They require a running local Supabase instance and the correct env vars.

The vitest config (`vitest.integration.config.ts`) and test files already exist. The npm script `test:integration` already exists. We just need to add a CI step that runs it.

## Implementation

### Add a new step to the `integration-tests` job

**File:** `.github/workflows/ci.yml`
**Position:** After "Install web dependencies" (currently the last step before FTS smoke test)

```yaml
- name: Run DB integration tests (RLS, RPC, migrations)
  run: cd web && npm run test:integration
```

### Why no explicit `env:` block?

The required env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`) are already in `$GITHUB_ENV` from Section 01. The verification step (Section 02) confirms they're set. Adding them again as step-level `env:` creates a maintenance burden with no added safety.

### What this runs:

`npm run test:integration` → `vitest run --config vitest.integration.config.ts`

Which executes:
- **`rls-policies.test.ts`** — Creates two test users, verifies each can only see their own data across all tables (events, enrichments, watched_keys, etc.). Uses `describe.skipIf(!canRun)` guard.
- **`rpc-user-isolation.test.ts`** — Verifies RPC functions respect user boundaries using hardcoded test UUIDs. Uses `describe.skipIf(!canRun)` guard.
- **`migration-integrity.test.ts`** — Currently all `it.todo(...)` stubs. Runs but validates nothing. Included so future implementations are automatically covered.

Timeout: 30 seconds per test.

### Test isolation:

The DB tests use unique identifiers per file:
- `rls-policies.test.ts` uses `rls-test-a@test.local` / `rls-test-b@test.local`
- `rpc-user-isolation.test.ts` uses hardcoded UUIDs

Vitest's default parallelism is safe for these tests.

## Tests

```bash
# Verify locally:
# 1. supabase start
# 2. Export NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY
# 3. cd web && npm run test:integration
# 4. Verify non-zero pass count in output (not all skipped)
```

## Acceptance Criteria

- [ ] New step runs `cd web && npm run test:integration`
- [ ] Positioned after "Install web dependencies"
- [ ] Positioned before "Run media integration tests" and "FTS smoke test"
- [ ] Tests actually run (not silently skip) with correct env vars
