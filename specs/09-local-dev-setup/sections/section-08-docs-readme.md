I have all the context needed to generate the section content.

# Section 8: Write `docs/setup/README.md`

## Overview

This section creates a new file at `docs/setup/README.md` — a single linear quickstart document for local development. It replaces the scattered setup instructions currently spread across `docs/TESTING.md` (which references legacy Python scripts and deleted shell runners), `docs/QUICKSTART.md` (which covers production deployment, not local dev), and the end of `scripts/local-dev.sh`.

The goal is a document under 100 lines that a developer can follow top-to-bottom on a fresh clone without consulting any other file.

## Dependencies

This section depends on:

- **Section 01** (`section-01-local-dev-sh`): `scripts/local-dev.sh` must have the `print_setup_env_vars` subcommand and idempotent start behavior before this doc is accurate.
- **Section 02** (`section-02-test-integration-sh`): `scripts/test-integration.sh` must source `.env.local` (not run its own `supabase status` extraction) before the test instructions here are valid.
- **Section 07** (`section-07-verify-sh`): `scripts/setup/verify.sh` must exist before this doc references it.

Do not write this section until sections 01, 02, and 07 are complete.

## Verification (Manual)

No automated tests apply to a documentation file. Manual review checklist:

- Follow the doc top-to-bottom on a fresh clone and verify every command works exactly as written
- Confirm no references to `tests/integration_test.sh` or Python commands (`python3 prototype/`)
- Confirm the three setup steps match the actual script interfaces implemented in sections 01, 03, and 07
- Confirm the `local-dev.sh` command on line 2 of "First-time setup" uses the `print_setup_env_vars > .env.local` form (not a bare `./scripts/local-dev.sh`)

## File to Create

**`docs/setup/README.md`** — new file, new directory. Create the `docs/setup/` directory if it does not exist.

The document must be under 100 lines. Structure it as described below.

## Document Structure

### Prerequisites

Bulleted list. Each bullet names the tool and provides a one-line install command. Required tools:

- `supabase` CLI — `brew install supabase/tap/supabase`
- Docker — link to https://docs.docker.com/get-docker/
- Node.js 20+ — `brew install node` or https://nodejs.org
- `jq` — `brew install jq`

### First-time Setup

Three numbered steps:

1. `./scripts/setup.sh` — validates tools, installs npm deps
2. `./scripts/local-dev.sh print_setup_env_vars > .env.local` — starts Supabase, writes `.env.local` with all required vars including a generated encryption key
3. `./scripts/setup/verify.sh` — confirms Supabase is reachable and all required env vars are set

Each step gets one sentence of explanation, no more.

### Running Tests

Two sub-items (not numbered steps, just a list):

- Unit tests: `cd web && npm test` — no Supabase required
- Integration tests: `./scripts/test-integration.sh` — sources `.env.local` automatically; add `--skip-ollama` to skip the optional AI enrichment E2E suite

### Resetting

Two sub-items:

- `supabase db reset` — wipes the local database and replays migrations; `.env.local` is unaffected
- Re-run `./scripts/local-dev.sh print_setup_env_vars > .env.local` if Supabase keys change (safe to re-run; generates a new encryption key each time — this is intentional since local dev data is ephemeral)

### Stopping

Single line: `supabase stop`

### Troubleshooting

- First step: run `./scripts/setup/verify.sh` — it reports which checks fail and why
- Second step: `supabase logs`
- Link to `docs/ENV_VARS.md` for encryption key details and rotation procedure
- Link to `docs/TESTING.md` for full testing strategy

## Notes for the Implementer

- Do not duplicate content from `docs/QUICKSTART.md`. That document covers production deployment to Supabase Cloud. This document covers local development only. They are separate concerns.
- Do not reference `tests/integration_test.sh`, `tests/seed_test_data.sh`, or any Python commands. Those are legacy artifacts deleted in Section 05.
- The encryption key is intentionally regenerated each time `print_setup_env_vars` is run. This is correct behavior — mention it in the Resetting section to avoid confusion when a developer wonders why their key changed.
- Keep the document short. The scripts do the work; the README just tells the developer in what order to run them.