I now have all the information needed to generate the section content.

# Section 2: Fix `scripts/test-integration.sh`

## Overview

This section targets `scripts/test-integration.sh`. The script currently re-extracts environment variables from `supabase status` independently of `local-dev.sh`, duplicating brittle table-parsing logic. It also pre-creates a `media` storage bucket (not needed) and includes a silent S3 credential fallback that masks failures.

The fix makes `.env.local` the single source of truth: the script sources that file instead of re-extracting from Supabase, removes the bucket creation curl call, and removes the silent credential fallback.

## Dependency

This section depends on **section-01-local-dev-sh** being complete. Specifically, `local-dev.sh` must expose the `print_setup_env_vars` subcommand that produces a correctly populated `.env.local`. The integration test script assumes `.env.local` exists and is correct — it does not generate it.

## File to Modify

`/Users/mandric/dev/github.com/mandric/sitemgr/scripts/test-integration.sh`

## Tests First

These are manual verification steps to run after making changes (this is a shell script, not a TypeScript module):

```bash
# Test: fails clearly when .env.local missing
rm -f .env.local
./scripts/test-integration.sh 2>&1 | grep "env.local not found"
# Expected: non-zero exit and message containing "env.local not found"

# Test: succeeds when .env.local exists and Supabase is running
./scripts/local-dev.sh print_setup_env_vars > .env.local
./scripts/test-integration.sh --skip-ollama
# Expected: vitest integration suite runs and passes
```

**Failure modes to confirm are gone after the change:**

```bash
# Confirm no supabase status calls remain for env var extraction
grep "supabase status" scripts/test-integration.sh
# Expected: zero matches (or only the idempotent start guard, not for extraction)

# Confirm no S3 credential fallback to SUPABASE_SECRET_KEY remains
grep 'AWS_ACCESS_KEY_ID.*SUPABASE_SECRET_KEY\|SUPABASE_SECRET_KEY.*AWS' scripts/test-integration.sh
# Expected: zero matches
```

## What to Change

### 1. Replace `supabase status` extraction block with `.env.local` sourcing

**Remove** the entire block from line 57 through line 86 in the current file. This covers:
- `STATUS_JSON=$(supabase status -o json ...)` extraction
- All `jq` variable assignments (`SMGR_API_URL`, `SMGR_API_KEY`, `SUPABASE_SECRET_KEY`)
- All `export VAR=...` lines that follow
- The echo lines printing extracted values
- `STATUS_TABLE=$(supabase status ...)` and the `awk -F '│'` table-parsing lines for S3 keys
- The `AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-$SUPABASE_SECRET_KEY}"` fallback and its `export`

**Replace with** this block, inserted after the Supabase start guard (after the `fi` closing the start guard):

```bash
# ── Load environment ────────────────────────────────────────────

if [ ! -f ".env.local" ]; then
  echo "ERROR: .env.local not found. Run ./scripts/local-dev.sh first." >&2
  exit 1
fi
set -a
source .env.local
set +a
```

`set -a` / `set +a` wraps the source so all variables defined in `.env.local` are automatically exported to child processes. This replaces the individual `export VAR=value` lines that followed the old extraction.

### 2. Remove bucket creation curl call

**Remove** the entire block:

```bash
# Ensure the 'media' storage bucket exists (for S3 e2e tests)
STORAGE_ENDPOINT="$SMGR_API_URL/storage/v1"
curl -sf -X POST "$STORAGE_ENDPOINT/bucket" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"media","name":"media","public":false}' \
  2>/dev/null || true
```

This bucket creation is not needed. The main integration tests (`media-storage.test.ts`, `media-lifecycle.test.ts`) create and destroy their own isolated buckets per run. The only test that used a pre-existing `media` bucket (`smgr-e2e.test.ts`) is handled by section-06-smgr-e2e, which adds `beforeAll`/`afterAll` bucket management to that test file.

### 3. Remove the S3 credential fallback

**Remove** these lines (they fall within the block already removed in step 1, but call out explicitly):

```bash
# S3 credentials for storage tests
STATUS_TABLE=$(supabase status 2>/dev/null)
AWS_ACCESS_KEY_ID=$(echo "$STATUS_TABLE" | grep "Access Key" | awk -F '│' '{print $3}' | tr -d ' ')
AWS_SECRET_ACCESS_KEY=$(echo "$STATUS_TABLE" | grep "Secret Key" | awk -F '│' '{print $3}' | tr -d ' ')
# Fallback: use service key if S3 keys not found in status output
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-$SUPABASE_SECRET_KEY}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-$SUPABASE_SECRET_KEY}"
```

When `.env.local` is the source of truth (populated by `local-dev.sh print_setup_env_vars`), `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are already present with correct values. The fallback to `SUPABASE_SECRET_KEY` was an anti-pattern that silently masked extraction failures — it must not survive.

### 4. Keep everything else unchanged

The following elements remain exactly as-is:

- `set -euo pipefail` at the top
- `REPO_ROOT` derivation and `cd "$REPO_ROOT"`
- `--skip-ollama` flag parsing
- Dependency checks (`check_cmd` function and its invocations for `supabase`, `docker`, `jq`, `node`)
- `web/node_modules` check and `npm ci` install
- Idempotent Supabase start guard (`if supabase status -o json &>/dev/null; then ... else supabase start; fi`)
- Ollama start, health wait loop, and model pull
- `cd web && npx vitest run --project integration --reporter=verbose`

## Resulting Script Structure

After the changes, the high-level flow of the script is:

1. Parse `--skip-ollama` flag
2. Check dependencies (`supabase`, `docker`, `node`) — `jq` removed (no longer needed)
3. Install npm deps if missing
4. Idempotent Supabase start
5. **Source `.env.local`** (new — replaces all extraction logic)
6. Validate `SMGR_API_URL` is set (sentinel check for stale `.env.local`)
7. Optionally start Ollama and wait for health
8. Run vitest integration suite

## Implementation Notes (Actual)

**File modified:** `scripts/test-integration.sh`

**Deviations from plan (code review fixes):**

1. **Removed `check_cmd jq`**: `jq` is no longer used in the script after the extraction block was removed. The check was dead code that would incorrectly block developers who don't have `jq`.

2. **Added `SMGR_API_URL` sentinel check**: After `source .env.local`, checks that `SMGR_API_URL` is non-empty. A stale `.env.local` from an older `local-dev.sh` would otherwise silently produce confusing test failures at runtime.