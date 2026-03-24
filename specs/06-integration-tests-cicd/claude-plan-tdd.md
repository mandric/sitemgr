# TDD Plan: Add Integration Tests to CI/CD Pipeline

This document mirrors the structure of `claude-plan.md` and defines what to test BEFORE implementing each section.

## Testing Context

**Framework:** This task modifies a GitHub Actions workflow (YAML), not application code. Traditional unit tests don't apply to CI workflow changes. Instead, validation is done via:

1. **Local dry-run verification** — run the same commands locally that CI will run
2. **CI workflow validation** — use `actionlint` or similar to validate YAML syntax
3. **Assertion scripts** — small bash scripts that verify expected behavior

**Existing test infrastructure:** vitest (unit/integration), Playwright (E2E), Supabase CLI (local services)

---

## Section 1: Consolidate and Fix Environment Variable Export

### Tests to write BEFORE implementing:

```bash
# Test: supabase status JSON can be captured once and all values extracted
# Verify: STATUS_JSON=$(supabase status -o json) succeeds
# Verify: jq -r .API_URL extracts a non-empty URL from the captured JSON
# Verify: jq -r .SERVICE_ROLE_KEY extracts a non-empty key
# Verify: jq -r .ANON_KEY extracts a non-empty key
# Verify: jq -r .S3_ENDPOINT_URL extracts a non-empty URL
```

```bash
# Test: NEXT_PUBLIC_ prefixed vars match their unprefixed counterparts
# Verify: NEXT_PUBLIC_SUPABASE_URL == SUPABASE_URL
# Verify: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY == SUPABASE_PUBLISHABLE_KEY
```

**Run locally:** Start Supabase, run the extraction commands, assert all vars are non-empty and prefixed/unprefixed pairs match.

---

## Section 2: Env Var Verification Step

### Tests to write BEFORE implementing:

```bash
# Test: verification step passes when all vars are set
# Verify: script exits 0 when SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY,
#         NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are all non-empty

# Test: verification step fails when any var is missing
# Verify: script exits 1 when SUPABASE_URL is unset
# Verify: script exits 1 when SUPABASE_SECRET_KEY is unset
# Verify: script exits 1 when NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is unset
# Verify: error message includes the name of the missing var
```

**Implementation:** Write a small test script that sources the verification logic with controlled env vars and checks exit codes.

---

## Section 3: Add DB Integration Test Step

### Tests to write BEFORE implementing:

```bash
# Test: DB integration tests run and produce assertions (not silently skip)
# Verify: `cd web && npm run test:integration` exits 0 with local Supabase running
# Verify: vitest output contains "Tests" with a non-zero pass count
# Verify: vitest output does NOT show all tests as "skipped"

# Test: DB integration tests fail clearly when Supabase is not running
# Verify: `npm run test:integration` exits non-zero without Supabase (or with empty env vars)
```

```bash
# Test: rls-policies.test.ts canRun guard activates with correct env vars
# Verify: with NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
#         and SUPABASE_SECRET_KEY set, the test does NOT skip
```

**Run locally:** `supabase start`, set env vars, run `npm run test:integration`, verify output.

---

## Section 4: Add Media Integration Test Step

### Tests to write BEFORE implementing:

```bash
# Test: media integration tests run successfully with local Supabase
# Verify: `cd web && npm run test:media-integration` exits 0 with Supabase running + bucket created
# Verify: vitest output contains "Tests" with a non-zero pass count

# Test: media integration tests fail with clear error when SUPABASE_SECRET_KEY is missing
# Verify: exits non-zero with error about SUPABASE_SECRET_KEY (from setup.ts throw)

# Test: media tests and DB tests don't interfere with each other
# Verify: running both suites sequentially (`npm run test:integration && npm run test:media-integration`)
#         produces the same results as running each independently
```

**Run locally:** `supabase start`, create `media` bucket, run both suites sequentially.

---

## End-to-End CI Workflow Validation

### Tests to write BEFORE merging:

```bash
# Test: CI workflow YAML is valid
# Verify: actionlint .github/workflows/ci.yml passes (if available)
# Verify: yaml syntax is valid

# Test: integration-tests job step ordering is correct
# Verify: "Verify integration test env vars" comes after "Extract Supabase connection details"
# Verify: "Run DB integration tests" comes after "Install web dependencies"
# Verify: "Run media integration tests" comes after "Run DB integration tests"
# Verify: "Stop Supabase" is still the last step with `if: always()`

# Test: deploy job still depends on integration-tests
# Verify: deploy.needs includes "integration-tests"
```

**Validation approach:** These can be verified by reading the YAML and checking step order. A PR dry-run (GitHub Actions on the PR itself) will provide the definitive test.
