# Usage Guide: Local Dev Setup

## Quick Start

Full local dev setup, from fresh clone to running tests:

```bash
# 1. Validate tools and install npm deps
./scripts/setup.sh

# 2. Start Supabase (idempotent)
./scripts/local-dev.sh

# 3. Write env vars to .env.local
./scripts/local-dev.sh print_setup_env_vars > .env.local

# 4. Confirm environment is healthy
./scripts/setup/verify.sh

# 5. Run unit tests (no Supabase needed)
cd web && npm test

# 6. Run integration tests
./scripts/test-integration.sh
```

See `docs/setup/README.md` for the full quickstart narrative.

## Files Created / Modified

### New files
- `scripts/setup/verify.sh` — environment health checker (checks vars + Supabase reachability)
- `docs/setup/README.md` — local dev quickstart documentation

### Modified files
- `scripts/local-dev.sh` — rewritten to use `supabase status -o json` + `jq`; added `print_setup_env_vars` subcommand; added idempotent start; added `set -euo pipefail`; removed bucket creation curl
- `scripts/test-integration.sh` — simplified: sources `.env.local` instead of running `supabase status`; removed bucket creation curl; removed S3 credential fallback to `SUPABASE_SECRET_KEY`
- `scripts/setup.sh` — added `set -euo pipefail`; added prerequisite check for `supabase`, `docker`, `node` 20+, `npm`, `jq`
- `.env.example` — replaced `ENCRYPTION_KEY` with `ENCRYPTION_KEY_CURRENT`
- `web/.env.example` — reorganized into labelled sections (Supabase, S3, CLI, Encryption, Optional)
- `scripts/deploy.sh` — replaced deprecated `ENCRYPTION_KEY` with `ENCRYPTION_KEY_CURRENT` in 2 locations
- `web/__tests__/integration/smgr-e2e.test.ts` — added `beforeAll`/`afterAll` bucket management

### Deleted files
- `tests/integration_test.sh`
- `tests/seed_test_data.sh`
- `tests/README.md`

## verify.sh — Checks Performed

```
  ✓ SMGR_API_URL is set
  ✓ SMGR_API_KEY is set
  ✓ SUPABASE_SECRET_KEY is set
  ✓ ENCRYPTION_KEY_CURRENT is set
  ✓ AWS_ACCESS_KEY_ID is set
  ✓ AWS_SECRET_ACCESS_KEY is set
  ✓ Supabase API reachable
  All checks passed.
```

Exits 0 on success, 1 if any checks fail (all failures shown before exit).

## local-dev.sh Subcommands

```bash
./scripts/local-dev.sh                          # Start Supabase (idempotent)
./scripts/local-dev.sh print_setup_env_vars     # Print .env.local vars to stdout
./scripts/local-dev.sh print_setup_env_vars > .env.local  # Save to file
```

## test-integration.sh Flags

```bash
./scripts/test-integration.sh               # Run all integration tests
./scripts/test-integration.sh --skip-ollama # Skip optional AI enrichment E2E suite
```

## Resetting

```bash
supabase db reset                                                 # Wipe DB, replay migrations
./scripts/local-dev.sh print_setup_env_vars > .env.local         # Regenerate .env.local
supabase stop                                                     # Stop all services
```
