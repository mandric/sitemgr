# 11-service-role-key-audit — Spec

## Overview

Audit how Supabase keys are used, named, and constructed across the codebase. The goals:

1. Remove the hand-crafted ES256 JWT workaround — we should never manually sign JWTs
2. Consolidate the scattered env var naming into a clear, single-source pattern
3. Make it obvious which key is which, where each one flows, and why some are JWTs

## Core principle: never manually construct JWTs

JWTs are issued by auth services, not hand-built in shell scripts. The only time a JWT is *created* is:

- **At infrastructure start**: `supabase start` pre-signs the `ANON_KEY` and `SERVICE_ROLE_KEY` JWTs
- **At user login**: GoTrue issues a user JWT via `signInWithPassword()` → returns `access_token`

Application code **passes JWTs through as-is** — it never signs them. If a CLI-provided JWT doesn't work with a service, that's an upstream bug to report, not something to work around by extracting private keys from Docker containers.

## How Supabase keys work

### Which keys are JWTs and why

`supabase status -o json` returns several keys. Some are JWTs, some are not:

| CLI field | Format | Why this format |
|-----------|--------|----------------|
| `ANON_KEY` | JWT (`eyJ...`) | PostgREST reads the `role: anon` claim → maps to Postgres `anon` role → RLS applies |
| `SERVICE_ROLE_KEY` | JWT (`eyJ...`) | PostgREST reads the `role: service_role` claim → maps to Postgres `service_role` role → bypasses RLS |
| `S3_PROTOCOL_ACCESS_KEY_ID` | Plain string | S3 protocol uses AWS-style auth, not JWTs |
| `S3_PROTOCOL_ACCESS_KEY_SECRET` | Plain string | Same — AWS-style HMAC signing |
| `DB_URL` | Connection string | Direct Postgres connection, no JWT needed |

**Both `ANON_KEY` and `SERVICE_ROLE_KEY` are JWTs** signed with the same secret, differing only in the `role` claim. They're pre-signed at `supabase start` time and used as-is.

**Why JWTs?** PostgREST (the REST API gateway) needs to know which Postgres role to use for each request. It gets this from the JWT `role` claim. This is how RLS enforcement works — the JWT tells Postgres "this request is from the `anon` role" or "this request is from `service_role`."

### Which Supabase services verify JWTs

| Component | Verifies JWTs? | Accepts service_role JWT? | When this app uses it |
|-----------|---------------|--------------------------|----------------------|
| **PostgREST** (data API) | Yes — reads `role` claim | Yes — bypasses RLS | All `.from("table").select/insert/delete` calls |
| **GoTrue** (auth service) | Yes — on admin endpoints | Yes — for `auth.admin.*` calls | Only in test setup (`createUser`, `deleteUser`) |
| **Storage API** | Yes — `Authorization: Bearer` | Yes — admin access to buckets | Bucket creation in CI + deploy |
| **S3 protocol** | No — uses AWS auth | N/A | Media file upload/download |
| **Direct Postgres** | No — connection string | N/A | Migrations (`supabase db push`) |

## The ES256 workaround problem (commit `82b268d`)

### What it does

Supabase CLI ≥ 2.78 switched GoTrue to ES256 JWT signing. The `SERVICE_ROLE_KEY` from `supabase status` is still HS256-signed. Commit `82b268d` works around this by:

1. Reaching into the `supabase_auth_*` Docker container for `GOTRUE_JWT_KEYS`
2. Extracting GoTrue's EC private key
3. Hand-signing a JWT: `{iss: "supabase-local", role: "service_role", exp: 9999999999}`
4. Using that as `SUPABASE_SECRET_KEY` in `.env.local`

### Why this is wrong

1. **Violates the principle**: Application/tooling code should never sign JWTs — that's the auth service's job
2. **Fragile**: Reaches into Docker container internals (container naming, env var format)
3. **Incomplete JWT**: Missing standard claims (`sub`, `aud`, `iat`) that services may expect
4. **Likely only needed for GoTrue admin calls**: PostgREST and Storage may still accept the HS256 key (they may use a different JWT secret config). The only GoTrue admin calls in this codebase are in test setup (`auth.admin.createUser/deleteUser`)

### Upstream status (as of March 2026)

This is a known issue cluster. The relevant fixes have landed:

- **[supabase/cli#4818](https://github.com/supabase/cli/pull/4818)** — Fixed `auth.admin.*` calls with service role key. Confirmed working in **CLI ≥ 2.76.4** (Feb 2026). This was the specific breakage our workaround addressed.
- **[supabase/cli#4721](https://github.com/supabase/cli/pull/4721)** — Added hybrid JWT verification to Edge Functions (merged March 10, 2026). Accepts both HS256 and ES256 tokens automatically.
- **[supabase/supabase#42037](https://github.com/supabase/supabase/issues/42037)** — Main issue thread. Fix confirmed: `supabase status -o env` now outputs working keys.

**The workaround in commit `82b268d` was valid for CLI 2.71–2.76.3 but is now unnecessary.**

Related open issues (no action needed from us):
- [supabase/cli#4726](https://github.com/supabase/cli/issues/4726) — Feature request for `jwt_algorithm` config option in `config.toml` (not yet merged, but we don't need it)

### What to do

1. **Require Supabase CLI ≥ 2.76.4** — add a version check in `local-dev.sh`
2. **Delete the ES256 workaround** — the keys from `supabase status -o json` work as-is on ≥ 2.76.4
3. **Use keys from CLI directly** — no manual JWT construction, no Docker introspection

## Current naming mess

The same two Supabase values are accessed under **6 different env var names**:

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
  │
  ├── ANON_KEY (JWT, role=anon) ──┬── NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  │                               │     ├── web/lib/supabase/client.ts (browser)
  │                               │     ├── web/lib/supabase/server.ts (SSR)
  │                               │     ├── web/lib/supabase/proxy.ts
  │                               │     ├── web/components/agent/actions.ts
  │                               │     ├── web/lib/utils.ts
  │                               │     └── web/instrumentation.ts
  │                               │
  │                               └── SMGR_API_KEY
  │                                     ├── web/lib/auth/cli-auth.ts
  │                                     ├── web/__tests__/integration/setup.ts
  │                                     ├── web/__tests__/integration/globalSetup.ts
  │                                     └── .github/workflows/ci.yml
  │
  ├── SERVICE_ROLE_KEY (JWT, role=service_role)
  │                               ┬── SUPABASE_SECRET_KEY
  │                               │     ├── web/bin/smgr.ts:49 (primary)
  │                               │     ├── web/instrumentation.ts:12
  │                               │     ├── web/__tests__/integration/setup.ts:11
  │                               │     ├── web/__tests__/integration/smgr-cli.test.ts
  │                               │     ├── web/__tests__/integration/smgr-e2e.test.ts
  │                               │     ├── .github/workflows/ci.yml
  │                               │     └── scripts/local-dev.sh
  │                               │
  │                               └── SUPABASE_SERVICE_ROLE_KEY
  │                                     ├── web/bin/smgr.ts:49 (fallback)
  │                                     ├── web/app/api/health/route.ts:14
  │                                     ├── web/lib/agent/core.ts:50
  │                                     ├── web/__tests__/agent-core.test.ts
  │                                     └── web/__tests__/phone-migration-app.test.ts
  │
  ├── S3_PROTOCOL_ACCESS_KEY_ID (plain string) ── AWS_ACCESS_KEY_ID
  ├── S3_PROTOCOL_ACCESS_KEY_SECRET (plain string) ── AWS_SECRET_ACCESS_KEY
  └── DB_URL (connection string) ── DATABASE_URL
```

## Proposed consolidation

### Target: 4 Supabase env vars (down from 6+)

| Canonical env var | Replaces | Who reads it |
|-------------------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | `SMGR_API_URL` | Web app + CLI |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `SMGR_API_KEY` | Web app + CLI |
| `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_SECRET_KEY` | Server code + CLI + tests |
| `DATABASE_URL` | (unchanged) | Direct DB access |

**Why `SUPABASE_SERVICE_ROLE_KEY` over `SUPABASE_SECRET_KEY`?**
- Matches Supabase dashboard naming
- Self-documenting: it's the service role key, not an encryption key or API secret
- "Secret key" is ambiguous

**Why drop `SMGR_API_URL` / `SMGR_API_KEY`?**
- They're aliases for `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- One value should have one name
- The CLI can read the standard Supabase names directly

### Migration approach

1. **Add CLI version check** to `scripts/local-dev.sh` — require ≥ 2.76.4, error with link to upstream issue if older
2. **Remove ES256 workaround** from `scripts/local-dev.sh` (lines 61-91) — keys from `supabase status` work as-is
3. **Update `local-dev.sh` output** to use canonical names only
4. **Update CLI** (`web/bin/smgr.ts`): Read `SUPABASE_SERVICE_ROLE_KEY` directly, remove fallback
5. **Update CLI auth** (`web/lib/auth/cli-auth.ts`): Read `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
6. **Update instrumentation** (`web/instrumentation.ts`): Validate `SUPABASE_SERVICE_ROLE_KEY`
7. **Update integration tests**: Use canonical names in `setup.ts`, `globalSetup.ts`, test files
8. **Update CI workflow** (`.github/workflows/ci.yml`): Use canonical names
9. **Update `.env.example` files**: Single set of names with clear comments
10. **Update `docs/ENV_VARS.md`**: Document canonical names and why each is a JWT or not

## Files to change

| File | Change |
|------|--------|
| `scripts/local-dev.sh` | Remove ES256 workaround (lines 61-91), output canonical names |
| `web/bin/smgr.ts` | Read canonical names, remove `SUPABASE_SECRET_KEY` / `SMGR_API_URL` fallbacks |
| `web/lib/auth/cli-auth.ts` | Read `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| `web/instrumentation.ts` | Validate `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY` |
| `web/__tests__/integration/setup.ts` | Use canonical names |
| `web/__tests__/integration/globalSetup.ts` | Use canonical names |
| `web/__tests__/integration/smgr-cli.test.ts` | Use canonical names |
| `web/__tests__/integration/smgr-e2e.test.ts` | Use canonical names |
| `.github/workflows/ci.yml` | Use canonical names throughout |
| `web/.env.example` | Consolidate to canonical names |
| `.env.example` | Consolidate to canonical names |
| `docs/ENV_VARS.md` | Update documentation |
| `scripts/setup/verify.sh` | Check canonical names |
