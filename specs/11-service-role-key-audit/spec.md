# 11-service-role-key-audit — Spec

## Overview

Audit how Supabase keys are used, named, and constructed across the codebase. The goals:

1. Determine whether the hand-crafted ES256 JWT in commit `82b268d` is necessary
2. Consolidate the scattered env var naming into a clear, single-source pattern
3. Make it obvious which key is which and where each one flows

## Background

### How Supabase keys work

Supabase CLI outputs two keys from `supabase status -o json`:

| CLI field | JWT `role` claim | Purpose |
|-----------|-----------------|---------|
| `ANON_KEY` | `anon` | Public/browser-safe key — respects RLS |
| `SERVICE_ROLE_KEY` | `service_role` | Server-only key — bypasses RLS |

**Both are JWTs** signed with the same secret, differing only in the `role` claim. They are not opaque API keys — they're pre-signed tokens that PostgREST verifies to determine the Postgres role for the connection.

### The ES256 workaround (commit `82b268d`)

Supabase CLI ≥ 2.78 switched GoTrue from HS256 to ES256 JWT signing. The `SERVICE_ROLE_KEY` from `supabase status` is still HS256. Commit `82b268d` works around this by:

1. Reaching into the `supabase_auth_*` Docker container
2. Extracting GoTrue's EC private key from `GOTRUE_JWT_KEYS`
3. Hand-signing a JWT: `{iss: "supabase-local", role: "service_role", exp: 9999999999}`
4. Replacing `SUPABASE_SECRET_KEY` with this hand-crafted JWT

### Key insight

The `ANON_KEY` is to `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as `SERVICE_ROLE_KEY` is to `SUPABASE_SECRET_KEY` — they're the same JWT values from the CLI, just renamed. The relationship between `ANON_KEY` and its "publishable" alias is the same pattern as `SERVICE_ROLE_KEY` and its "secret" alias. If the CLI-provided `ANON_KEY` JWT works fine without hand-crafting, the `SERVICE_ROLE_KEY` JWT should too — unless something specific to GoTrue admin endpoints requires the new signing algorithm.

**This suggests the hand-crafted JWT is a workaround for a narrow GoTrue admin API issue, not a fundamental problem with how the service role key works.**

## Current naming mess

The same two Supabase values are accessed under **6 different env var names** across the codebase:

### Anon key (1 Supabase value → 3 env var names)

| Env var | Where used | Same value? |
|---------|-----------|-------------|
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Web app (browser client, server client, proxy, instrumentation) | Yes |
| `SMGR_API_KEY` | CLI (`smgr`), integration tests, CI workflow | Yes |
| (raw `ANON_KEY`) | Only in scripts when reading from `supabase status` | Yes |

### Service role key (1 Supabase value → 3 env var names)

| Env var | Where used | Same value? |
|---------|-----------|-------------|
| `SUPABASE_SECRET_KEY` | CLI (`smgr.ts:49`), instrumentation, integration tests, CI workflow, `.env.example` | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Server code (`health/route.ts`, `agent/core.ts`), unit tests | Yes |
| (raw `SERVICE_ROLE_KEY`) | Only in scripts when reading from `supabase status` | Yes |

### Full access map

```
supabase status -o json
  ├── ANON_KEY ──────────────┬── NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  │                          │     ├── web/lib/supabase/client.ts (browser client)
  │                          │     ├── web/lib/supabase/server.ts (server client)
  │                          │     ├── web/lib/supabase/proxy.ts
  │                          │     ├── web/components/agent/actions.ts
  │                          │     ├── web/lib/utils.ts
  │                          │     └── web/instrumentation.ts
  │                          │
  │                          └── SMGR_API_KEY
  │                                ├── web/bin/smgr.ts (CLI, via cli-auth.ts)
  │                                ├── web/lib/auth/cli-auth.ts
  │                                ├── web/__tests__/integration/setup.ts
  │                                ├── web/__tests__/integration/globalSetup.ts
  │                                └── .github/workflows/ci.yml
  │
  └── SERVICE_ROLE_KEY ──────┬── SUPABASE_SECRET_KEY
                             │     ├── web/bin/smgr.ts:49 (primary)
                             │     ├── web/instrumentation.ts:12
                             │     ├── web/__tests__/integration/setup.ts:11
                             │     ├── web/__tests__/integration/smgr-cli.test.ts
                             │     ├── web/__tests__/integration/smgr-e2e.test.ts
                             │     ├── .github/workflows/ci.yml (integration + deploy)
                             │     ├── scripts/local-dev.sh (output)
                             │     └── .env.example, docs/ENV_VARS.md
                             │
                             └── SUPABASE_SERVICE_ROLE_KEY
                                   ├── web/bin/smgr.ts:49 (fallback)
                                   ├── web/app/api/health/route.ts:14
                                   ├── web/lib/agent/core.ts:50
                                   ├── web/__tests__/agent-core.test.ts
                                   └── web/__tests__/phone-migration-app.test.ts
```

## Problems

### 1. The hand-crafted JWT is likely unnecessary

If the `ANON_KEY` JWT from `supabase status` works without hand-crafting, the `SERVICE_ROLE_KEY` should too — they use the same signing algorithm. The ES256 issue only affects GoTrue admin API calls (`auth.admin.createUser/deleteUser`), which are only used in **integration test setup** (`setup.ts`), not in the production app.

**Action:** Verify which calls actually fail with the unmodified `SERVICE_ROLE_KEY` on CLI ≥ 2.78. If only GoTrue admin calls break, the fix belongs in test setup, not in the env var generation.

### 2. Same value, different names = confusion

Having `SUPABASE_SECRET_KEY` and `SUPABASE_SERVICE_ROLE_KEY` refer to the same value but used in different files makes it unclear whether they're different things. Same for `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` vs `SMGR_API_KEY`.

### 3. The CLI uses its own names for no clear reason

`SMGR_API_URL` and `SMGR_API_KEY` are aliases for `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. The CLI could just read the standard Supabase names.

## Proposed consolidation

### Target: 4 env vars (down from 6+)

| Canonical env var | Replaces | Who reads it |
|-------------------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | `SMGR_API_URL` | Web app + CLI |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `SMGR_API_KEY` | Web app + CLI |
| `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_SECRET_KEY` | Server code + CLI + tests |
| `DATABASE_URL` | (unchanged) | Direct DB access |

**Why `SUPABASE_SERVICE_ROLE_KEY` over `SUPABASE_SECRET_KEY`?**
- Matches Supabase dashboard naming
- Makes it clear this is the service role key, not some other secret
- "Secret key" is ambiguous — could be encryption key, API secret, etc.

**Why `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` over `SMGR_API_KEY`?**
- One name for one value
- CLI doesn't need its own alias — it can read the standard name
- `NEXT_PUBLIC_` prefix is a Next.js convention, but the CLI can still read it

### Migration approach

1. **Update CLI** (`web/bin/smgr.ts`): Read `SUPABASE_SERVICE_ROLE_KEY` (primary), drop `SUPABASE_SECRET_KEY` fallback
2. **Update CLI auth** (`web/lib/auth/cli-auth.ts`): Read `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` instead of `SMGR_API_URL`/`SMGR_API_KEY`
3. **Update instrumentation** (`web/instrumentation.ts`): Validate `SUPABASE_SERVICE_ROLE_KEY`
4. **Update local-dev.sh**: Output canonical names only
5. **Update CI workflow**: Use canonical names
6. **Update .env.example files**: Single set of names
7. **Update integration tests**: Use canonical names
8. **Remove the ES256 JWT workaround** from `local-dev.sh` (pending Step 1 verification)

### What to verify first

Before removing the ES256 workaround:

1. Run `supabase start` with CLI ≥ 2.78
2. Use the unmodified `SERVICE_ROLE_KEY` from `supabase status`
3. Run integration tests — identify which specific calls fail
4. If only `auth.admin.*` calls fail, fix in test setup (not env var generation)
5. Check if `supabase status` on latest CLI now outputs an ES256 key

## Files to change

| File | Change |
|------|--------|
| `scripts/local-dev.sh` | Remove ES256 workaround, output canonical names |
| `web/bin/smgr.ts` | Read canonical names, remove fallback chains |
| `web/lib/auth/cli-auth.ts` | Read `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| `web/instrumentation.ts` | Validate `SUPABASE_SERVICE_ROLE_KEY` |
| `web/__tests__/integration/setup.ts` | Use canonical names |
| `web/__tests__/integration/globalSetup.ts` | Use canonical names |
| `web/__tests__/integration/smgr-cli.test.ts` | Use canonical names |
| `web/__tests__/integration/smgr-e2e.test.ts` | Use canonical names |
| `.github/workflows/ci.yml` | Use canonical names |
| `web/.env.example` | Consolidate to canonical names |
| `.env.example` | Consolidate to canonical names |
| `docs/ENV_VARS.md` | Update documentation |
| `scripts/setup/verify.sh` | Check canonical names |
