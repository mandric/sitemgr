# 09-local-dev-setup — Spec

## Overview

Improve the local development setup experience through two phases: (1) component-scoped documentation
that clearly defines what each subsystem needs and how to verify it, and (2) automation that composes
those components into a reliable, idempotent setup flow. The goal is that a developer can get from
zero to passing integration tests in one command, and can debug any step independently.

---

## Analysis: Current State & Problems

### What Exists

| Asset | Purpose | Location |
|---|---|---|
| `scripts/setup.sh` | Install npm deps | Root |
| `scripts/local-dev.sh` | Start Supabase + generate `.env.local` | Root |
| `scripts/test-integration.sh` | Start Supabase + run vitest integration project | Root |
| `tests/integration_test.sh` | Shell-based integration test suite (legacy) | Root |
| `docs/TESTING.md` | Testing philosophy, overview | `docs/` |
| `docs/QUICKSTART.md` | Production deploy guide | `docs/` |
| `.env.example` | Deploy/CI env var template | Root |
| `web/.env.example` | Minimal web env var template | `web/` |

### Problems

**1. Monolithic setup script with brittle extraction**

`local-dev.sh` extracts S3 credentials by grepping table-formatted output from `supabase status`:

```bash
S3_ACCESS_KEY_ID=$(echo "$STATUS_TABLE" | grep "Access Key" | awk -F '│' '{print $3}' | tr -d ' ')
```

This breaks silently when Supabase CLI changes its output format. There is no validation that the
extracted values are non-empty before writing `.env.local`.

**2. Env vars written to file but not exported for tests**

`local-dev.sh` writes `.env.local` but the integration test runner (`test-integration.sh`) must
re-extract and `export` the same vars separately. They can get out of sync. A developer who runs
`local-dev.sh` and then tries `npm run test:integration` directly will get failures because the
vitest globalSetup reads `process.env`, not `.env.local`.

**3. No verification step**

There is no script that simply answers: "Is my local environment healthy right now?" After running
`local-dev.sh`, a developer doesn't know if Supabase storage is accessible, if the `media` bucket
exists, or if migrations applied successfully.

**4. No component-level entry points**

To understand what the CLI needs, a developer must read `local-dev.sh` top to bottom and infer
which vars belong to which component. There is no canonical answer to "what does the smgr CLI
need to run?" or "what does the integration test suite need?"

**5. `ENCRYPTION_KEY_CURRENT` not provisioned locally**

`local-dev.sh` does not generate or stub an encryption key. The web app and some server-side
paths require `ENCRYPTION_KEY_CURRENT`. A developer running the web app locally will hit errors
unless they discover this themselves.

**6. Two competing integration test runners**

`tests/integration_test.sh` (shell-based, legacy) and `web/__tests__/integration/` (vitest-based,
current) are both present. The legacy shell runner is referenced in `docs/TESTING.md` but is not
the canonical path. This creates confusion about which one to use.

**7. `.env.example` files are incomplete**

- Root `.env.example` is for CI/deploy only, doesn't include local dev vars.
- `web/.env.example` is minimal (4 lines) and missing encryption keys, CLI vars, S3 vars.
- No example for local dev fixture values (safe to commit).

**8. No idempotency**

Running `local-dev.sh` a second time re-runs `supabase start` (which prints a warning if already
running) and overwrites `.env.local`. This is mostly harmless but signals the script wasn't
designed for repeated runs.

---

## Components & Their Env Vars

Each subsystem has a distinct set of required env vars. These should be documented and validated
independently before being composed.

### Component 1: Supabase (DB + Auth + Storage)

**Managed by:** Supabase CLI (`supabase start`)
**Provides:** All connection details as outputs

| Env Var | Source | Used By |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `supabase status` → `API_URL` | Web app (browser + server) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `supabase status` → `ANON_KEY` | Web app (browser) |
| `SUPABASE_SECRET_KEY` | `supabase status` → `SERVICE_ROLE_KEY` | Web app (server), CLI, tests |
| `DATABASE_URL` | `supabase status` → `DB_URL` | Direct Postgres (optional) |
| `S3_ACCESS_KEY_ID` | `supabase status` → `S3_ACCESS_KEY` | S3 client, CLI |
| `S3_SECRET_ACCESS_KEY` | `supabase status` → `S3_SECRET_KEY` | S3 client, CLI |

**Verify:** `curl -sf http://127.0.0.1:54321/rest/v1/ -H "apikey: <anon_key>"` returns 200.

### Component 2: S3 / Storage

**Depends on:** Component 1 (Supabase running)
**Setup action:** Create `media` bucket if it doesn't exist

| Env Var | Value | Used By |
|---|---|---|
| `SMGR_S3_ENDPOINT` | `http://localhost:54321/storage/v1/s3` | CLI, S3 client |
| `SMGR_S3_BUCKET` | `media` | CLI, S3 client |
| `SMGR_S3_REGION` | `local` | S3 client |
| `S3_ENDPOINT_URL` | Same as `SMGR_S3_ENDPOINT` | AWS SDK |

**Verify:** List bucket objects returns without auth error.

### Component 3: Web Application (Next.js)

**Depends on:** Component 1
**Additional vars needed for full functionality:**

| Env Var | Local Value | Required For |
|---|---|---|
| `ENCRYPTION_KEY_CURRENT` | Generated or fixed test fixture | Encrypting phone numbers at rest |
| `ANTHROPIC_API_KEY` | Real key or skip | LLM enrichment and agent |
| `TWILIO_ACCOUNT_SID` | Optional, skip locally | WhatsApp webhook |
| `TWILIO_AUTH_TOKEN` | Optional, skip locally | WhatsApp webhook |
| `TWILIO_WHATSAPP_FROM` | Optional, skip locally | WhatsApp webhook |

**Verify:** `curl http://localhost:3000/api/health` returns 200.

### Component 4: CLI (smgr)

**Depends on:** Components 1 + 2
**Can be configured independently from the web app:**

| Env Var | Value | Notes |
|---|---|---|
| `SMGR_API_URL` | `http://localhost:54321` | Same as `NEXT_PUBLIC_SUPABASE_URL` |
| `SMGR_API_KEY` | Anon key | Same as `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| `SMGR_DEVICE_ID` | `local-dev` | Identifies the device in watch/enrich |
| `SMGR_AUTO_ENRICH` | `false` | Disable auto-enrichment in local dev |
| `SMGR_USER_ID` | (from `smgr login`) | Or set directly; falls back to stored session |

**Verify:** `npm run smgr stats` exits 0.

### Component 5: Integration Tests (Vitest)

**Depends on:** Components 1 + 2
**Requires env vars to be *exported* in the shell, not just in `.env.local`:**

| Env Var | Source |
|---|---|
| `SMGR_API_URL` | Same as Supabase URL |
| `SMGR_API_KEY` | Supabase anon key |
| `SUPABASE_SECRET_KEY` | Supabase service role key |

The vitest `globalSetup.ts` probes `http://$SMGR_API_URL/rest/v1/` before any tests run and fails
fast with a helpful error if Supabase is unreachable. This is the correct behavior and should be
preserved.

**Verify:** `vitest run --project integration` passes after `supabase start`.

---

## Scope

### Phase 1: Documentation (no behavior change)

**Goal:** Every component has a single authoritative doc that answers: what does it need, how do
I start it, how do I verify it, and how do I reset it?

**Deliverables:**

- `docs/setup/README.md` — Index and 5-minute quickstart
- `docs/setup/supabase.md` — Start/stop/reset Supabase, what it provides
- `docs/setup/storage.md` — Create buckets, verify storage, S3 vars
- `docs/setup/web-app.md` — Run Next.js locally, required env vars, health check
- `docs/setup/cli.md` — Use the smgr CLI locally, login flow
- `docs/setup/integration-tests.md` — Run integration tests, env var requirements, reset

Update `docs/TESTING.md` to remove references to the legacy `tests/integration_test.sh` runner
as the primary path. Clarify that the vitest integration suite is canonical.

Update `.env.example` at the root and `web/.env.example` with clearly labelled sections per
component, including local fixture values for encryption keys.

### Phase 2: Component Scripts

**Goal:** Each component gets a small, focused script that handles its own setup and verification.
Scripts are composable — the top-level orchestrator calls them.

**Deliverables:**

```
scripts/
  setup/
    supabase.sh          # Start Supabase + write env vars to stdout or a file
    storage.sh           # Create buckets, verify access
    env.sh               # Generate/update .env.local from current supabase status
    verify.sh            # Health-check all components, report status
  local-dev.sh           # (updated) orchestrator: calls setup/* scripts
  test-integration.sh    # (updated) source env + run vitest integration
```

**Key design principles:**

- **Scripts write env vars to stdout** (in `export KEY=VALUE` format), not directly to `.env.local`.
  The caller decides whether to `eval`, pipe to a file, or export. This makes scripts composable.
- **Idempotent** — running any script twice has the same effect as running it once. Bucket creation
  uses "if not exists" logic. `supabase start` is guarded by checking if already running.
- **Verified extraction** — use `supabase status --output json` for all key/URL extraction. Validate
  all extracted values are non-empty before proceeding. Fail loudly with a clear error if any value
  is missing.
- **`verify.sh` is the debugging entry point** — a developer who is stuck runs `./scripts/setup/verify.sh`
  and gets a component-by-component health report with pass/fail for each check.

### Phase 3: Env File Consolidation (optional, lower priority)

**Goal:** Eliminate the disconnect between `.env.local` (written by setup) and the env vars that
tests need exported.

**Option A:** `test-integration.sh` sources `.env.local` and exports the relevant vars automatically.
Simple, low-risk. The env file becomes the source of truth.

**Option B:** Introduce a `scripts/setup/env.sh` that both generates `.env.local` and can emit
`export` statements for the current shell via `eval "$(./scripts/setup/env.sh)"`. Tests and the web
app both use the same source of truth.

Prefer Option A unless Option B is needed for CI parity.

---

## Key Decisions

- **Don't replace `supabase status`** — trust the CLI's own output rather than re-implementing
  discovery. Just use the JSON output format (`-o json`) instead of parsing table text.
- **Encryption key in local dev** — generate a random 32-byte hex key on first setup and write it to
  `.env.local` as `ENCRYPTION_KEY_CURRENT`. This is not a secret for local dev. Document that it
  should not be committed.
- **Ollama is optional** — `test-integration.sh` already supports `--skip-ollama`. Keep this and
  default to skipping. Document separately in `docs/setup/integration-tests.md`.
- **Legacy shell test runner** — `tests/integration_test.sh` is kept but not promoted. Add a
  deprecation notice in its header pointing to the vitest suite.
- **No Docker Compose** — Supabase CLI handles all local services. Don't add a separate Docker
  Compose file for local dev (per existing CLAUDE.md decision).

---

## Implementation Order

1. `docs/setup/supabase.md` — highest value, most referenced component
2. `docs/setup/integration-tests.md` — unblocks testing immediately
3. Updated `web/.env.example` — clarifies required vars for web app
4. `docs/setup/README.md` — links the above into a quickstart
5. `scripts/setup/supabase.sh` — replaces brittle extraction in `local-dev.sh`
6. `scripts/setup/verify.sh` — debugging entry point
7. `scripts/setup/env.sh` — consolidates env var generation
8. Updated `scripts/local-dev.sh` — calls component scripts
9. Updated `scripts/test-integration.sh` — sources env file, removes duplication
10. Remaining docs: `cli.md`, `web-app.md`, `storage.md`

---

## Dependencies

**Depends on:**
- 01-data-foundation (Supabase schema, migrations, RLS)
- 02-media-pipeline (S3 integration, CLI commands)
- 06-integration-tests-cicd (vitest integration test suite)

**Provides to:**
- All future specs (reliable local environment reduces setup friction for any new work)

---

## Out of Scope

- Preview environment setup (separate Supabase project — backlog)
- Production secrets management (documented in `docs/ENV_VARS.md`)
- CI/CD pipeline changes (covered in 06-integration-tests-cicd)
- Ollama/local LLM setup (optional path, documented separately)
