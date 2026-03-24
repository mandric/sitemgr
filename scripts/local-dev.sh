#!/bin/bash
# Local development environment setup
# Thin wrapper over lib.sh — all logic lives there.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$SCRIPT_DIR/lib.sh"

# ---------------------------------------------------------------------------
# start_local_dev — interactive wrapper: installs prerequisites, starts
#   Supabase, and prints helpful next-step instructions.
# ---------------------------------------------------------------------------
start_local_dev() {
  install_supabase_cli
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
  echo "Save environment variables:"
  echo "  ./scripts/local-dev.sh print_setup_env_vars > .env.local"
  echo ""
  echo "Verify setup:  ./scripts/setup/verify.sh"
  echo "Unit tests:    cd web && npm test"
  echo "Integration:   ./scripts/test-integration.sh"
  echo "Stop:          supabase stop"
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
