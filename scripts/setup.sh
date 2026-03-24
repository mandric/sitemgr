#!/bin/bash
# First-time setup script for sitemgr development environment
# Requires: supabase CLI, docker, node 20+, npm, jq

set -euo pipefail
IFS=$'\n\t'

echo "================================================"
echo "  sitemgr Development Environment Setup"
echo "================================================"
echo ""

check_prerequisites() {
  local missing=()

  if ! command -v supabase &>/dev/null; then
    missing+=("  supabase — install: source scripts/lib.sh && install_supabase_cli")
  fi

  if ! command -v docker &>/dev/null; then
    missing+=("  docker   — install: https://docs.docker.com/get-docker/")
  fi

  if ! command -v node &>/dev/null; then
    missing+=("  node     — install: https://nodejs.org/ (Node.js 20+ required)")
  else
    local node_major
    node_major=$(node -v | sed 's/v//' | cut -d. -f1)
    if ! [[ "$node_major" =~ ^[0-9]+$ ]]; then
      missing+=("  node     — could not determine version (got: $(node -v)); Node.js 20+ required")
    elif [ "$node_major" -lt 20 ]; then
      missing+=("  node     — version 20+ required (found $(node -v))")
    fi
  fi

  if ! command -v npm &>/dev/null; then
    missing+=("  npm      — install Node.js from https://nodejs.org/ (npm is included)")
  fi

  if ! command -v jq &>/dev/null; then
    missing+=("  jq       — install: source scripts/lib.sh && install_jq")
  fi

  if [ ${#missing[@]} -gt 0 ]; then
    echo "Error: The following required tools are missing:" >&2
    for item in "${missing[@]}"; do
      echo "$item" >&2
    done
    return 1
  fi
}

check_prerequisites

echo "Found Node.js $(node -v)"
echo "Found npm $(npm -v)"

# Install web dependencies
echo ""
echo "Installing web dependencies..."
cd web
npm install
cd ..

echo ""
echo "================================================"
echo "  Setup Complete"
echo "================================================"
echo ""
echo "Next steps:"
echo ""
echo "1. Start Supabase and generate environment variables:"
echo "   ./scripts/local-dev.sh"
echo "   cd web && npm run setup:env"
echo ""
echo "2. Verify the environment:"
echo "   ./scripts/setup/verify.sh"
echo ""
echo "3. Run tests:"
echo "   cd web && npm test"
echo ""
