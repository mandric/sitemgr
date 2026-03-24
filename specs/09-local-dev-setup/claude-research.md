# Research: Local Dev Setup Improvement

## Sources
- Codebase analysis (scripts, docs, env files, test infrastructure)
- Web research: idempotent shell scripts, DX onboarding patterns, Supabase CLI scripting

---

## 1. Codebase Findings

### What Works Well

- **Supabase local stack** — `supabase start` provides the full environment in one command. This is already the right foundation.
- **Shared test utilities** — `web/__tests__/integration/setup.ts` provides solid abstractions: `createTestUser()`, `seedUserData()`, `cleanupUserData()`, `getAdminClient()`. These are well-designed.
- **`globalSetup.ts` fast-fail** — The vitest globalSetup probes Supabase before running any tests and fails fast with an actionable error. This behavior should be preserved.
- **`scripts/lib.sh`** — Contains reusable functions (`smoke_test`, `vercel_log_check`, `wait_for_vercel_deployment`) designed to be sourced by other scripts. Good abstraction exists already.
- **`scripts/test-integration.sh`** — Already has `--skip-ollama` flag, idempotent Supabase start logic, and exports env vars correctly before running vitest.

### Critical Problems Confirmed

#### 🔴 S3 credential extraction is brittle
`scripts/local-dev.sh` lines 52–53 parse table-formatted terminal output:
```bash
AWS_ACCESS_KEY_ID=$(echo "$STATUS_TABLE" | grep "Access Key" | awk -F '│' '{print $3}' | tr -d ' ')
```
This breaks silently when Supabase CLI changes table formatting. The values can silently come out empty and get written to `.env.local` without validation.

**Fix**: Use `supabase status -o env` (direct shell export format) or `-o json` with `jq`. The `-o env` approach is cleanest — it can be `eval`'d directly.

#### 🔴 `ENCRYPTION_KEY_CURRENT` not generated locally
`local-dev.sh` never generates or stubs an encryption key. `docs/ENV_VARS.md` specifies `ENCRYPTION_KEY_CURRENT` as required for the web app. A developer running `next dev` locally will hit errors without it.

Additionally, root `.env.example` still contains the deprecated `ENCRYPTION_KEY=` (not `ENCRYPTION_KEY_CURRENT`). `scripts/deploy.sh` also references the old name. This is a latent production bug.

#### 🔴 No env var validation before tests
No script validates all required vars are set and non-empty before running integration tests. Missing vars produce cryptic "undefined" errors rather than a clear "SMGR_API_KEY is not set" message.

#### 🟡 `.env.local` written but not exported for tests
`local-dev.sh` writes `.env.local`. Integration tests need vars *exported* in the shell, not just in a file. A developer who runs `local-dev.sh` then `npm run test:integration` directly will get silent failures because vitest reads `process.env`, not `.env.local`.

`test-integration.sh` re-extracts and exports vars independently. The two can drift.

#### 🟡 No verification step
No script answers: "Is my environment healthy right now?" Setup "succeeds" even when bucket creation fails, when env vars come out empty, or when Supabase Storage is unreachable.

#### 🟡 No component-level entry points
A developer wanting to know "what does the CLI need?" must read all of `local-dev.sh` and infer. There is no canonical per-component doc or script.

#### 🟡 Two competing integration test runners
`tests/integration_test.sh` (bash-based, legacy, references `python3 prototype/smgr.py` which may not exist) and `web/__tests__/integration/` (vitest, canonical) coexist. `docs/TESTING.md` references the legacy runner as a primary path.

### Environment Variable Inconsistencies

| Issue | Location | Impact |
|---|---|---|
| `ENCRYPTION_KEY` (deprecated) vs `ENCRYPTION_KEY_CURRENT` | `.env.example`, `scripts/deploy.sh` | Production failure |
| `SMGR_API_URL` vs `NEXT_PUBLIC_SUPABASE_URL` | Used interchangeably, no clear mapping | Confusion |
| AWS credentials fallback to `SUPABASE_SECRET_KEY` | `local-dev.sh`, `setup.ts` | Anti-pattern (undocumented) |
| `web/.env.example` missing encryption keys, S3 vars | `web/.env.example` | Incomplete reference |

### Existing Setup Flow (As-Is)
```
scripts/setup.sh          → install npm deps
scripts/local-dev.sh      → start Supabase + write .env.local
source .env.local         → must be done manually (not enforced)
cd web && npm test        → unit tests only (no Supabase needed)
scripts/test-integration.sh → start Supabase (again) + export vars + run vitest integration
```

The duplication between `local-dev.sh` and `test-integration.sh` (both start Supabase, both extract vars) is the root cause of drift.

---

## 2. Shell Script Best Practices

### Strict Mode Header
Every setup script should start with:
```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
```
- `set -e`: exit on any non-zero command
- `set -u`: error on unset variables (catches typos like `$SUPAABSE_URL`)
- `set -o pipefail`: propagate failure through pipes
- `IFS=$'\n\t'`: prevent word-splitting on spaces

**Caveat**: `set -e` has edge cases (commands in `if` conditions don't trigger exit). Pair with `trap` for robust error handling.

### Check-Before-Act (Idempotency)
```bash
# GOOD: guard before every side effect
if supabase status > /dev/null 2>&1; then
  echo "Supabase already running."
else
  supabase start
fi

# GOOD: idempotent bucket creation via SQL migration
INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', false)
ON CONFLICT (id) DO NOTHING;
```

Built-in idempotent shell commands to prefer: `mkdir -p`, `touch`, `rm -f`, `ln -sfn`.

### Prerequisite Validation — Fail Loudly and Early
Collect all missing prerequisites before any side effects, then fail with actionable messages:
```bash
check_prereqs() {
  local missing=()
  command -v supabase &>/dev/null || missing+=("supabase CLI (brew install supabase/tap/supabase)")
  command -v jq       &>/dev/null || missing+=("jq (brew install jq)")
  command -v node     &>/dev/null || missing+=("node 20+ (https://nodejs.org)")
  if [ ${#missing[@]} -gt 0 ]; then
    echo "ERROR: Missing required tools:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    exit 1
  fi
}
```
- Error messages go to stderr (`>&2`)
- Include the fix/URL, not just the problem
- Report all missing tools at once

### Overwrite, Don't Append
Config files should always be overwritten, never appended to:
```bash
# GOOD: idempotent (same input → same output)
cat > .env.local <<EOF
KEY=$VALUE
EOF

# BAD: accumulates duplicates on each run
echo "KEY=$VALUE" >> .env.local
```

### Error Trap
```bash
cleanup() {
  local exit_code=$?
  [ $exit_code -ne 0 ] && echo "ERROR: Setup failed (exit $exit_code). Check output above." >&2
}
trap cleanup EXIT
```

**Sources**: arslan.io/idempotent-bash-scripts, redsymbol.net/unofficial-bash-strict-mode, lloydatkinson.net/bash-frictions-2024

---

## 3. Supabase CLI Scripting Patterns

### Use `-o env` for Extraction (Not Table Parsing)
`supabase status` supports structured output formats. The `-o env` flag emits shell `KEY=VALUE` pairs directly:

```bash
# BEST: eval the env output directly
eval "$(supabase status -o env)"
# Now $API_URL, $ANON_KEY, $SERVICE_ROLE_KEY, $DB_URL, etc. are set

# ALTERNATIVE: parse JSON
STATUS=$(supabase status -o json)
API_URL=$(echo "$STATUS" | jq -r '.API_URL')
ANON_KEY=$(echo "$STATUS" | jq -r '.ANON_KEY')
```

Key names from `supabase status -o env`:
```
API_URL
ANON_KEY
SERVICE_ROLE_KEY
DB_URL
JWT_SECRET
S3_PROTOCOL_ACCESS_KEY_ID
S3_PROTOCOL_ACCESS_KEY_SECRET
S3_PROTOCOL_REGION
GRAPHQL_URL
INBUCKET_URL
```

Note: local CLI uses unprefixed names (`ANON_KEY`, `API_URL`) while hosted Supabase uses `SUPABASE_ANON_KEY`, `SUPABASE_URL`. Map them explicitly in scripts.

### Idempotent `supabase start`
```bash
if supabase status > /dev/null 2>&1; then
  echo "Supabase already running."
else
  supabase start
fi
```
`supabase status` exits non-zero when the stack is not running — usable as a detection mechanism.

### Storage Bucket Creation — Prefer SQL Migration
The best approach is a migration with `ON CONFLICT DO NOTHING`:
```sql
-- supabase/migrations/YYYYMMDD_create_media_bucket.sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', false)
ON CONFLICT (id) DO NOTHING;
```
This runs automatically on `supabase start` and `supabase db reset`. No shell script needed.

**Alternative** (for buckets that can't be in migrations): use the Storage REST API with a `409 Conflict` guard:
```bash
HTTP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
  -X POST "$API_URL/storage/v1/bucket" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"media","name":"media","public":false}')
[[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "409" ]] || {
  echo "ERROR: Failed to create bucket (HTTP $HTTP_STATUS)" >&2; exit 1
}
```

**Sources**: supabase.com/docs/reference/cli, github.com/supabase/cli/issues/3968, supabase.com/docs/guides/storage/buckets/creating-buckets

---

## 4. DX Onboarding Patterns

### Component-Scoped + Orchestrator Pattern
Best practice: each component gets its own focused script, plus a top-level orchestrator.

```
scripts/
  setup/
    supabase.sh     ← start + extract vars
    storage.sh      ← create buckets (idempotent)
    env.sh          ← generate .env.local
    verify.sh       ← health check all components
  local-dev.sh      ← orchestrator (calls setup/* in sequence)
```

Each component script is independently runnable and idempotent. The orchestrator sequences them and handles failures clearly.

### Documentation vs Scripts
Docs rot; scripts stay current. `README` should describe *intent* ("run `./scripts/local-dev.sh`"), scripts encode *mechanics*. This eliminates drift between docs and reality.

### Verification After Setup
Never assume setup succeeded. Always verify:
```bash
# After starting Supabase
curl -sf http://127.0.0.1:54321/rest/v1/ \
  -H "apikey: $ANON_KEY" > /dev/null \
  || { echo "ERROR: Supabase API not responding" >&2; exit 1; }
echo "✓ Supabase API reachable"
```

A dedicated `verify.sh` that developers can run at any time is a strong DX pattern.

**Sources**: github.com/readme/guides/developer-onboarding, garden.io/blog/developer-onboarding

---

## 5. Testing Infrastructure Notes

The existing vitest integration test setup is sound and should not be changed:
- `globalSetup.ts`: fast-fail health check before tests — keep as-is
- `setup.ts`: shared utilities for user/data management — well-designed
- `fileParallelism: false`: correct for integration tests that share a DB
- Two projects (`unit`, `integration`): clean separation

The test infrastructure does not need redesign. The gap is in *setup automation* that gets the environment to the state where `npm run test:integration` succeeds without manual steps.

The key insight: `scripts/test-integration.sh` already does this correctly (exports vars before running vitest). The improvement is making `local-dev.sh` align with it so developers don't need two separate scripts for "dev setup" vs "run tests".
