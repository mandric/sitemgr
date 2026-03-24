# Integration Notes: Opus Review Feedback

## What I'm Integrating

### 1. `eval` safety → use filtered `-o env` (HIGH)
The review flags `eval "$(supabase status -o env)"` as a footgun if the CLI emits non-assignment lines. Integrating the recommendation to pipe through `grep '^[A-Z_]*='` before eval. Additionally, the S3 credential keys (`S3_PROTOCOL_ACCESS_KEY_ID`, `S3_PROTOCOL_ACCESS_KEY_SECRET`) appear in the `-o env` output per the Supabase CLI docs (confirmed in research). The `-o json` output does not consistently include them across CLI versions (issue #3968). So `-o env` with grep filtering is the right approach, not raw `jq` on JSON.

**Plan update:** Section 2 specifies `eval "$(supabase status -o env | grep '^[A-Z_]*=')"`.

### 2. Encryption key format: base64, not hex (HIGH)
The encryption code (`web/lib/crypto/encryption.ts`) uses `TextEncoder().encode(key)` — it treats the key as a raw UTF-8 string. The existing `.env.example` says `openssl rand -base64 32`. Changing plan to specify `openssl rand -base64 32` for consistency with existing documentation and to produce a 44-character base64 string.

**Plan update:** Section 2 specifies `openssl rand -base64 32`.

### 3. Remove bucket curl and S3 fallback from `test-integration.sh` (HIGH)
The review correctly identifies that Section 3 said "keep everything else unchanged" but did not explicitly call out removing the bucket creation curl (lines 74-78) and the S3 credential fallback to `SUPABASE_SECRET_KEY` (lines 85-86). Both should be removed — the migration handles bucket creation, and `.env.local` provides valid S3 credentials.

**Plan update:** Section 3 explicitly lists these two removals.

### 4. Encryption key preservation: explicit ordering (HIGH)
The review is right that the prose was ambiguous about when to read the existing key vs. overwrite the file. Adding an explicit three-step sequence to Section 2.

**Plan update:** Section 2 adds numbered steps: (1) read existing key, (2) generate if absent, (3) write file.

### 5. `deploy.sh` deprecated `ENCRYPTION_KEY` (MEDIUM)
This is a confirmed production bug. Adding as an explicit 10th section rather than leaving it out of scope. It's a two-line change (`ENCRYPTION_KEY` → `ENCRYPTION_KEY_CURRENT` in `scripts/deploy.sh`) and should ship with this work.

**Plan update:** New Section 10 added.

### 6. Definitively delete `tests/seed_test_data.sh` and `tests/README.md` (MEDIUM)
The review confirmed `seed_test_data.sh` references non-existent Python files at lines 39, 93, 97. Making the decision definitive in Section 6: delete both files. Regarding `tests/edge_function_bucket_test.ts` and `tests/edge_function_scan_test.ts` — these are TypeScript files and may still be referenced by something. Adding a note to check if they are referenced by any CI workflow before deleting; if not, delete them too.

**Plan update:** Section 6 is more explicit.

### 7. Add bucket existence check to `verify.sh` (MEDIUM)
The review makes a good point: bucket non-existence was the most common silent failure and should be verified. One HTTP request to `$SMGR_API_URL/storage/v1/bucket/media`. Adding to Section 7.

**Plan update:** Section 7 adds bucket check.

### 8. Specify `SMGR_S3_ENDPOINT` derivation (MEDIUM)
The `-o env` output from Supabase CLI does not include a pre-constructed S3 URL. It must be constructed as `$API_URL/storage/v1/s3`. Adding this to the variable mapping table in Section 2.

**Plan update:** Section 2 variable mapping table includes `SMGR_S3_ENDPOINT` and `S3_ENDPOINT_URL` as derived from `$API_URL`.

### 9. Update printed instructions at end of `local-dev.sh` (MEDIUM)
The script currently prints "Run integration tests: `./tests/integration_test.sh`". This must change to `./scripts/test-integration.sh`. Adding to Section 2.

**Plan update:** Section 2 notes to update printed instructions.

### 10. `source .env.local` in quickstart (LOW)
The review correctly notes that bare `source .env.local` doesn't export variables. Changing the quickstart to either use `set -a; source .env.local; set +a` or remove that step entirely. I'm choosing to remove it: Next.js reads `.env.local` natively, and `test-integration.sh` handles its own sourcing. The manual source step is unnecessary and error-prone.

**Plan update:** Section 8 removes the `source .env.local` step.

---

## What I'm NOT Integrating

### `jq` dependency change
The review asks whether `jq` remains needed if we switch to `-o env`. Since we're using grep-filtered `eval "$(supabase status -o env | grep '^[A-Z_]*=')"`, `jq` is no longer needed in `local-dev.sh`. But `jq` is a useful general tool and the prereq check in `setup.sh` can still require it (it may be needed by other scripts). Keeping `jq` in the prereq list.

### `IFS=$'\n\t'` in all scripts
The review suggests adding it to all scripts. I'm only adding it to `local-dev.sh` and `setup.sh` where path/variable values could contain spaces. `test-integration.sh` and `verify.sh` deal with URLs and simple strings that won't have spaces. Not worth the added complexity in every script.
