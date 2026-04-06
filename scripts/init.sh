#!/usr/bin/env bash
# Shell init for sitemgr development environment.
# Source this file to load lib.sh functions and .env.local into your shell.
#
# Usage (from repo root or web/):
#   source scripts/init.sh
#   source ../scripts/init.sh
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPTS_DIR/lib.sh"
if [ -f "$SCRIPTS_DIR/../web/.env.local" ]; then
  source_dotenv "$SCRIPTS_DIR/../web/.env.local"
fi
