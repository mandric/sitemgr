# Claude Spec: Local Dev Setup Improvement

## Combined from: spec.md + research + interview

---

## What We're Building

A reliable, idempotent local development setup for sitemgr that takes a developer from zero to passing integration tests in a single command, with clear diagnostics at each step.

The work is organized in two tracks that run together (not sequentially):
1. **Fix critical bugs** in existing scripts (S3 extraction, missing encryption key, env var drift)
2. **Add new docs and scripts** (quickstart narrative, verify.sh, component scripts)

---

## Why This Is Needed

The current setup has several silent failure modes:

- `local-dev.sh` parses table-formatted terminal output with `awk -F '│'` to extract S3 credentials. This breaks when Supabase CLI changes its table formatting, and extracted values can silently be empty strings written into `.env.local`.
- `ENCRYPTION_KEY_CURRENT` is never generated locally. The web app requires it; a developer running `next dev` hits errors and must discover this themselves.
- `.env.local` is written by `local-dev.sh` but integration tests need vars *exported* in the shell. `test-integration.sh` re-extracts the same vars independently — the two can drift.
- No verification step: setup "succeeds" even when bucket creation fails or env vars are empty.
- The legacy `tests/integration_test.sh` references `python3 prototype/smgr.py` which doesn't exist in the current codebase, creating confusion about which test runner is canonical.

---

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Priority order | Scripts before docs | Scripts stay current; docs rot. Fix silent failures first. |
| S3 credential extraction | `supabase status -o env` + `eval` | Structured output, not table parsing. CLI-version-stable. |
| Bucket creation | SQL migration with `ON CONFLICT DO NOTHING` | Auto-runs on `supabase start` and `db reset`. No shell needed. |
| ENCRYPTION_KEY_CURRENT local value | Generate random 32-byte hex on first setup | Developer doesn't need to think about it; not a secret for local dev. |
| Env var source of truth | `.env.local` | `test-integration.sh` sources it instead of re-extracting. Eliminates drift. |
| Component script output | Write directly to `.env.local` | Simple. Developer sources the file after. |
| Verify depth | Basic (API reachable + env vars non-empty) | Fast feedback. vitest globalSetup already provides deeper integration check. |
| Doc format | Quickstart narrative (linear) | One flow a developer reads top-to-bottom on first setup. |
| Legacy `tests/integration_test.sh` | Delete | References non-existent files, creates confusion. |
| `set -euo pipefail` | Add to all scripts | Prevents silent failures from unset vars and pipeline errors. |

---

## Scope

### Part 1: Script Fixes (Critical)

**1a. Fix `scripts/local-dev.sh`**

- Add `set -euo pipefail` at top
- Replace table parsing with `eval "$(supabase status -o env)"`
- Map local CLI var names to `.env.local` names explicitly:
  - `API_URL` → `NEXT_PUBLIC_SUPABASE_URL`, `SMGR_API_URL`
  - `ANON_KEY` → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SMGR_API_KEY`
  - `SERVICE_ROLE_KEY` → `SUPABASE_SECRET_KEY`
  - `S3_PROTOCOL_ACCESS_KEY_ID` → `S3_ACCESS_KEY_ID`
  - `S3_PROTOCOL_ACCESS_KEY_SECRET` → `S3_SECRET_ACCESS_KEY`
- Generate `ENCRYPTION_KEY_CURRENT` if not already in `.env.local`:
  ```bash
  if ! grep -q "ENCRYPTION_KEY_CURRENT=" .env.local 2>/dev/null; then
    ENCRYPTION_KEY_CURRENT=$(openssl rand -hex 32)
  fi
  ```
- Guard `supabase start` idempotently:
  ```bash
  if supabase status > /dev/null 2>&1; then
    echo "Supabase already running."
  else
    supabase start
  fi
  ```
- Validate all extracted values are non-empty before writing `.env.local`
- Remove bucket creation curl call (moved to migration)

**1b. Fix `scripts/test-integration.sh`**

- Source `.env.local` and export relevant vars instead of re-extracting:
  ```bash
  if [ -f .env.local ]; then
    set -a; source .env.local; set +a
  else
    echo "ERROR: .env.local not found. Run ./scripts/local-dev.sh first." >&2
    exit 1
  fi
  ```
- Remove duplicate `supabase status` extraction
- Keep: `--skip-ollama` flag, Ollama start logic, vitest invocation

**1c. Fix `scripts/setup.sh`**

- Add `set -euo pipefail`
- Add prerequisite check for `supabase` CLI and `jq` (collect all, report at once)

**1d. Fix `.env.example` (root)**

- Replace `ENCRYPTION_KEY=` with `ENCRYPTION_KEY_CURRENT=` (status-based naming)
- Add `ENCRYPTION_KEY_PREVIOUS=` (optional, for rotation)
- Add comment: `# See docs/ENV_VARS.md for key rotation procedure`

**1e. Fix `web/.env.example`**

- Add missing vars: `ENCRYPTION_KEY_CURRENT`, `SUPABASE_SECRET_KEY`, S3 vars
- Organize into sections: Supabase, S3, CLI, Encryption, Optional (Twilio, Anthropic)

**1f. Delete `tests/integration_test.sh`**

Remove the legacy shell test runner. It references `python3 prototype/smgr.py` which no longer exists.

---

### Part 2: Storage Bucket Migration

**New file: `supabase/migrations/YYYYMMDD_create_media_bucket.sql`**

```sql
-- Create default media storage bucket
-- This runs automatically on supabase start and supabase db reset
INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', false)
ON CONFLICT (id) DO NOTHING;
```

This replaces the `curl -X POST .../bucket` call in `local-dev.sh`.

---

### Part 3: New Scripts

**`scripts/setup/verify.sh`**

A fast health check that a developer can run at any time to answer "is my environment healthy?":

```
Checking local dev environment...
  ✓ Supabase API reachable (http://127.0.0.1:54321)
  ✓ SMGR_API_KEY is set
  ✓ SUPABASE_SECRET_KEY is set
  ✓ ENCRYPTION_KEY_CURRENT is set
  ✓ S3_ACCESS_KEY_ID is set
All checks passed.
```

Checks:
1. `curl -sf $SMGR_API_URL/rest/v1/ -H "apikey: $SMGR_API_KEY"` returns 200
2. Required env vars are non-empty: `SMGR_API_URL`, `SMGR_API_KEY`, `SUPABASE_SECRET_KEY`, `ENCRYPTION_KEY_CURRENT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`

Does not check Storage (bucket access) or DB directly — vitest globalSetup covers integration-level validation.

---

### Part 4: Quickstart Narrative Doc

**`docs/setup/README.md`** — One linear flow, top to bottom:

```
# Local Development Setup

## Prerequisites
- supabase CLI
- Docker
- Node.js 20+
- jq

## First-time setup (< 5 minutes)

1. Install dependencies:  ./scripts/setup.sh
2. Start Supabase + configure env:  ./scripts/local-dev.sh
3. Load env vars:  source .env.local
4. Verify:  ./scripts/setup/verify.sh

## Running tests

Unit tests (no Supabase required):
  cd web && npm test

Integration tests (Supabase must be running):
  ./scripts/test-integration.sh

## Resetting

supabase db reset    # Reset DB + re-run migrations (recreates media bucket)
./scripts/local-dev.sh   # Refresh .env.local if keys changed

## Stopping

supabase stop
```

Keep it short. Link to component details only where they add value (e.g., `docs/ENV_VARS.md` for key rotation, `docs/TESTING.md` for test philosophy).

Update `docs/TESTING.md` to remove references to `tests/integration_test.sh` as a runner path.

---

## Out of Scope

- Preview environment setup
- Production secrets management
- CI/CD pipeline changes
- Ollama/local LLM setup docs (optional path, already documented in test-integration.sh comments)
- `make` / `Makefile` — not needed given existing npm scripts and shell scripts

---

## Implementation Order

1. Add storage bucket migration
2. Fix `scripts/local-dev.sh` (S3 extraction + encryption key + idempotent start)
3. Fix `scripts/test-integration.sh` (source .env.local)
4. Fix `scripts/setup.sh` (strict mode + prereq check)
5. Fix `.env.example` and `web/.env.example`
6. Delete `tests/integration_test.sh`
7. Add `scripts/setup/verify.sh`
8. Write `docs/setup/README.md`
9. Update `docs/TESTING.md`
