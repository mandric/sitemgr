# Section 05: Local Validation

## Context

Before pushing CI changes, validate the full integration-tests job sequence locally. This catches issues that would otherwise only surface in GitHub Actions (missing env vars, test failures, step ordering problems).

## Implementation

### Step 1: Validate CI YAML syntax

If `actionlint` is available:
```bash
actionlint .github/workflows/ci.yml
```

Otherwise, verify YAML is valid:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"
```

### Step 2: Verify step ordering in the modified workflow

Read the final ci.yml and confirm:
1. "Extract Supabase connection details" comes after "Start Supabase local environment"
2. "Verify integration test env vars" comes after "Extract Supabase connection details"
3. "Run DB integration tests" comes after "Install web dependencies"
4. "Run media integration tests" comes after "Run DB integration tests"
5. "FTS smoke test" comes after media integration tests
6. "Stop Supabase" is the last step with `if: always()`
7. `deploy` job `needs` array still includes `integration-tests`

### Step 3: Run the full sequence locally

```bash
# Start Supabase
supabase start

# Extract env vars (same as CI)
STATUS_JSON=$(supabase status -o json)
export SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)
export NEXT_PUBLIC_SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)
export SUPABASE_SECRET_KEY=$(echo "$STATUS_JSON" | jq -r .SERVICE_ROLE_KEY)
export SUPABASE_PUBLISHABLE_KEY=$(echo "$STATUS_JSON" | jq -r .ANON_KEY)
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$(echo "$STATUS_JSON" | jq -r .ANON_KEY)

# Verify env vars
for var in SUPABASE_URL SUPABASE_SECRET_KEY SUPABASE_PUBLISHABLE_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; do
  if [ -z "${!var}" ]; then echo "FAIL: $var not set"; exit 1; fi
done
echo "Env vars OK"

# Create storage bucket
curl -sf -X POST "$SUPABASE_URL/storage/v1/bucket" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"media","name":"media","public":false}' || echo "Bucket exists"

# Install deps
cd web && npm ci

# Run DB integration tests
npm run test:integration
echo "DB integration tests: PASSED"

# Run media integration tests
npm run test:media-integration
echo "Media integration tests: PASSED"

# Stop Supabase
cd .. && supabase stop
```

### Step 4: Verify test output

Check that:
- DB integration tests show non-zero pass count (not all skipped)
- Media integration tests show non-zero pass count
- No test failures
- `migration-integrity.test.ts` shows as "todo/pending" (expected — all stubs)

## Acceptance Criteria

- [ ] CI YAML is syntactically valid
- [ ] Step ordering is correct
- [ ] Both test suites pass locally with the env var extraction approach
- [ ] DB tests actually run (not silently skip)
- [ ] Media tests actually run (not cryptic auth failures)
- [ ] Deploy job dependencies unchanged
