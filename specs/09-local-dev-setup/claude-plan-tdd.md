# TDD Plan: Local Dev Setup Improvement

## Testing Context

This plan is primarily shell scripts and documentation — not TypeScript application code. Shell scripts don't have a natural unit test framework, so "tests" here are a mix of:

- **Manual verification steps** run after each script change (documented per section)
- **Integration-level checks** using the existing `verify.sh` (Section 7) as the acceptance test for the setup flow
- **One TypeScript test change** (`smgr-e2e.test.ts`) that follows the existing vitest integration pattern

---

## Section 1: Fix `scripts/local-dev.sh`

### Before implementing

**Manual verification script (run after changes):**

Write a short throw-away test sequence to validate the rewrite:

```bash
# Test: idempotent start — run twice, second should print status not error
./scripts/local-dev.sh  # first run
./scripts/local-dev.sh  # second run — should not error

# Test: print_setup_env_vars outputs valid dotenv format
./scripts/local-dev.sh print_setup_env_vars | grep -E '^[A-Z_]+=.+'

# Test: all required vars are present in output
./scripts/local-dev.sh print_setup_env_vars | grep NEXT_PUBLIC_SUPABASE_URL
./scripts/local-dev.sh print_setup_env_vars | grep ENCRYPTION_KEY_CURRENT
./scripts/local-dev.sh print_setup_env_vars | grep S3_ACCESS_KEY_ID

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

**Failure mode to verify is gone:**
- Run script with Supabase not running — should fail with clear error, not silent empty vars
- Verify `supabase status` is called without `/dev/null` redirect (shows status when already running)

---

## Section 2: Fix `scripts/test-integration.sh`

### Before implementing

```bash
# Test: fails clearly when .env.local missing
rm -f .env.local
./scripts/test-integration.sh 2>&1 | grep "env.local not found"

# Test: succeeds when .env.local exists and Supabase is running
./scripts/local-dev.sh print_setup_env_vars > .env.local
./scripts/test-integration.sh --skip-ollama
```

**Failure mode to verify is gone:**
- Confirm no `supabase status` calls remain in the script after the change
- Confirm no `S3_ACCESS_KEY_ID=$SUPABASE_SECRET_KEY` fallback remains

---

## Section 3: Fix `scripts/setup.sh`

### Before implementing

```bash
# Test: missing prereq produces actionable error
# (temporarily rename supabase to force the check)
PATH_WITHOUT_SUPABASE=$(echo $PATH | tr ':' '\n' | grep -v "supabase" | tr '\n' ':')
PATH=$PATH_WITHOUT_SUPABASE ./scripts/setup.sh 2>&1 | grep "supabase"

# Test: all missing tools reported at once (not one-at-a-time)
# (should list all missing tools before exiting)
```

---

## Section 4: Fix `.env.example` Files

### Before implementing

No automated tests — static files. Manual review checklist:

- `ENCRYPTION_KEY_CURRENT=` present, `ENCRYPTION_KEY=` absent
- `ENCRYPTION_KEY_PREVIOUS=` present and commented
- `web/.env.example` has all five sections with correct var names
- No var names that differ from what `local-dev.sh print_setup_env_vars` outputs

---

## Section 5: Delete Legacy Test Files

### Before implementing

```bash
# Test: no CI workflows reference the files being deleted
grep -r "integration_test.sh" .github/ && echo "FAIL: still referenced" || echo "PASS"
grep -r "seed_test_data.sh" .github/ && echo "FAIL: still referenced" || echo "PASS"

# Test: edge function test files not referenced by CI before deleting
grep -r "edge_function_bucket_test\|edge_function_scan_test" .github/
```

---

## Section 6: Fix `smgr-e2e.test.ts` Bucket Dependency

### Before implementing

This is a TypeScript test file — write test stubs using the existing vitest integration pattern before modifying:

```typescript
// Test: beforeAll creates 'media' bucket without error
// Test: beforeAll treats 'bucket already exists' error as non-fatal
// Test: afterAll removes only objects uploaded by this test run
// Test: afterAll does not delete the bucket itself
// Test: full E2E run passes when bucket is created fresh by beforeAll
//       (i.e., bucket does not need to pre-exist before the test)
```

Run after changes:
```bash
./scripts/test-integration.sh  # with Ollama, no --skip-ollama
```

---

## Section 7: Add `scripts/setup/verify.sh`

### Before implementing

This script is itself the acceptance test for the whole setup flow. Write the expected output format first, then implement to match:

```bash
# Expected output when all passing:
#   ✓ SMGR_API_URL is set
#   ✓ SMGR_API_KEY is set
#   ✓ SUPABASE_SECRET_KEY is set
#   ✓ ENCRYPTION_KEY_CURRENT is set
#   ✓ S3_ACCESS_KEY_ID is set
#   ✓ S3_SECRET_ACCESS_KEY is set
#   ✓ Supabase API reachable
#   All checks passed.

# Test: exits 0 when Supabase running and vars set
./scripts/local-dev.sh print_setup_env_vars > .env.local
./scripts/setup/verify.sh; echo "exit: $?"  # should be 0

# Test: exits 1 and names the missing var when a var is unset
env -i ./scripts/setup/verify.sh 2>&1 | grep "SMGR_API_URL"

# Test: exits 1 with clear message when Supabase not reachable
supabase stop
./scripts/setup/verify.sh 2>&1 | grep "Supabase API"
supabase start

# Test: works without manually sourcing .env.local first
# (script sources the file itself)
unset SMGR_API_URL
./scripts/setup/verify.sh  # should still pass if .env.local exists
```

---

## Section 8: Write `docs/setup/README.md`

No automated tests — documentation. Manual review:

- Follow the doc top-to-bottom on a fresh clone and verify every command works as written
- Confirm no references to `tests/integration_test.sh` or Python commands

---

## Section 9: Fix `scripts/deploy.sh`

```bash
# Test: no remaining references to deprecated ENCRYPTION_KEY
grep '\bENCRYPTION_KEY\b' scripts/deploy.sh scripts/lib.sh .github/workflows/*.yml \
  | grep -v 'ENCRYPTION_KEY_CURRENT\|ENCRYPTION_KEY_PREVIOUS\|ENCRYPTION_KEY_NEXT' \
  && echo "FAIL: deprecated name still present" || echo "PASS"
```

---

## Acceptance Test: Full Flow

After all sections are implemented, run this sequence from a fresh shell (no env vars set):

```bash
./scripts/setup.sh
./scripts/local-dev.sh
./scripts/local-dev.sh print_setup_env_vars > .env.local
./scripts/setup/verify.sh          # should print all ✓
./scripts/test-integration.sh --skip-ollama  # should pass
```

All steps should complete without manual intervention beyond the redirect on line 3.
