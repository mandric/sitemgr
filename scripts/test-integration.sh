#!/usr/bin/env bash
#
# Starts all services required for smgr integration tests, then runs them.
#
#   Supabase  — local Postgres, Auth, Storage (S3)
#   Ollama    — local vision model for enrichment e2e tests
#
# Usage:
#   ./scripts/test-integration.sh          # run all integration tests
#   ./scripts/test-integration.sh --skip-ollama  # skip Ollama (skips e2e enrichment tests)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SKIP_OLLAMA=false
for arg in "$@"; do
  case "$arg" in
    --skip-ollama) SKIP_OLLAMA=true ;;
  esac
done

# ── Dependency checks ───────────────────────────────────────────

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "Error: $1 not found. $2"
    exit 1
  fi
}

check_cmd supabase "Install: brew install supabase/tap/supabase"
check_cmd docker   "Install Docker Desktop or docker engine"
check_cmd jq       "Install: brew install jq (macOS) / apt install jq (Linux)"
check_cmd node     "Install Node.js 20+: https://nodejs.org/"

# ── npm dependencies ────────────────────────────────────────────

if [ ! -d "web/node_modules" ]; then
  echo "Installing web dependencies..."
  (cd web && npm ci)
fi

# ── Start Supabase ──────────────────────────────────────────────

echo ""
echo "=== Starting Supabase ==="

# Check if already running
if supabase status -o json &>/dev/null; then
  echo "Supabase already running."
else
  supabase start
fi

# Extract connection details
STATUS_JSON=$(supabase status -o json 2>/dev/null)

SMGR_API_URL=$(echo "$STATUS_JSON" | jq -r '.API_URL // "http://127.0.0.1:54321"')
SMGR_API_KEY=$(echo "$STATUS_JSON" | jq -r '.ANON_KEY')
SUPABASE_SECRET_KEY=$(echo "$STATUS_JSON" | jq -r '.SERVICE_ROLE_KEY')

export SMGR_API_URL
export SMGR_API_KEY
export SUPABASE_SECRET_KEY

echo "  API URL:    $SMGR_API_URL"
echo "  API Key:    ${SMGR_API_KEY:0:20}..."
echo "  Secret Key: ${SUPABASE_SECRET_KEY:0:20}..."

# Ensure the 'media' storage bucket exists (for S3 e2e tests)
STORAGE_ENDPOINT="$SMGR_API_URL/storage/v1"
curl -sf -X POST "$STORAGE_ENDPOINT/bucket" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"media","name":"media","public":false}' \
  2>/dev/null || true

# S3 credentials for storage tests
STATUS_TABLE=$(supabase status 2>/dev/null)
AWS_ACCESS_KEY_ID=$(echo "$STATUS_TABLE" | grep "Access Key" | awk -F '│' '{print $3}' | tr -d ' ')
AWS_SECRET_ACCESS_KEY=$(echo "$STATUS_TABLE" | grep "Secret Key" | awk -F '│' '{print $3}' | tr -d ' ')
# Fallback: use service key if S3 keys not found in status output
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-$SUPABASE_SECRET_KEY}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-$SUPABASE_SECRET_KEY}"

# ── Start Ollama ────────────────────────────────────────────────

if [ "$SKIP_OLLAMA" = false ]; then
  echo ""
  echo "=== Starting Ollama ==="

  docker compose up -d ollama
  echo "Waiting for Ollama to be healthy..."

  for i in $(seq 1 30); do
    if curl -sf http://localhost:11434/api/tags &>/dev/null; then
      echo "  Ollama is ready."
      break
    fi
    if [ "$i" = 30 ]; then
      echo "Error: Ollama did not become healthy within 5 minutes."
      echo "Check: docker compose logs ollama"
      exit 1
    fi
    sleep 10
  done

  # Pull the model (no-op if already present)
  echo "Ensuring moondream:1.8b model is available..."
  docker compose exec ollama ollama pull moondream:1.8b
  echo "  Model ready."
else
  echo ""
  echo "=== Skipping Ollama (--skip-ollama) ==="
fi

# ── Run tests ───────────────────────────────────────────────────

echo ""
echo "=== Running integration tests ==="
echo ""

cd web
npx vitest run --project integration --reporter=verbose
