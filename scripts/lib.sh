#!/usr/bin/env bash
# Reusable shell functions for CI/CD and local admin tasks.
# Source this file, then call functions with the required env vars or arguments.
#
# Usage:
#   source scripts/lib.sh
#   smoke_test                              # uses $VERCEL_APP_URL
#   smoke_test "https://my-app.vercel.app"  # or pass explicitly
#   vercel_log_check "dpl_abc123"
#   wait_for_vercel_deployment --sha abc123 --target production

# NOTE: Do NOT set -euo pipefail here. This file is sourced by other scripts
# and setting shell options would affect the caller. Each calling script should
# set its own shell options.

# ---------------------------------------------------------------------------
# smoke_test [deploy_url]
#   Run health check (GET /api/health) and POST smoke test (/api/whatsapp)
#   Falls back to $VERCEL_APP_URL if no argument is provided.
# ---------------------------------------------------------------------------
smoke_test() {
  local deploy_url="${1:-${VERCEL_APP_URL:-}}"
  if [ -z "$deploy_url" ]; then
    echo "Usage: smoke_test <deploy_url> (or set VERCEL_APP_URL)" >&2
    return 1
  fi
  local health_url="${deploy_url}/api/health"
  local webhook_url="${deploy_url}/api/whatsapp"

  echo "=== Health check: GET $health_url ==="

  local http_code
  http_code=$(curl -sS -o /tmp/health.json -w '%{http_code}' "$health_url")
  echo "HTTP status: $http_code"
  echo "Response:"
  jq . /tmp/health.json

  local status
  status=$(jq -r '.status // empty' /tmp/health.json)
  if [ "$status" != "ok" ]; then
    echo ""
    echo "========================================="
    echo "  HEALTH CHECK FAILED (status: $status)"
    echo "========================================="
    echo ""
    echo "Check details:"
    jq -r '.checks | to_entries[] | "  \(.key): \(.value)"' /tmp/health.json
    return 1
  fi

  echo "Health check passed"
  echo ""

  echo "=== POST smoke test: $webhook_url ==="

  http_code=$(curl -sS -o /tmp/post-response.txt -w '%{http_code}' \
    -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "From=whatsapp%3A%2B15005550006&Body=ping" \
    "$webhook_url")
  echo "POST HTTP status: $http_code"
  cat /tmp/post-response.txt
  echo ""

  if [ "$http_code" != "200" ]; then
    echo "ERROR: POST expected HTTP 200, got $http_code"
    return 1
  fi

  echo "POST smoke test passed"
}

# ---------------------------------------------------------------------------
# vercel_log_check <deploy_id>
#   Query Vercel runtime logs and fail if any error-level entries exist.
#   Prints all logs to console for visibility.
#
#   Required env vars: VERCEL_TOKEN
#   Optional env vars: VERCEL_TEAM_ID
# ---------------------------------------------------------------------------
vercel_log_check() {
  local deploy_id="${1:?Usage: vercel_log_check <deploy_id>}"

  : "${VERCEL_TOKEN:?VERCEL_TOKEN must be set}"

  echo "=== Vercel runtime logs for deployment $deploy_id ==="

  local team_param=""
  if [ -n "${VERCEL_TEAM_ID:-}" ]; then
    team_param="&teamId=$VERCEL_TEAM_ID"
  fi

  local since
  since=$(date -d '5 minutes ago' +%s%3N 2>/dev/null || date -v-5M +%s000)

  local logs
  logs=$(curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v2/deployments/${deploy_id}/events?direction=backward&limit=100${team_param}&since=$since" \
    2>/dev/null || echo "[]")

  if ! echo "$logs" | jq empty 2>/dev/null; then
    echo "Warning: Could not parse Vercel logs response"
    echo "$logs"
    return 0
  fi

  local log_count
  log_count=$(echo "$logs" | jq 'length')
  echo "Retrieved $log_count log entries"
  echo ""

  # Print all log entries to console
  echo "$logs" | jq -r '.[] | "\(.created // .timestamp // "?") [\(.level // .type // "info")] \(.text // .message // "")"' 2>/dev/null || echo "$logs"
  echo ""

  # Filter for error-level entries
  local error_count
  error_count=$(echo "$logs" | jq -r '[.[] | select(.level == "error" or .type == "error")] | length' 2>/dev/null || echo "0")

  if [ "$error_count" -gt 0 ]; then
    echo "========================================="
    echo "  ERRORS FOUND: $error_count error-level log entries"
    echo "========================================="
    echo ""
    echo "$logs" | jq -r '.[] | select(.level == "error" or .type == "error") | "\(.created // .timestamp // "?") \(.text // .message // "")"' 2>/dev/null
    echo ""
    echo "Review the errors above and check Vercel env vars."
    return 1
  else
    echo "No error-level log entries found"
  fi
}

# ---------------------------------------------------------------------------
# wait_for_vercel_deployment [options]
#   Poll Vercel API until deployment is ready. Prints DEPLOY_URL and DEPLOY_ID.
#
#   Options:
#     --sha <commit_sha>       Git commit SHA to match (required)
#     --target <target>        Deployment target (e.g. "production"), optional
#     --max-attempts <n>       Max poll attempts (default: 60)
#     --delay <seconds>        Seconds between polls (default: 10)
#
#   Required env vars: VERCEL_TOKEN, VERCEL_PROJECT_ID
#   Optional env vars: VERCEL_TEAM_ID
#
#   Sets (exported):
#     DEPLOY_URL=https://...
#     DEPLOY_ID=dpl_...
# ---------------------------------------------------------------------------
wait_for_vercel_deployment() {
  : "${VERCEL_TOKEN:?VERCEL_TOKEN must be set}"
  : "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID must be set}"

  local sha="" target="" max_attempts=60 delay=10

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --sha) sha="$2"; shift 2 ;;
      --target) target="$2"; shift 2 ;;
      --max-attempts) max_attempts="$2"; shift 2 ;;
      --delay) delay="$2"; shift 2 ;;
      *) echo "Unknown option: $1" >&2; return 1 ;;
    esac
  done

  if [ -z "$sha" ]; then
    echo "ERROR: --sha is required" >&2
    return 1
  fi

  local team_param=""
  if [ -n "${VERCEL_TEAM_ID:-}" ]; then
    team_param="&teamId=$VERCEL_TEAM_ID"
  fi

  local target_param=""
  if [ -n "$target" ]; then
    target_param="&target=$target"
  fi

  local api_url="https://api.vercel.com/v6/deployments"

  echo "Waiting for Vercel deployment (sha=$sha, target=${target:-any})..." >&2

  for i in $(seq 1 "$max_attempts"); do
    local resp
    resp=$(curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
      "${api_url}?projectId=$VERCEL_PROJECT_ID&sha=${sha}${target_param}${team_param}&limit=1")

    local state url deploy_id
    state=$(echo "$resp" | jq -r '.deployments[0].state // "NOT_FOUND"')
    url=$(echo "$resp" | jq -r '.deployments[0].url // empty')
    deploy_id=$(echo "$resp" | jq -r '.deployments[0].uid // empty')

    echo "Attempt $i/$max_attempts: state=$state" >&2

    if [ "$state" = "READY" ]; then
      echo "Deployment is READY: https://$url" >&2
      export DEPLOY_URL="https://$url"
      export DEPLOY_ID="$deploy_id"
      return 0
    elif [ "$state" = "ERROR" ] || [ "$state" = "CANCELED" ]; then
      echo "ERROR: Deployment failed with state: $state" >&2
      echo "$resp" | jq . >&2
      return 1
    fi

    sleep "$delay"
  done

  echo "ERROR: Deployment did not become ready after $((max_attempts * delay))s" >&2
  return 1
}
