# Code Review: section-01-local-dev-sh

## Critical Issues

### 1. Operator precedence + `set -e` kills script on success path in validation block (confidence: 100)

Lines like:
```bash
[ -z "$api_url" ] || [ "$api_url" = "null" ] && missing+=("API_URL")
```

Under `set -euo pipefail`, when `api_url` is non-empty and not "null" (the normal success path), the entire compound expression evaluates to false (exit 1). `set -e` then terminates the script immediately. The validation block never runs successfully — it's fatal on the success path.

**Fix:** Wrap each check in `if`:
```bash
if [ -z "$api_url" ] || [ "$api_url" = "null" ]; then missing+=("API_URL"); fi
```

### 2. Partial dotenv output emitted before validation catches missing fields (confidence: 95)

Validation happens after the `cat <<EOF` heredoc. If a field is missing/null, partial content (e.g., `S3_ACCESS_KEY_ID=null`) is already written to stdout before the script exits 1. When redirected to `.env.local`, this leaves a corrupted file silently.

**Fix:** Move validation before the `cat <<EOF` block.

### 3. `|| true` swallows `supabase status` failures; no `jq` presence check (confidence: 95)

`supabase status -o json 2>/dev/null || true` silently swallows errors. If `jq` is missing, the error is an opaque `command not found` rather than a clear prerequisite message. The plan goal of "clear error when Supabase not running" is not met.

**Fix:** Remove `|| true`, let the exit propagate. Add `jq` presence check before first use.

## Summary

| # | Issue | Severity |
|---|-------|----------|
| 1 | `set -e` kills script on validation success path | Critical |
| 2 | Partial output before validation | Critical |
| 3 | Silent failure / missing jq check | Important |
