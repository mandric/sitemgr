# Local Development Setup

## Prerequisites

- **supabase CLI** — `brew install supabase/tap/supabase`
- **Docker** — https://docs.docker.com/get-docker/
- **Node.js 20+** — `brew install node` or https://nodejs.org
- **jq** — `brew install jq`

## First-time Setup

1. `./scripts/setup.sh` — validates required tools and installs npm dependencies
2. `./scripts/local-dev.sh` — starts Supabase (idempotent; safe to re-run if already running)
3. `./scripts/local-dev.sh print_setup_env_vars > .env.local` — writes `.env.local` with all required vars including a generated encryption key
4. `./scripts/setup/verify.sh` — confirms Supabase is reachable and all required env vars are set

## Running Tests

- **Unit tests:** `cd web && npm test` — no Supabase required
- **Integration tests:** `./scripts/test-integration.sh` — sources `.env.local` automatically; add `--skip-ollama` to skip the optional AI enrichment E2E suite

## Resetting

- `supabase db reset` — wipes the local database and replays migrations; `.env.local` is unaffected
- Re-run `./scripts/local-dev.sh print_setup_env_vars > .env.local` if Supabase keys change (safe to re-run; generates a new encryption key each time — this is intentional since local dev data is ephemeral)

## Stopping

`supabase stop`

## Troubleshooting

- Run `./scripts/setup/verify.sh` first — it reports which checks fail and why
- Run `supabase logs` to inspect service output
- See `docs/ENV_VARS.md` for encryption key details and rotation procedure
- See `docs/TESTING.md` for full testing strategy
