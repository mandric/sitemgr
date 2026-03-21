# Review: Local Dev Setup Improvement Plan (Iteration 1)

## Overall Assessment

The plan is well-scoped, well-motivated, and addresses real problems confirmed by reading the existing scripts. The diagnosis is accurate -- the S3 table parsing is genuinely brittle, the encryption key gap is real, and the two-script extraction drift is a legitimate source of confusion. The implementation order is correct (migration before script fixes, script fixes before docs). There are, however, several concrete gaps and risks that need attention before implementation.

---

## 1. `eval "$(supabase status -o env)"` Is a Security and Correctness Risk

**Section 2** proposes replacing table parsing with `eval "$(supabase status -o env)"`. While the Supabase CLI is trusted software, `eval` on arbitrary output is a well-known footgun. If the CLI ever emits values containing shell metacharacters (semicolons, backticks, `$(...)`) or adds unexpected output lines (warnings, deprecation notices to stdout), the `eval` will execute them.

**Recommendation:** The existing script already uses `-o json` with `jq`. Before committing to `eval`, verify whether `S3_PROTOCOL_ACCESS_KEY_ID` and `S3_PROTOCOL_ACCESS_KEY_SECRET` are now present in the `-o json` output. If they are, stick with `jq`. If not, use `-o env` but pipe through `grep '^[A-Z_]*='` before `eval` to strip any non-assignment lines.

---

## 2. `test-integration.sh` Bucket Creation Not Addressed

**Section 3** says "keep everything else unchanged" but does not mention removing the bucket creation `curl` on lines 74-78 (same rationale as Section 1), or the S3 credential fallback to `SUPABASE_SECRET_KEY` (lines 85-86). Both should be removed.

---

## 3. Encryption Key Preservation -- Sequencing Not Explicit

Section 2 describes reading the existing key and overwriting the file in separate paragraphs without making sequencing explicit. An implementer could overwrite the file before reading the old key. The plan should state the order: (1) read existing key from `.env.local`, (2) generate new key if not found, (3) write `.env.local`.

---

## 4. `deploy.sh` Uses Deprecated `ENCRYPTION_KEY` -- Not Addressed

Research confirmed `scripts/deploy.sh` references the deprecated `ENCRYPTION_KEY` name at lines 36 and 139. The plan fixes `.env.example` files but drops this known production bug. Either add it to scope or explicitly backlog it.

---

## 5. `tests/seed_test_data.sh` -- Plan Leaves Decision Ambiguous

Section 6 says "check `seed_test_data.sh` and maybe delete it." The research confirmed it references `python3 prototype/smgr.py` at lines 39, 93, and 97. Make a definitive decision: delete it (recommended) along with `tests/README.md`. Also assess `tests/edge_function_*.ts` files.

---

## 6. `local-dev.sh` Printed Instructions Reference Legacy Runner

The current `local-dev.sh` prints "Run integration tests: `./tests/integration_test.sh`". Section 2 should note these instructions must be updated to reference `./scripts/test-integration.sh`.

---

## 7. Storage Bucket Migration Needs RLS Policy Check

The `INSERT INTO storage.buckets` creates the bucket but Supabase Storage access is governed by RLS on `storage.objects`. Verify whether existing migrations cover storage RLS. If not, the bucket will be unusable by non-service-role clients.

---

## 8. `source .env.local` Does Not Export Variables

The quickstart lists `source .env.local` as step 3, but this does not export variables to child processes. Use `set -a; source .env.local; set +a` instead, or drop this step (Next.js reads `.env.local` natively, and `test-integration.sh` handles its own sourcing).

---

## 9. `verify.sh` Should Check Bucket Exists

The most common silent failure was bucket non-existence. The verify script should include a check that `GET $SMGR_API_URL/storage/v1/bucket/media` with the service role key returns 200. One HTTP request.

---

## 10. `SMGR_S3_ENDPOINT` Derivation Not Specified

Section 2 lists variable mappings but omits how `SMGR_S3_ENDPOINT` and `AWS_ENDPOINT_URL_S3` are derived. The current script constructs these from the API URL. Specify whether there is an S3 URL key in the `-o env` output or whether it must be constructed as `$API_URL/storage/v1/s3`.

---

## 11. Encryption Key Format: Hex vs Base64

The plan generates `openssl rand -hex 32` (64-char hex). The existing `.env.example` says "Generate with: `openssl rand -base64 32`". Confirm what format `web/lib/crypto/encryption-versioned.ts` expects before specifying the generation command.

---

## Summary

| Priority | Issue | Section |
|---|---|---|
| High | Validate `eval` safety or use `-o json` + `jq` | Section 2 |
| High | Confirm encryption key format (hex vs base64) | Section 2 |
| High | Explicitly remove bucket curl and S3 fallback from `test-integration.sh` | Section 3 |
| High | Specify key preservation read-before-write ordering | Section 2 |
| Medium | Fix `deploy.sh` deprecated `ENCRYPTION_KEY` or backlog it | Missing |
| Medium | Definitively delete `seed_test_data.sh`, `tests/README.md` | Section 6 |
| Medium | Add storage bucket check to `verify.sh` | Section 7 |
| Medium | Specify `SMGR_S3_ENDPOINT` derivation | Section 2 |
| Medium | Update printed instructions in `local-dev.sh` | Section 2 |
| Low | Fix `source .env.local` in quickstart | Section 8 |
