I now have all the context needed to write the section. Here is the complete section content:

# Section 01: Fix `scripts/local-dev.sh`

## Overview

Rewrite `scripts/local-dev.sh` to eliminate four independent silent failure modes in the current implementation. The rewrite introduces strict mode, idempotent Supabase start, JSON-based credential extraction (replacing fragile table parsing), automatic encryption key generation, and a `print_setup_env_vars` subcommand that outputs dotenv format to stdout. The script no longer writes `.env.local` directly — that becomes an explicit user action.

## Background

The current script (`scripts/local-dev.sh`) has these problems:

1. **Table parsing.** S3 credentials are extracted with `awk -F '│'` against Unicode box-drawing characters in `supabase status` plain-text output. This is an internal CLI formatting detail that can change silently, leaving `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as empty strings with no error.

2. **Missing encryption key.** The script never sets `ENCRYPTION_KEY_CURRENT`. The web application (`web/lib/crypto/encryption-versioned.ts`) requires it for encrypting data at rest. A developer running `next dev` after setup will encounter runtime errors immediately.

3. **Non-idempotent start.** `supabase start` is called unconditionally. When Supabase is already running, this prints an error and may confuse the developer about whether setup succeeded.

4. **No value validation.** The script writes to `.env.local` without verifying extracted values are non-empty.

## Files to Modify

- `/Users/mandric/dev/github.com/mandric/sitemgr/scripts/local-dev.sh` — full rewrite

## Dependencies

This section has no dependencies on other sections. Sections 02 (`test-integration.sh`) and 07 (`verify.sh`) depend on this section completing first because they rely on the `print_setup_env_vars` output and `.env.local` contract established here.

## Tests (Verification Steps)

There is no automated unit test framework for shell scripts. The following manual verification sequence must pass after the rewrite:

```bash
# Test: idempotent start — run twice, second should print status not error
./scripts/local-dev.sh
./scripts/local-dev.sh  # must not error

# Test: print_setup_env_vars outputs valid dotenv format (KEY=value lines)
./scripts/local-dev.sh print_setup_env_vars | grep -E '^[A-Z_]+=.+'

# Test: all required vars are present in output
./scripts/local-dev.sh print_setup_env_vars | grep NEXT_PUBLIC_SUPABASE_URL
./scripts/local-dev.sh print_setup_env_vars | grep ENCRYPTION_KEY_CURRENT
./scripts/local-dev.sh print_setup_env_vars | grep AWS_ACCESS_KEY_ID

# Test: redirect to file produces sourceable output
./scripts/local-dev.sh print_setup_env_vars > .env.local.test
set -a; source .env.local.test; set +a
echo $SMGR_API_URL  # should print http://127.0.0.1:54321
rm .env.local.test

# Test: no .env.local written by default (script has no file side-effects)
rm -f .env.local
./scripts/local-dev.sh
[ ! -f .env.local ] && echo "PASS: no file written" || echo "FAIL: file was written"
```

**Failure modes to verify are gone:**
- Run script with Supabase not running — must fail with a clear error, not silent empty vars
- Confirm no `awk -F '│'` or `grep "Access Key"` patterns remain in the script
- Confirm no `curl -X POST .../bucket` call remains

## Implementation

### Strict mode and IFS

Add at the very top of the script (after the shebang and any comment header):

```bash
set -euo pipefail
IFS=$'\n\t'
```

### Idempotent Supabase start

Replace the unconditional `supabase start` call with:

```bash
if supabase status > /dev/null 2>&1; then
  echo "Supabase already running, skipping start."
else
  supabase start
fi
```

### `print_setup_env_vars` function

Add a function named `print_setup_env_vars` that:

1. Runs `supabase status -o json` and stores the result. If the command fails or returns empty output, print an error to stderr and exit non-zero.
2. Uses `jq -r` to extract each field. All field names from the JSON are uppercase (e.g., `API_URL`, `ANON_KEY`, `S3_PROTOCOL_ACCESS_KEY_ID`).
3. Derives `SMGR_S3_ENDPOINT` and `AWS_ENDPOINT_URL_S3` from `API_URL` by appending `/storage/v1/s3`.
4. Generates `ENCRYPTION_KEY_CURRENT` fresh with `openssl rand -base64 32`. Always generate a new key — local dev data is ephemeral.
5. Prints all variables in dotenv format (`KEY=value`) to stdout.
6. Includes commented-out placeholders for optional vars.

Variable mapping (JSON key → dotenv variable(s)):

| `supabase status -o json` key | Printed dotenv variable(s) |
|---|---|
| `API_URL` | `NEXT_PUBLIC_SUPABASE_URL`, `SMGR_API_URL` |
| `ANON_KEY` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SMGR_API_KEY` |
| `SERVICE_ROLE_KEY` | `SUPABASE_SECRET_KEY` |
| `DB_URL` | `DATABASE_URL` |
| `S3_PROTOCOL_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` |
| `S3_PROTOCOL_ACCESS_KEY_SECRET` | `AWS_SECRET_ACCESS_KEY` |
| `$API_URL/storage/v1/s3` (derived) | `SMGR_S3_ENDPOINT`, `AWS_ENDPOINT_URL_S3` |

Fixed CLI vars (always printed with these literal values):

```
SMGR_S3_BUCKET=media
SMGR_S3_REGION=local
SMGR_DEVICE_ID=local-dev
SMGR_AUTO_ENRICH=false
```

Commented-out optional vars (printed as comments, not active assignments):

```
# ANTHROPIC_API_KEY=
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_WHATSAPP_FROM=
```

After printing all vars, validate that none of the required variables are empty. If any are empty, print an error to stderr listing the empty variable names and exit non-zero.

### Subcommand dispatch

At the end of the script, add a dispatch block that checks `$1` (with a default of empty) and routes to `print_setup_env_vars` when the argument is `print_setup_env_vars`. The default behavior (no argument) runs the Supabase start flow and prints the quick start instructions.

```bash
COMMAND="${1:-}"
case "$COMMAND" in
  print_setup_env_vars)
    print_setup_env_vars
    ;;
  "")
    # default: start Supabase, print instructions
    ...
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    echo "Usage: $0 [print_setup_env_vars]" >&2
    exit 1
    ;;
esac
```

### Remove bucket creation

Delete the entire `curl -X POST .../bucket` block. Do not replace it with anything. The integration tests (`media-storage.test.ts`, `media-lifecycle.test.ts`) create their own isolated buckets. The `smgr-e2e.test.ts` bucket dependency is fixed in Section 06.

### Update printed instructions

In the quick start instructions block at the end of the default command path:

- Replace `./tests/integration_test.sh` with `./scripts/test-integration.sh`
- Add an instruction for capturing env vars:

```
To save environment variables:
  ./scripts/local-dev.sh print_setup_env_vars > .env.local
```

- Remove the instruction `source $ENV_FILE` (the script no longer writes the file by default)

## Acceptance Criteria

- Running `./scripts/local-dev.sh` twice does not error on the second run
- Running `./scripts/local-dev.sh print_setup_env_vars | grep -c '='` returns at least 12 lines
- `./scripts/local-dev.sh print_setup_env_vars | grep ENCRYPTION_KEY_CURRENT` returns a non-empty base64 value
- `./scripts/local-dev.sh print_setup_env_vars | grep AWS_ACCESS_KEY_ID` returns the actual Supabase local S3 key (not empty, not a fallback literal like `local-access-key`)
- No `awk`, `grep "Access Key"`, or `grep "Secret Key"` patterns remain in the script
- No `curl` bucket-creation call remains in the script
- Running the script with Supabase stopped exits non-zero with a clear message