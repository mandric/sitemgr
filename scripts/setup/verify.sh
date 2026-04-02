#!/usr/bin/env bash
set -euo pipefail

# Source .env.local if it exists (so script works without manual sourcing)
if [ -f ".env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

failures=0

check_var() {
  local var_name="$1"
  local var_value="${!var_name:-}"
  if [ -n "$var_value" ]; then
    echo "  ✓ ${var_name} is set"
  else
    echo "  ✗ ${var_name} is set: variable is empty or unset"
    failures=$((failures + 1))
  fi
}

check_api_reachable() {
  local url="${SITEMGR_API_URL:-}"
  local key="${SITEMGR_API_KEY:-}"
  if [ -z "$url" ]; then
    echo "  ✗ Supabase API reachable: SITEMGR_API_URL not set"
    failures=$((failures + 1))
    return
  fi
  if curl -sf "${url}/rest/v1/" -H "apikey: ${key}" > /dev/null 2>&1; then
    echo "  ✓ Supabase API reachable"
  else
    echo "  ✗ Supabase API reachable: curl returned non-200"
    failures=$((failures + 1))
  fi
}

check_var "SITEMGR_API_URL"
check_var "SITEMGR_API_KEY"
check_var "SUPABASE_SERVICE_ROLE_KEY"
check_var "ENCRYPTION_KEY_CURRENT"
check_var "S3_ACCESS_KEY_ID"
check_var "S3_SECRET_ACCESS_KEY"
check_api_reachable

if [ "$failures" -eq 0 ]; then
  echo "  All checks passed."
  exit 0
else
  echo "  ${failures} check(s) failed."
  exit 1
fi
