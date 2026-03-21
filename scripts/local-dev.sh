#!/bin/bash
# Local development environment setup using Supabase CLI
# This script starts a full local Supabase environment (Postgres + Storage + Edge Functions)

set -euo pipefail
IFS=$'\n\t'

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
  # Generate an ES256 service-role JWT if GoTrue is using GOTRUE_JWT_KEYS
  # (Supabase CLI ≥ 2.78 sets up an EC key pair; HS256 service_role JWTs are
  # rejected with "signing method HS256 is invalid" when only an EC key is
  # configured). Fall back to the HS256 service_role_key for older CLI versions.
  # ---------------------------------------------------------------------------
  local supabase_secret_key="$service_role_key"
  local auth_container
  auth_container=$(docker ps --format '{{.Names}}' 2>/dev/null | grep '^supabase_auth_' | head -1)
  if [ -n "$auth_container" ]; then
    local gotrue_jwt_keys
    gotrue_jwt_keys=$(docker exec "$auth_container" sh -c 'printf "%s" "$GOTRUE_JWT_KEYS"' 2>/dev/null || true)
    if [ -n "$gotrue_jwt_keys" ] && [ "$gotrue_jwt_keys" != "null" ]; then
      local es256_jwt
      es256_jwt=$(node -e "
const crypto = require('crypto');
const jwks = JSON.parse(process.argv[1]);
const jwk = jwks.find(k => k.alg === 'ES256' && k.d) || jwks.find(k => k.d);
if (!jwk) { process.exit(1); }
const header = Buffer.from(JSON.stringify({alg:'ES256',typ:'JWT',kid:jwk.kid})).toString('base64url');
const payload = Buffer.from(JSON.stringify({iss:'supabase-local',role:'service_role',exp:9999999999})).toString('base64url');
const msg = Buffer.from(header + '.' + payload);
const privateKey = crypto.createPrivateKey({key:jwk, format:'jwk'});
const sig = crypto.sign('SHA256', msg, {key:privateKey, dsaEncoding:'ieee-p1363'}).toString('base64url');
console.log(header + '.' + payload + '.' + sig);
" "$gotrue_jwt_keys" 2>/dev/null || true)
      if [ -n "$es256_jwt" ]; then
        supabase_secret_key="$es256_jwt"
      fi
    fi
  fi

  cat <<EOF
# Supabase / API
NEXT_PUBLIC_SUPABASE_URL=${api_url}
SMGR_API_URL=${api_url}
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${anon_key}
SMGR_API_KEY=${anon_key}
SUPABASE_SECRET_KEY=${supabase_secret_key}
DATABASE_URL=${db_url}

# S3 / Storage
SMGR_S3_ENDPOINT=${s3_endpoint}
AWS_ENDPOINT_URL_S3=${s3_endpoint}
SMGR_S3_BUCKET=media
SMGR_S3_REGION=local
AWS_ACCESS_KEY_ID=${s3_key_id}
AWS_SECRET_ACCESS_KEY=${s3_key_secret}

# smgr CLI
SMGR_DEVICE_ID=local-dev
SMGR_AUTO_ENRICH=false

# Encryption (generated fresh — local dev data is ephemeral)
ENCRYPTION_KEY_CURRENT=${encryption_key}

# Optional — uncomment and fill in as needed
# ANTHROPIC_API_KEY=
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_WHATSAPP_FROM=
EOF
}

# ---------------------------------------------------------------------------
# start_supabase — idempotent: skips start if already running
# ---------------------------------------------------------------------------
start_supabase() {
  if ! command -v supabase &> /dev/null; then
    echo "Error: Supabase CLI not found. Install it first:" >&2
    echo "  brew install supabase/tap/supabase (macOS)" >&2
    echo "  https://supabase.com/docs/guides/cli/getting-started" >&2
    exit 1
  fi

  echo "================================================"
  echo "  Starting Supabase Local Development Environment"
  echo "================================================"
  echo ""

  if supabase status > /dev/null 2>&1; then
    echo "Supabase already running, skipping start."
    supabase status
  else
    echo "Starting Supabase services..."
    supabase start
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
    start_supabase
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    echo "Usage: $0 [print_setup_env_vars]" >&2
    exit 1
    ;;
esac
