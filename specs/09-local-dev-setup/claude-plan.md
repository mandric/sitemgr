# Implementation Plan: Local Dev Setup Improvement

## Context

sitemgr is a Next.js + TypeScript application backed by Supabase (Postgres, Auth, Storage) with an S3-compatible media pipeline and a CLI tool (`smgr`). Local development relies on the Supabase CLI, which starts the full stack in Docker.

The local setup has accumulated several silent failure modes: brittle shell parsing that breaks when the Supabase CLI changes its output format, a required encryption key that is never generated for local use, two scripts that independently extract the same environment variables and can drift out of sync, and a legacy test runner that references files that no longer exist. This plan covers nine targeted changes that together make the local setup reliable and self-diagnosing.

---

## Goals

1. Eliminate all silent failure modes in existing setup scripts
2. Make `.env.local` the single source of truth for local environment variables
3. Generate a local encryption key automatically on first setup
4. Provide a `verify.sh` that gives immediate feedback on environment health
5. Write a single linear quickstart document

---

## What Is Not Changing

The vitest integration test infrastructure (`globalSetup.ts`, `setup.ts`, test files, vitest config) is not modified. The `globalSetup.ts` fast-fail behavior is preserved and complemented by the new `verify.sh`.

---

## Note on Storage Bucket Initialization

The existing `local-dev.sh` creates a `media` storage bucket via `curl`. This is not needed and should be removed. The main integration tests (`media-storage.test.ts`, `media-lifecycle.test.ts`) already create and destroy their own isolated buckets per test run — they never use a pre-existing `media` bucket. The only test that hardcodes `SMGR_S3_BUCKET: "media"` is `smgr-e2e.test.ts`, the optional Ollama E2E suite. That test should create its own bucket in `beforeAll` (see Section 6).

---

## Section 1: Fix `scripts/local-dev.sh`

### Why

This script has four independent problems:

**Problem 1: Table parsing.** The script extracts S3 credentials by running `supabase status` (plain terminal output) and using `awk -F '│'` with Unicode box-drawing characters. This depends on the CLI's internal table formatter — an implementation detail that can change without notice. Extracted values can silently be empty strings.

**Problem 2: Missing encryption key.** The script never sets `ENCRYPTION_KEY_CURRENT`. The web application requires it for encrypting sensitive data at rest — specifically, secret keys users provide when configuring their own S3-compatible storage buckets (`web/lib/crypto/encryption-versioned.ts`). A developer running `next dev` after setup will encounter errors.

**Problem 3: Non-idempotent start.** `supabase start` is called unconditionally. When Supabase is already running, this prints an error and may confuse the developer about whether setup succeeded.

**Problem 4: No value validation.** The script writes to `.env.local` without checking that extracted values are non-empty.

### What to Build

Rewrite `scripts/local-dev.sh` with the following changes:

**Strict mode:** Add `set -euo pipefail` and `IFS=$'\n\t'` at the top.

**Idempotent Supabase start:** Check before calling start:
```
if supabase status; then
  echo "Supabase already running, skipping start."
else
  supabase start
fi
```

**`print_setup_env_vars` function:** Replace all `supabase status` table parsing with a `print_setup_env_vars` function that reads `supabase status -o json`, extracts the relevant values via `jq`, and prints them to stdout in dotenv format (`KEY=value`). The script does not write `.env.local` — the user pipes the output themselves:

```
./scripts/local-dev.sh print_setup_env_vars > .env.local
```

The function also generates and prints `ENCRYPTION_KEY_CURRENT=$(openssl rand -base64 32)` as part of its output. Always generate a fresh key — local dev data is ephemeral. Key format is base64 to match the existing `.env.example` documentation.

Variable mapping from CLI output to printed vars:

| `supabase status -o json` key | Printed var(s) |
|---|---|
| `API_URL` | `NEXT_PUBLIC_SUPABASE_URL`, `SMGR_API_URL` |
| `ANON_KEY` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SMGR_API_KEY` |
| `SERVICE_ROLE_KEY` | `SUPABASE_SECRET_KEY` |
| `DB_URL` | `DATABASE_URL` |
| `S3_PROTOCOL_ACCESS_KEY_ID` | `S3_ACCESS_KEY_ID` |
| `S3_PROTOCOL_ACCESS_KEY_SECRET` | `S3_SECRET_ACCESS_KEY` |
| `$API_URL/storage/v1/s3` (derived) | `SMGR_S3_ENDPOINT`, `S3_ENDPOINT_URL` |

The function should also include fixed CLI vars (`SMGR_S3_BUCKET=media`, `SMGR_S3_REGION=local`, `SMGR_DEVICE_ID=local-dev`, `SMGR_AUTO_ENRICH=false`) and commented-out placeholders for optional vars (`ANTHROPIC_API_KEY`, Twilio vars).

**Remove bucket creation:** Remove the `curl -X POST .../bucket` call entirely.

**Update printed instructions:** Replace the reference to `./tests/integration_test.sh` with `./scripts/test-integration.sh`. Add instructions for capturing env vars:

```
To save environment variables:
  ./scripts/local-dev.sh print_setup_env_vars > .env.local
```

---

## Section 2: Fix `scripts/test-integration.sh`

### Why

This script re-extracts environment variables from `supabase status` independently, duplicating logic from `local-dev.sh`. If a variable name changes in one script, the other doesn't automatically follow. It also creates the `media` bucket via `curl` (not needed) and has an undocumented fallback that uses `SUPABASE_SECRET_KEY` as S3 credentials when extraction fails — an anti-pattern that should not be silently relied upon.

### What to Build

Make the following targeted changes to `test-integration.sh`:

**Source `.env.local`:** Replace the entire `supabase status` extraction block with:
```
if [ ! -f ".env.local" ]; then
  echo "ERROR: .env.local not found. Run ./scripts/local-dev.sh first." >&2
  exit 1
fi
set -a
source .env.local
set +a
```

`set -a` / `set +a` wraps the source to auto-export all variables to child processes. This replaces all `export VAR=...` lines that followed the extraction.

**Remove bucket creation:** Remove the `curl -X POST .../bucket` block. No pre-created bucket is needed.

**Remove S3 credential fallback:** Remove the fallback that sets `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` to `SUPABASE_SECRET_KEY` when extraction fails. When `.env.local` is the source of truth, this fallback is unreachable and should not exist as silent behavior.

**Keep everything else:** Idempotent Supabase start guard, `--skip-ollama` flag, Ollama start and wait loop, vitest invocation, dependency checks.

---

## Section 3: Fix `scripts/setup.sh`

### Why

This script installs npm dependencies but has no strict mode and no prerequisite validation. A missing tool causes a confusing mid-script error rather than a clear diagnostic.

### What to Build

Add `set -euo pipefail` at the top. Add a prerequisite check function before any side effects:

- Collect missing tools into an array, report all at once (not one at a time)
- Check: `supabase` (with brew install hint), `docker` (with docs URL), `node` 20+ (with version check), `npm`, `jq` (with brew install hint)
- Error messages go to stderr with the tool name and install instruction

---

## Section 4: Fix `.env.example` Files

### Why

The root `.env.example` still uses the deprecated `ENCRYPTION_KEY=` name. `web/.env.example` is minimal and missing S3 vars, encryption key, and service role key. These are reference files — when they're wrong, developers configure the wrong variable names.

### What to Build

**Root `.env.example`:**
- Replace `ENCRYPTION_KEY=` with `ENCRYPTION_KEY_CURRENT=`
- Add `ENCRYPTION_KEY_PREVIOUS=` (commented, with note: only needed during key rotation)
- Add comment: `# See docs/ENV_VARS.md for key rotation procedure`
- Add comment near `ENCRYPTION_KEY_CURRENT=`: `# Generate with: openssl rand -base64 32`

**`web/.env.example`:** Reorganize into clearly labelled sections:
- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (with note: server-only, never expose to browser)
- S3 / Storage: `SMGR_S3_ENDPOINT`, `SMGR_S3_BUCKET`, `SMGR_S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT_URL`
- CLI: `SMGR_API_URL`, `SMGR_API_KEY`, `SMGR_DEVICE_ID`, `SMGR_AUTO_ENRICH`
- Encryption: `ENCRYPTION_KEY_CURRENT` (with note: auto-generated by `local-dev.sh` for local dev)
- Optional: `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (all commented out)

---

## Section 5: Delete Legacy Test Files

### Why

`tests/integration_test.sh` references `python3 prototype/smgr.py` which no longer exists (the CLI was rewritten in TypeScript). It creates confusion about which test runner is canonical. `tests/seed_test_data.sh` also references the same non-existent Python prototype at multiple lines. `tests/README.md` promotes both as the primary test path.

### What to Build

Delete the following files:
- `tests/integration_test.sh`
- `tests/seed_test_data.sh`
- `tests/README.md`

For `tests/edge_function_bucket_test.ts` and `tests/edge_function_scan_test.ts`: check whether these are referenced by any CI workflow (`.github/workflows/`). If they are not referenced, delete them. If they are referenced, leave them and note as a separate cleanup item.

Update `docs/TESTING.md` to remove any reference to `tests/integration_test.sh` or shell-based test runners as a primary path. The canonical integration test path is `./scripts/test-integration.sh` (which runs the vitest integration project).

---

## Section 6: Fix `smgr-e2e.test.ts` Bucket Dependency

### Why

`web/__tests__/integration/smgr-e2e.test.ts` hardcodes `SMGR_S3_BUCKET: "media"` and uploads to and cleans up from a bucket named `media` directly. This is the only test that assumes a pre-existing bucket — all other integration tests (`media-storage.test.ts`, `media-lifecycle.test.ts`) create and destroy their own isolated buckets per run using `admin.storage.createBucket()`.

Now that `local-dev.sh` no longer pre-creates the `media` bucket, this test will fail unless it manages its own bucket.

### What to Build

Add a `beforeAll` block to `smgr-e2e.test.ts` that creates the `media` bucket using `admin.storage.createBucket("media", { public: false })`, treating a "bucket already exists" error as non-fatal (in case it was created by a previous run). Add a corresponding `afterAll` that removes any objects the test uploaded, consistent with the existing cleanup pattern on lines 170. Do not delete the bucket itself in `afterAll` since `media` may be a meaningful name for other manual testing — just clean up the test's own objects.

---

## Section 7: Add `scripts/setup/verify.sh`

### Why

After running `local-dev.sh`, a developer has no way to quickly confirm the environment is healthy without running the full test suite. A dedicated verify script provides immediate, component-level feedback.

### What to Build

A new script at `scripts/setup/verify.sh` that runs a series of checks and reports pass/fail for each, then exits non-zero if any check failed. Wrap each check in a function so a single failure doesn't stop the remaining checks — the developer sees all failures at once.

**Checks to perform:**
1. Required env vars are non-empty: `SMGR_API_URL`, `SMGR_API_KEY`, `SUPABASE_SECRET_KEY`, `ENCRYPTION_KEY_CURRENT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
2. Supabase API reachable: `curl -sf "$SMGR_API_URL/rest/v1/" -H "apikey: $SMGR_API_KEY"` returns 200

**Output format:** Each check prints `  ✓ <description>` or `  ✗ <description>: <reason>`. At the end: "All checks passed." (exit 0) or "N check(s) failed." (exit 1).

**Env var sourcing:** Source `.env.local` with `set -a; source .env.local; set +a` before running checks, so it works when called directly without the developer having manually sourced the file.

---

## Section 8: Write `docs/setup/README.md`

### Why

Setup instructions are scattered across `docs/TESTING.md`, `docs/QUICKSTART.md` (which covers production deployment, not local dev), and the end of `scripts/local-dev.sh`. A developer starting fresh must read multiple documents.

### What to Build

A single linear document at `docs/setup/README.md`, under 100 lines, structured as a top-to-bottom narrative.

**Structure:**

*Prerequisites* — Bulleted list: `supabase CLI`, Docker, Node.js 20+, `jq`, each with a one-line install command.

*First-time setup* — Three numbered steps:
1. `./scripts/setup.sh` — validates tools, installs npm deps
2. `./scripts/local-dev.sh` — starts Supabase, generates `.env.local` including a generated encryption key
3. `./scripts/setup/verify.sh` — confirms Supabase is reachable and env vars are set

*Running tests*:
- Unit: `cd web && npm test` (no Supabase required)
- Integration: `./scripts/test-integration.sh` (sources `.env.local` automatically)

*Resetting*:
- `supabase db reset` — wipes and replays migrations; `.env.local` is unaffected
- Re-run `./scripts/local-dev.sh` if Supabase keys change (safe to re-run, preserves `ENCRYPTION_KEY_CURRENT`)

*Stopping*: `supabase stop`

*Troubleshooting*: Run `./scripts/setup/verify.sh` first. Then `supabase logs`. Links to `docs/ENV_VARS.md` and `docs/TESTING.md`.

---

## Section 9: Fix `scripts/deploy.sh` Deprecated Key Name

### Why

`scripts/deploy.sh` references `ENCRYPTION_KEY` (the deprecated name) at two locations. `docs/ENV_VARS.md` specifies that `ENCRYPTION_KEY` was removed and replaced by `ENCRYPTION_KEY_CURRENT`. This is a latent production bug.

### What to Build

Find the two references to `ENCRYPTION_KEY` in `scripts/deploy.sh`. Change both to `ENCRYPTION_KEY_CURRENT`. Update any surrounding comments. Also check `scripts/lib.sh` and `.github/workflows/` for any remaining references to the deprecated name.

---

## Verification Approach

After all sections are implemented, a developer starting from a fresh clone should be able to run:

```
./scripts/setup.sh
./scripts/local-dev.sh
./scripts/setup/verify.sh   # all checks pass
./scripts/test-integration.sh
```

The verify script passes after `local-dev.sh` completes (API reachable, env vars set). Integration tests pass without any additional configuration. Re-running `local-dev.sh` is safe and preserves the encryption key.
