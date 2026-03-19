# Section 02: Add Environment Variable Verification Step

## Context

The integration tests have two different failure modes when env vars are missing:
- **DB tests** (`rls-policies.test.ts`, `rpc-user-isolation.test.ts`): silently skip via `describe.skipIf(!canRun)` — CI reports green with 0 assertions
- **Media tests**: throw on missing `SUPABASE_SECRET_KEY`, but create a broken client with empty `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` leading to cryptic auth errors

A pre-flight verification step catches both issues early with a clear error message.

## Implementation

### Add a new step to the `integration-tests` job

**File:** `.github/workflows/ci.yml`
**Position:** After "Extract Supabase connection details", before "Configure environment for smgr"

```yaml
- name: Verify integration test env vars
  run: |
    missing=0
    for var in SUPABASE_URL SUPABASE_SECRET_KEY SUPABASE_PUBLISHABLE_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; do
      if [ -z "${!var}" ]; then
        echo "ERROR: $var is not set"
        missing=1
      fi
    done
    if [ "$missing" -eq 1 ]; then
      echo "::error::Required Supabase env vars are missing. DB tests would silently skip; media tests would get cryptic auth failures."
      exit 1
    fi
    echo "All required env vars verified"
```

### Design decisions:
- Uses `${!var}` (bash indirect expansion) to check vars by name in a loop
- Uses GitHub Actions `::error::` annotation for visibility in the Actions UI
- Checks all 5 required vars (both prefixed and unprefixed)
- Runs before any test steps to fail fast

## Tests

```bash
# Test locally:
# 1. With all vars set: script exits 0, prints "All required env vars verified"
# 2. With SUPABASE_URL unset: script exits 1, prints error naming SUPABASE_URL
# 3. With NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY unset: script exits 1
```

## Acceptance Criteria

- [ ] New step exists after env extraction, before test steps
- [ ] Checks all 5 required env vars
- [ ] Exits 1 with clear error message if any var is missing
- [ ] Uses `::error::` annotation for GitHub Actions UI visibility
- [ ] Exits 0 when all vars are set
