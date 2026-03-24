# Code Review: Sections 01-04

## Issues Found

### 1. jq -r returns 'null' string for missing keys (Medium)
If supabase status JSON omits a key, `jq -r` returns literal "null", not empty. The verification step's `-z` check won't catch this.

### 2. No set -euo pipefail (Low)
If `supabase status -o json` fails, STATUS_JSON is empty but the step continues, writing 'null' to GITHUB_ENV.

### 3. Verification doesn't check S3_ENDPOINT_URL or S3 creds (Low)
Downstream steps depend on S3_ENDPOINT_URL but it's not verified.

### 4. S3 key extraction is fragile (Low / Pre-existing)
Text parsing of `supabase status` output could break if CLI formatting changes.

### 5. Bucket creation error suppression (Low / Pre-existing)
`|| echo "Bucket may already exist"` swallows all curl errors.

## Deviations from Plan
None.
