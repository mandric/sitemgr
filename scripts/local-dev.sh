#!/bin/bash
# Local development environment setup using Supabase CLI
# This script starts a full local Supabase environment (Postgres + Storage + Edge Functions)

set -euo pipefail
IFS=$'\n\t'

# Source shared shell library (Supabase version constants, install/start helpers)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

# ---------------------------------------------------------------------------
# print_setup_env_vars — prints all required local env vars to stdout in
# dotenv format (KEY=value). Redirect to .env.local to save them:
#   ./scripts/local-dev.sh print_setup_env_vars > .env.local
# ---------------------------------------------------------------------------
print_setup_env_vars() {
  if ! command -v jq &>/dev/null; then
    echo "Error: jq is required. Install it with: brew install jq" >&2
    exit 1
  fi

  local status_json
  if ! status_json=$(supabase status -o json 2>/dev/null); then
    echo "Error: 'supabase status -o json' failed." >&2
    echo "Make sure Supabase is running: ./scripts/local-dev.sh" >&2
    exit 1
  fi

  if [ -z "$status_json" ]; then
    echo "Error: 'supabase status -o json' returned no output." >&2
    echo "Make sure Supabase is running: ./scripts/local-dev.sh" >&2
    exit 1
  fi

  local api_url anon_key service_role_key db_url s3_key_id s3_key_secret
  api_url=$(echo "$status_json" | jq -r '.API_URL')
  anon_key=$(echo "$status_json" | jq -r '.ANON_KEY')
  service_role_key=$(echo "$status_json" | jq -r '.SERVICE_ROLE_KEY')
  db_url=$(echo "$status_json" | jq -r '.DB_URL')
  s3_key_id=$(echo "$status_json" | jq -r '.S3_PROTOCOL_ACCESS_KEY_ID')
  s3_key_secret=$(echo "$status_json" | jq -r '.S3_PROTOCOL_ACCESS_KEY_SECRET')

  # Validate required fields before emitting any output
  local missing=()
  if [ -z "$api_url" ] || [ "$api_url" = "null" ]; then missing+=("API_URL"); fi
  if [ -z "$anon_key" ] || [ "$anon_key" = "null" ]; then missing+=("ANON_KEY"); fi
  if [ -z "$service_role_key" ] || [ "$service_role_key" = "null" ]; then missing+=("SERVICE_ROLE_KEY"); fi
  if [ -z "$s3_key_id" ] || [ "$s3_key_id" = "null" ]; then missing+=("S3_PROTOCOL_ACCESS_KEY_ID"); fi
  if [ -z "$s3_key_secret" ] || [ "$s3_key_secret" = "null" ]; then missing+=("S3_PROTOCOL_ACCESS_KEY_SECRET"); fi

  if [ ${#missing[@]} -gt 0 ]; then
    echo "Error: The following fields were missing from 'supabase status -o json':" >&2
    for f in "${missing[@]}"; do
      echo "  - $f" >&2
    done
    echo "Try restarting Supabase: supabase stop && supabase start" >&2
    exit 1
  fi

  local s3_endpoint="${api_url}/storage/v1/s3"
  local encryption_key
  encryption_key=$(openssl rand -base64 32)

  # ---------------------------------------------------------------------------
  # Capability probe: verify the service role key is accepted by GoTrue.
  # Older Supabase CLI versions may produce keys that GoTrue rejects.
  # ---------------------------------------------------------------------------
  local probe_status
  probe_status=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${service_role_key}" \
    -H "apikey: ${service_role_key}" \
    "${api_url}/auth/v1/admin/users?per_page=1")
  if [ "$probe_status" = "000" ]; then
    echo "Error: Could not reach GoTrue at ${api_url}/auth/v1/." >&2
    echo "Make sure Supabase is fully started before generating env vars." >&2
    exit 1
  fi
  if [ "$probe_status" -lt 200 ] || [ "$probe_status" -ge 300 ]; then
    echo "Error: Service role key rejected by GoTrue (HTTP ${probe_status})." >&2
    echo "Upgrade Supabase CLI to >= 2.76.4." >&2
    exit 1
  fi

  cat <<EOF
# --- Web app (Supabase) ---
NEXT_PUBLIC_SUPABASE_URL=${api_url}
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${anon_key}
DATABASE_URL=${db_url}

# --- CLI (auth provider -- same Supabase instance in local dev) ---
SMGR_API_URL=${api_url}
SMGR_API_KEY=${anon_key}

# --- S3 / Storage ---
SMGR_S3_ENDPOINT=${s3_endpoint}
AWS_ENDPOINT_URL_S3=${s3_endpoint}
SMGR_S3_BUCKET=media
SMGR_S3_REGION=local
AWS_ACCESS_KEY_ID=${s3_key_id}
AWS_SECRET_ACCESS_KEY=${s3_key_secret}

# --- smgr CLI ---
SMGR_DEVICE_ID=local-dev
SMGR_AUTO_ENRICH=false

# --- Encryption (generated fresh -- local dev data is ephemeral) ---
ENCRYPTION_KEY_CURRENT=${encryption_key}

# --- Webhook service account (for WhatsApp webhook) ---
WEBHOOK_SERVICE_ACCOUNT_EMAIL=webhook@sitemgr.internal
WEBHOOK_SERVICE_ACCOUNT_PASSWORD=unused-password-webhook-uses-service-token

# --- Service role key (tests and admin scripts only -- NOT for app code) ---
SUPABASE_SERVICE_ROLE_KEY=${service_role_key}

# --- Optional -- uncomment and fill in as needed ---
# ANTHROPIC_API_KEY=
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_WHATSAPP_FROM=
EOF
}

# ---------------------------------------------------------------------------
# start_local_dev — interactive wrapper: checks prerequisites, starts Supabase,
#   and prints helpful next-step instructions.
# ---------------------------------------------------------------------------
start_local_dev() {
  if ! command -v supabase &> /dev/null; then
    echo "Error: Supabase CLI not found. Install it first:" >&2
    echo "  brew install supabase/tap/supabase (macOS)" >&2
    echo "  https://supabase.com/docs/guides/cli/getting-started" >&2
    exit 1
  fi

  require_supabase_version

  echo "================================================"
  echo "  Starting Supabase Local Development Environment"
  echo "================================================"
  echo ""

  if supabase status > /dev/null 2>&1; then
    echo "Supabase already running, skipping start."
    supabase status
  else
    echo "Starting Supabase services..."
    start_supabase
  fi

  echo ""
  echo "================================================"
  echo "  LOCAL ENVIRONMENT READY"
  echo "================================================"
  echo ""
  echo "Supabase Studio:  http://localhost:54323"
  echo ""
  echo "------------------------------------------------"
  echo "  Quick Start Commands"
  echo "------------------------------------------------"
  echo ""
  echo "Save environment variables:"
  echo "  ./scripts/local-dev.sh print_setup_env_vars > .env.local"
  echo ""
  echo "Verify setup:"
  echo "  ./scripts/setup/verify.sh"
  echo ""
  echo "Run unit tests:"
  echo "  cd web && npm test"
  echo ""
  echo "Run integration tests:"
  echo "  ./scripts/test-integration.sh"
  echo ""
  echo "------------------------------------------------"
  echo "To stop Supabase: supabase stop"
  echo "To view logs:     supabase logs"
  echo ""
}

# ---------------------------------------------------------------------------
# Subcommand dispatch
# ---------------------------------------------------------------------------
COMMAND="${1:-}"
case "$COMMAND" in
  print_setup_env_vars)
    print_setup_env_vars
    ;;
  "")
    start_local_dev
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    echo "Usage: $0 [print_setup_env_vars]" >&2
    exit 1
    ;;
esac
