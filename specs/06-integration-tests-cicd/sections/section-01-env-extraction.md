# Section 01: Consolidate and Fix Environment Variable Extraction

## Context

The `integration-tests` job in `.github/workflows/ci.yml` has a step called "Extract Supabase connection details" (lines 83-93) that calls `supabase status -o json` multiple times. Each call spins up a Docker API query, which is wasteful and fragile in CI.

Additionally, the step only exports `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, but the integration test code reads `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Without the `NEXT_PUBLIC_` prefixed versions, DB integration tests silently skip (via `describe.skipIf(!canRun)`) and media tests get cryptic auth failures.

## Implementation

### Rewrite the "Extract Supabase connection details" step

**File:** `.github/workflows/ci.yml`
**Location:** The step at approximately lines 83-93

Replace the current implementation:
```yaml
- name: Extract Supabase connection details
  run: |
    echo "SUPABASE_URL=$(supabase status -o json | jq -r .API_URL)" >> $GITHUB_ENV
    echo "SUPABASE_SECRET_KEY=$(supabase status -o json | jq -r .SERVICE_ROLE_KEY)" >> $GITHUB_ENV
    echo "SUPABASE_PUBLISHABLE_KEY=$(supabase status -o json | jq -r .ANON_KEY)" >> $GITHUB_ENV
    echo "STORAGE_S3_URL=$(supabase status -o json | jq -r .STORAGE_S3_URL)" >> $GITHUB_ENV

    AWS_ACCESS_KEY=$(supabase status | grep "Access Key" | awk -F '│' '{print $3}' | tr -d ' ')
    AWS_SECRET_KEY=$(supabase status | grep "Secret Key" | awk -F '│' '{print $3}' | tr -d ' ')
    echo "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY" >> $GITHUB_ENV
    echo "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_KEY" >> $GITHUB_ENV
```

With this consolidated version:
```yaml
- name: Extract Supabase connection details
  run: |
    STATUS_JSON=$(supabase status -o json)
    echo "SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)" >> $GITHUB_ENV
    echo "NEXT_PUBLIC_SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)" >> $GITHUB_ENV
    echo "SUPABASE_SECRET_KEY=$(echo "$STATUS_JSON" | jq -r .SERVICE_ROLE_KEY)" >> $GITHUB_ENV
    echo "SUPABASE_PUBLISHABLE_KEY=$(echo "$STATUS_JSON" | jq -r .ANON_KEY)" >> $GITHUB_ENV
    echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$(echo "$STATUS_JSON" | jq -r .ANON_KEY)" >> $GITHUB_ENV
    echo "STORAGE_S3_URL=$(echo "$STATUS_JSON" | jq -r .STORAGE_S3_URL)" >> $GITHUB_ENV

    AWS_ACCESS_KEY=$(supabase status | grep "Access Key" | awk -F '│' '{print $3}' | tr -d ' ')
    AWS_SECRET_KEY=$(supabase status | grep "Secret Key" | awk -F '│' '{print $3}' | tr -d ' ')
    echo "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY" >> $GITHUB_ENV
    echo "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_KEY" >> $GITHUB_ENV
```

### Key changes:
1. Capture `supabase status -o json` output once into `STATUS_JSON`
2. Extract all JSON values from the captured variable (1 subprocess instead of 4)
3. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` exports
4. Keep unprefixed vars for other CI steps (FTS smoke test, bucket creation)
5. S3 key extraction still uses text-format `supabase status` (S3 keys aren't in JSON output)

## Tests

```bash
# Before implementing, verify locally:
# 1. supabase start
# 2. Run the extraction commands
# 3. Assert all vars are non-empty
# 4. Assert NEXT_PUBLIC_SUPABASE_URL == SUPABASE_URL
# 5. Assert NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY == SUPABASE_PUBLISHABLE_KEY
```

## Acceptance Criteria

- [ ] Single `supabase status -o json` call (not 4+)
- [ ] `NEXT_PUBLIC_SUPABASE_URL` exported to `$GITHUB_ENV`
- [ ] `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` exported to `$GITHUB_ENV`
- [ ] All existing exports preserved (SUPABASE_URL, SUPABASE_SECRET_KEY, etc.)
- [ ] S3 key extraction still works
