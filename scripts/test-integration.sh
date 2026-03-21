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

# ── Load environment ────────────────────────────────────────────

if [ ! -f ".env.local" ]; then
  echo "ERROR: .env.local not found. Run ./scripts/local-dev.sh first:" >&2
  echo "  ./scripts/local-dev.sh print_setup_env_vars > .env.local" >&2
  exit 1
fi
set -a
source .env.local
set +a

if [ -z "${SMGR_API_URL:-}" ]; then
  echo "ERROR: SMGR_API_URL is not set after sourcing .env.local." >&2
  echo "Re-generate it: ./scripts/local-dev.sh print_setup_env_vars > .env.local" >&2
  exit 1
fi

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
