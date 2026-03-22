# Section 1: Remove ES256 Workaround from `local-dev.sh`

## Background

`scripts/local-dev.sh` contains a `print_setup_env_vars` function that extracts credentials from `supabase status -o json` and emits a `.env.local` file. Lines 61-91 contain a workaround that reaches into Docker containers to find GoTrue's ES256 key, then uses Node.js to hand-sign a service-role JWT. This was necessary on older Supabase CLI versions where GoTrue rejected HS256 tokens when configured with EC key pairs.

This workaround is no longer needed on Supabase CLI >= 2.76.4, where `supabase status -o json` returns keys that work as-is. The workaround should be deleted. Additionally, the service role key should no longer be emitted as an active env var in the generated output --- it should be commented out with a note that it is for tests and admin scripts only. Application code never reads it.

## Dependencies

None. This section has no dependencies and can be implemented first.

## Files to Modify

- `/home/user/sitemgr/scripts/local-dev.sh` -- remove ES256 block, add capability probe, update env output

## Files to Create

- `/home/user/sitemgr/web/__tests__/integration/local-dev-output.test.ts` -- new integration test

---

## Tests (write first)

Create the test file at `/home/user/sitemgr/web/__tests__/integration/local-dev-output.test.ts`. These tests shell out to `scripts/local-dev.sh print_setup_env_vars` and parse the output. They require `supabase start` (integration test suite).

```
Test: print_setup_env_vars outputs NEXT_PUBLIC_SUPABASE_URL
Test: print_setup_env_vars outputs NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
Test: print_setup_env_vars outputs SMGR_API_URL and SMGR_API_KEY
Test: print_setup_env_vars does NOT output SUPABASE_SECRET_KEY (old name)
Test: print_setup_env_vars outputs SUPABASE_SERVICE_ROLE_KEY as a comment (not active env var)
Test: print_setup_env_vars outputs valid dotenv format (no syntax errors)
Test: capability probe succeeds when Supabase is running (service role key accepted by GoTrue)
```

Each test should invoke the script via `execSync` or `execFileSync`, capture stdout, and assert against the output lines. The test for "outputs as a comment" should verify the line starts with `#` (e.g., `# SUPABASE_SERVICE_ROLE_KEY=...`). The test for "valid dotenv format" should verify that every non-comment, non-blank line matches the pattern `KEY=value`. The capability probe test should verify the script completes without error (exit code 0), which implicitly confirms the probe passed.

---

## Implementation Details

### Step 1: Delete the ES256 workaround block (lines 61-91)

Remove the entire block from `local supabase_secret_key=...` through the closing `fi` on line 91. This includes:

- The `supabase_secret_key` variable assignment
- The `auth_container` Docker lookup
- The `gotrue_jwt_keys` extraction
- The Node.js `crypto.sign` inline script
- All the conditional branches

After deletion, the `service_role_key` variable (extracted from `supabase status` on line 35) is still available for use in the output.

### Step 2: Add a capability probe after key extraction

After the existing validation block (after the `missing` array check around line 55), and after the `s3_endpoint` and `encryption_key` assignments, add a capability probe. The probe should:

1. Make an HTTP request: `GET ${api_url}/auth/v1/admin/users?per_page=1` with `Authorization: Bearer ${service_role_key}`
2. Check the HTTP status code
3. If the request fails (non-2xx), print an error to stderr: `"Service role key rejected by GoTrue. Upgrade Supabase CLI to >= 2.76.4."` and exit 1

Use `curl` for the request since it is already available in the environment. A reasonable implementation:

```bash
local probe_status
probe_status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${service_role_key}" \
  -H "apikey: ${service_role_key}" \
  "${api_url}/auth/v1/admin/users?per_page=1")
if [ "$probe_status" -lt 200 ] || [ "$probe_status" -ge 300 ]; then
  echo "Error: Service role key rejected by GoTrue (HTTP ${probe_status})." >&2
  echo "Upgrade Supabase CLI to >= 2.76.4." >&2
  exit 1
fi
```

The `apikey` header is required by Supabase's API gateway (Kong) in addition to the `Authorization` header.

### Step 3: Update the env var output (the heredoc)

Replace the current `cat <<EOF` block with updated output. Key changes:

1. **Remove `SUPABASE_SECRET_KEY=${supabase_secret_key}`** -- this active env var line is deleted entirely.
2. **Add a commented-out service role key** at the bottom, in a clearly labeled section:

The new heredoc structure:

```
# --- Web app (Supabase) ---
NEXT_PUBLIC_SUPABASE_URL=${api_url}
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${anon_key}
DATABASE_URL=${db_url}

# --- CLI (auth provider -- same Supabase instance in local dev) ---
SMGR_API_URL=${api_url}
SMGR_API_KEY=${anon_key}

# --- S3 / Storage ---
SMGR_S3_ENDPOINT=${s3_endpoint}
AWS_ENDPOINT_URL_S3=${s3_endpoint}
SMGR_S3_BUCKET=media
SMGR_S3_REGION=local
AWS_ACCESS_KEY_ID=${s3_key_id}
AWS_SECRET_ACCESS_KEY=${s3_key_secret}

# --- smgr CLI ---
SMGR_DEVICE_ID=local-dev
SMGR_AUTO_ENRICH=false

# --- Encryption (generated fresh -- local dev data is ephemeral) ---
ENCRYPTION_KEY_CURRENT=${encryption_key}

# --- Service role key (tests and admin scripts only -- NOT for app code) ---
# SUPABASE_SERVICE_ROLE_KEY=${service_role_key}

# --- Optional -- uncomment and fill in as needed ---
# ANTHROPIC_API_KEY=
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_WHATSAPP_FROM=
```

Note the service role key line starts with `#` -- it is a comment in the generated `.env.local`. Tests and CI scripts that need it extract it separately from `supabase status -o json`. Application code never reads it from `.env.local`.

### What NOT to change

- The `start_supabase` function and subcommand dispatch at the bottom of the file remain unchanged.
- The validation logic for `supabase status -o json` output remains unchanged.
- The `s3_endpoint` and `encryption_key` derivations remain unchanged.
- The `service_role_key` is still extracted from `supabase status -o json` (line 35) -- it is needed for the probe and for the commented-out output line. Do not remove its extraction.

---

## Implementation Notes (post-build)

### Files modified
- `scripts/local-dev.sh` -- removed ES256 block (lines 61-91), added capability probe, updated heredoc output

### Files created
- `web/__tests__/integration/local-dev-output.test.ts` -- 7 integration tests for `print_setup_env_vars` output

### Deviations from plan
- **Added `000` status check in capability probe**: Code review identified that when GoTrue is unreachable, curl returns status `000`. Added explicit check with a distinct error message ("Could not reach GoTrue") before the existing HTTP status check, to avoid confusing connection failures with key rejections.
- **Moved `beforeAll` inside `describe` block**: Code review fix for proper variable scoping in test file.

### Tests
- 7 tests total (all require `supabase start` -- integration suite)