#!/usr/bin/env bash
# Reusable shell functions for CI/CD and local admin tasks.
# Source this file, then call functions with the required env vars or arguments.
#
# Usage:
#   source scripts/lib.sh
#   install_shellcheck                      # install shellcheck (Linux)
#   install_jq                              # install jq (Linux)
#   require_supabase_version                # error if CLI too old
#   install_supabase_cli                    # install CLI binary (Linux)
#   start_ollama                            # idempotent start + pull moondream:1.8b (no-op if not installed)
#   start_supabase                          # idempotent start + apply pending migrations
#   print_setup_env_vars                    # emit .env.local from running Supabase
#   source_dotenv .env.local                # load and export vars from a .env file
#   verify_supabase_env                     # check required fields in supabase status
#   verify_gotrue <url> <key>               # probe GoTrue with service role key
#   smoke_test                              # uses $VERCEL_APP_URL
#   smoke_test "https://my-app.vercel.app"  # or pass explicitly
#   vercel_log_check "dpl_abc123"
#   wait_for_vercel_deployment --sha abc123 --target production

# NOTE: Do NOT set -euo pipefail here. This file is sourced by other scripts
# and setting shell options would affect the caller. Each calling script should
# set its own shell options.

# ---------------------------------------------------------------------------
# source_dotenv — load a .env file and export all variables
#
# Usage: source_dotenv .env.local
#        source_dotenv /path/to/.env
#
# Skips blank lines and comments (#). Handles KEY=VALUE with or without quotes.
# ---------------------------------------------------------------------------
source_dotenv() {
  local envfile="${1:-.env.local}"
  if [ ! -f "$envfile" ]; then
    echo "Error: $envfile not found" >&2
    return 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$envfile"
  set +a
}

# ---------------------------------------------------------------------------
# merge_lcov — thin wrapper around lcov for merging LCOV files
#
# Usage: merge_lcov <output> -a <input1> [-a <input2>] ...
#
# Passes all args after <output> directly to lcov. Callers are responsible
# for checking that input files exist before passing them.
#
# Example:
#   merge_lcov combined.info -a unit/lcov.info -a integration/lcov.info
# ---------------------------------------------------------------------------
merge_lcov() {
  local output="${1:?Usage: merge_lcov <output> -a <input1> [-a <input2>] ...}"
  shift
  lcov "$@" -o "$output"
}

# ---------------------------------------------------------------------------
# Supabase CLI version constants
# ---------------------------------------------------------------------------
# Minimum version with ES256 JWT fix (supabase/cli#4818)
SUPABASE_MIN_VERSION="2.76.4"
# Pinned version used in CI — single source of truth (ci.yml reads this)
SUPABASE_PINNED_VERSION="2.83.0"

# ---------------------------------------------------------------------------
# install_shellcheck — install shellcheck if not present (Linux only)
#   Downloads static binary from GitHub Releases.
#   No-op if shellcheck is already installed.
# ---------------------------------------------------------------------------
install_shellcheck() {
  if command -v shellcheck &>/dev/null; then
    return 0
  fi

  local arch
  arch=$(uname -m)
  local url="https://github.com/koalaman/shellcheck/releases/download/stable/shellcheck-stable.linux.${arch}.tar.xz"

  local tmp
  tmp=$(mktemp -d)
  curl -fsSL "$url" | tar -xJ -C "$tmp"
  if [ -w /usr/local/bin ]; then
    cp "$tmp/shellcheck-stable/shellcheck" /usr/local/bin/shellcheck
  else
    mkdir -p "$HOME/.local/bin"
    cp "$tmp/shellcheck-stable/shellcheck" "$HOME/.local/bin/shellcheck"
    export PATH="$HOME/.local/bin:$PATH"
  fi
  rm -rf "$tmp"
}

# ---------------------------------------------------------------------------
# install_jq — install jq if not present (Linux only)
#   Uses apt-get if available, otherwise downloads binary directly.
#   No-op if jq is already installed.
# ---------------------------------------------------------------------------
install_jq() {
  if command -v jq &>/dev/null; then
    return 0
  fi

  if command -v apt-get &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq jq
  else
    local arch
    arch=$(uname -m)
    case "$arch" in
      x86_64)  arch="amd64" ;;
      aarch64|arm64) arch="arm64" ;;
    esac
    local url="https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-${arch}"
    if [ -w /usr/local/bin ]; then
      curl -fsSL "$url" -o /usr/local/bin/jq && chmod +x /usr/local/bin/jq
    else
      mkdir -p "$HOME/.local/bin"
      curl -fsSL "$url" -o "$HOME/.local/bin/jq" && chmod +x "$HOME/.local/bin/jq"
      export PATH="$HOME/.local/bin:$PATH"
    fi
  fi
}

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
    echo "Reinstall: install_supabase_cli (or run session-start hook)" >&2
    return 1
  fi

  # Warn if local version is behind the pinned CI version
  local newest
  newest=$(printf '%s\n%s\n' "$SUPABASE_PINNED_VERSION" "$version" | sort -V | tail -n1)
  if [ "$newest" != "$version" ]; then
    echo "Warning: Supabase CLI $version is behind CI pinned version $SUPABASE_PINNED_VERSION." >&2
    echo "Consider upgrading to match CI: install_supabase_cli (or run session-start hook)" >&2
  fi
}

# ---------------------------------------------------------------------------
# start_docker — ensures Docker daemon is running
#   On Linux (CI/web sessions): starts dockerd via sudo -E (preserves proxy env).
#   On macOS: errors out — Docker Desktop must be started manually.
# ---------------------------------------------------------------------------
start_docker() {
  if docker info &>/dev/null 2>&1; then
    return 0
  fi
  if [[ "$(uname)" == "Linux" ]]; then
    echo "Starting Docker daemon..."
    sudo -E dockerd &>/tmp/dockerd.log &
    for i in $(seq 1 30); do
      if docker info &>/dev/null 2>&1; then
        echo "Docker daemon started"
        return 0
      fi
      sleep 1
    done
    echo "Error: Docker daemon did not start within 30 seconds." >&2
    return 1
  else
    echo "Error: Docker is not running. Start Docker Desktop or Colima and re-run." >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# start_ollama — idempotent start of Ollama and pull of required model
#   No-op if ollama is not installed. Starts the server if not already running,
#   then pulls moondream:1.8b (cached after first pull).
# ---------------------------------------------------------------------------
start_ollama() {
  if ! command -v ollama &>/dev/null; then
    echo "Ollama not installed, skipping. Install from https://ollama.com to run pipeline tests."
    return 0
  fi

  if ! curl -sf http://localhost:11434 >/dev/null 2>&1; then
    echo "Starting Ollama..."
    ollama serve &>/dev/null &
    # Wait for server to be ready
    local i=0
    while ! curl -sf http://localhost:11434 >/dev/null 2>&1; do
      sleep 1
      i=$((i + 1))
      if [ "$i" -ge 10 ]; then
        echo "Warning: Ollama did not start within 10 seconds." >&2
        return 1
      fi
    done
  fi

  echo "Pulling moondream:1.8b (~828MB, cached after first run)..."
  ollama pull moondream:1.8b
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

  local url="https://github.com/supabase/cli/releases/download/v${SUPABASE_PINNED_VERSION}/supabase_linux_${arch}.tar.gz"

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
#   Service exclusions (realtime, edge_runtime) are in config.toml.
# ---------------------------------------------------------------------------
start_supabase() {
  if ! docker info &>/dev/null 2>&1; then
    echo "Error: Docker is not running. Start Docker and re-run." >&2
    return 1
  fi
  if supabase status &>/dev/null 2>&1; then
    echo "Supabase already running, applying any pending migrations..."
    supabase migration up --local
  else
    supabase start
    supabase migration up --local
  fi
  "$(dirname "${BASH_SOURCE[0]}")/create-webhook-user.sh"
}

# ---------------------------------------------------------------------------
# print_setup_env_vars — prints env vars from a running Supabase instance
#   in dotenv format (KEY=value). Requires jq and a running Supabase.
#   Usage: cd web && npm run setup:env
# ---------------------------------------------------------------------------
print_setup_env_vars() {
  if ! command -v jq &>/dev/null; then
    echo "Error: jq is required but not installed." >&2
    return 1
  fi

  local status_json
  if ! status_json=$(supabase status -o json 2>/dev/null); then
    echo "Error: 'supabase status -o json' failed. Is Supabase running?" >&2
    return 1
  fi

  if [ -z "$status_json" ]; then
    echo "Error: 'supabase status -o json' returned no output." >&2
    return 1
  fi

  local api_url anon_key service_role s3_url s3_key_id s3_key_secret
  api_url=$(echo "$status_json" | jq -r '.API_URL')
  anon_key=$(echo "$status_json" | jq -r '.ANON_KEY')
  service_role=$(echo "$status_json" | jq -r '.SERVICE_ROLE_KEY')
  s3_url=$(echo "$status_json" | jq -r '.STORAGE_S3_URL')
  s3_key_id=$(echo "$status_json" | jq -r '.S3_PROTOCOL_ACCESS_KEY_ID')
  s3_key_secret=$(echo "$status_json" | jq -r '.S3_PROTOCOL_ACCESS_KEY_SECRET')

  local encryption_key
  encryption_key=$(openssl rand -base64 32)

  # Check if web app is running (non-blocking warning)
  local web_url="http://localhost:3000"
  if ! curl -sf --connect-timeout 2 "${web_url}/api/health" >/dev/null 2>&1; then
    echo "Warning: Next.js web app not running at ${web_url}. Start with: cd web && npm run dev" >&2
    echo "         CLI 'sitemgr login' requires the web app. Other commands work without it." >&2
  fi

  cat <<EOF
NEXT_PUBLIC_SUPABASE_URL=${api_url}
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${anon_key}
SITEMGR_API_URL=${api_url}
SITEMGR_API_KEY=${anon_key}
SITEMGR_WEB_URL=http://localhost:3000
SITEMGR_S3_ENDPOINT=${s3_url}
S3_ENDPOINT_URL=${s3_url}
SITEMGR_S3_BUCKET=media
SITEMGR_S3_REGION=local
S3_ACCESS_KEY_ID=${s3_key_id}
S3_SECRET_ACCESS_KEY=${s3_key_secret}
SITEMGR_DEVICE_ID=local-dev
SITEMGR_AUTO_ENRICH=false
ENCRYPTION_KEY_CURRENT=${encryption_key}
WEBHOOK_SERVICE_ACCOUNT_EMAIL=webhook@sitemgr.internal
WEBHOOK_SERVICE_ACCOUNT_PASSWORD=unused-password-webhook-uses-service-token
SUPABASE_SERVICE_ROLE_KEY=${service_role}
EOF
}

# ---------------------------------------------------------------------------
# verify_supabase_env — checks that all required fields are present in
#   supabase status JSON output. Run before print_setup_env_vars when you
#   want to fail early on missing fields.
# ---------------------------------------------------------------------------
verify_supabase_env() {
  if ! command -v jq &>/dev/null; then
    echo "Error: jq is required but not installed." >&2
    return 1
  fi

  local status_json
  if ! status_json=$(supabase status -o json 2>/dev/null); then
    echo "Error: 'supabase status -o json' failed. Is Supabase running?" >&2
    return 1
  fi

  local missing
  missing=$(echo "$status_json" | jq -r '
    [
      ["API_URL",                      .API_URL],
      ["ANON_KEY",                     .ANON_KEY],
      ["SERVICE_ROLE_KEY",             .SERVICE_ROLE_KEY],
      ["STORAGE_S3_URL",               .STORAGE_S3_URL],
      ["S3_PROTOCOL_ACCESS_KEY_ID",    .S3_PROTOCOL_ACCESS_KEY_ID],
      ["S3_PROTOCOL_ACCESS_KEY_SECRET",.S3_PROTOCOL_ACCESS_KEY_SECRET]
    ] | map(select(.[1] == null)) | .[][][0]
  ')
  if [ -n "$missing" ]; then
    echo "Error: Missing fields from 'supabase status -o json':" >&2
    while IFS= read -r field; do
      echo "  - $field" >&2
    done <<< "$missing"
    echo "Try: supabase stop && supabase start" >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# verify_gotrue — probes GoTrue to confirm the service role key works.
#   Useful during interactive dev setup; not needed in CI where tests
#   will surface auth failures directly.
# ---------------------------------------------------------------------------
verify_gotrue() {
  local api_url="${1:?Usage: verify_gotrue <api_url> <service_role_key>}"
  local service_role_key="${2:?Usage: verify_gotrue <api_url> <service_role_key>}"

  local probe_status
  probe_status=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${service_role_key}" \
    -H "apikey: ${service_role_key}" \
    "${api_url}/auth/v1/admin/users?per_page=1")
  if [ "$probe_status" = "000" ]; then
    echo "Error: Could not reach GoTrue at ${api_url}/auth/v1/." >&2
    echo "Make sure Supabase is fully started before generating env vars." >&2
    return 1
  fi
  if [ "$probe_status" -lt 200 ] || [ "$probe_status" -ge 300 ]; then
    echo "Error: Service role key rejected by GoTrue (HTTP ${probe_status})." >&2
    echo "Upgrade Supabase CLI to >= ${SUPABASE_MIN_VERSION}." >&2
    return 1
  fi
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
