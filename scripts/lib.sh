#!/usr/bin/env bash
# Reusable shell functions for CI/CD and local admin tasks.
# Source this file, then call functions with the required env vars or arguments.
#
# Usage:
#   source scripts/lib.sh
#   require_supabase_version                # error if CLI too old
#   install_supabase_cli                    # install CLI binary (Linux)
#   start_supabase                          # idempotent start
#   smoke_test                              # uses $VERCEL_APP_URL
#   smoke_test "https://my-app.vercel.app"  # or pass explicitly
#   vercel_log_check "dpl_abc123"
#   wait_for_vercel_deployment --sha abc123 --target production

# NOTE: Do NOT set -euo pipefail here. This file is sourced by other scripts
# and setting shell options would affect the caller. Each calling script should
# set its own shell options.

# ---------------------------------------------------------------------------
# Supabase CLI version constants
# ---------------------------------------------------------------------------
# Minimum version with ES256 JWT fix (supabase/cli#4818)
SUPABASE_MIN_VERSION="2.76.4"
# Version to install in headless environments (web sessions, CI)
SUPABASE_INSTALL_VERSION="2.83.0"

# ---------------------------------------------------------------------------
# require_supabase_version — exits with an error if supabase CLI is too old
# ---------------------------------------------------------------------------
require_supabase_version() {
  local version
  version=$(supabase --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
  if [ -z "$version" ]; then
    echo "Warning: Could not determine Supabase CLI version." >&2
    return
  fi
  local oldest
  oldest=$(printf '%s\n%s\n' "$SUPABASE_MIN_VERSION" "$version" | sort -V | head -n1)
  if [ "$oldest" != "$SUPABASE_MIN_VERSION" ]; then
    echo "Error: Supabase CLI $version is too old. Minimum required: $SUPABASE_MIN_VERSION" >&2
    echo "Older versions have a broken ES256 JWT signing bug (supabase/cli#4818)." >&2
    echo "Upgrade: brew upgrade supabase" >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# install_supabase_cli — download and install Supabase CLI binary (Linux only)
#   Installs to /usr/local/bin if writable, else $HOME/.local/bin.
#   No-op if supabase is already installed.
#   If $CLAUDE_ENV_FILE is set and we fall back to ~/.local/bin, persists
#   the PATH addition for the Claude Code session.
# ---------------------------------------------------------------------------
install_supabase_cli() {
  if command -v supabase &>/dev/null; then
    return 0
  fi

  local arch
  arch=$(uname -m)
  case "$arch" in
    x86_64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
  esac

  local url="https://github.com/supabase/cli/releases/download/v${SUPABASE_INSTALL_VERSION}/supabase_linux_${arch}.tar.gz"

  if [ -w /usr/local/bin ]; then
    curl -fsSL "$url" | tar -xz -C /usr/local/bin supabase
  else
    mkdir -p "$HOME/.local/bin"
    curl -fsSL "$url" | tar -xz -C "$HOME/.local/bin" supabase
    export PATH="$HOME/.local/bin:$PATH"
    # Persist PATH for Claude Code web sessions
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
      echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
    fi
  fi
}

# ---------------------------------------------------------------------------
# start_supabase — idempotent start of local Supabase
#   Always excludes edge-runtime and realtime (not used in v1).
# ---------------------------------------------------------------------------
start_supabase() {
  if supabase status &>/dev/null 2>&1; then
    return 0
  fi
  supabase start --exclude edge-runtime,realtime
}

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

  local max_attempts=3
  local health_passed=0

  for attempt in $(seq 1 "$max_attempts"); do
    echo "Health check attempt $attempt/$max_attempts..."

    local curl_exit=0
    local http_code
    http_code=$(curl -sS -o /tmp/health.json -w '%{http_code}' "$health_url") || curl_exit=$?

    if [ "$curl_exit" -ne 0 ]; then
      echo "  Connection error (curl exit code: $curl_exit)"
      if [ "$attempt" -lt "$max_attempts" ]; then
        echo "  Retrying in 5s..."
        sleep 5
      fi
      continue
    fi

    echo "  HTTP status: $http_code"

    local status
    status=$(jq -r '.status // empty' /tmp/health.json 2>/dev/null || echo "")

    if [ "$status" = "ok" ]; then
      echo "Health check passed"
      echo ""
      health_passed=1
      break
    fi

    if [ "$status" = "degraded" ]; then
      echo ""
      echo "========================================="
      echo "  HEALTH CHECK FAILED — CONFIGURATION ERROR"
      echo "========================================="
      echo "  Status \"degraded\" indicates missing env vars or"
      echo "  misconfiguration. This will not resolve on retry."
      echo ""
      echo "  Response:"
      jq . /tmp/health.json 2>/dev/null || cat /tmp/health.json
      echo ""
      echo "  Check details:"
      jq -r '.checks | to_entries[] | "  \(.key): \(.value)"' /tmp/health.json 2>/dev/null
      return 1
    fi

    # Non-ok, non-degraded response — transient error
    echo "  Response:"
    jq . /tmp/health.json 2>/dev/null || cat /tmp/health.json
    if [ "$attempt" -lt "$max_attempts" ]; then
      echo "  Retrying in 5s..."
      sleep 5
    fi
  done

  if [ "$health_passed" -ne 1 ]; then
    echo ""
    echo "========================================="
    echo "  HEALTH CHECK FAILED after $max_attempts attempts"
    echo "========================================="
    echo ""
    echo "Last response:"
    jq . /tmp/health.json 2>/dev/null || cat /tmp/health.json
    return 1
  fi

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
