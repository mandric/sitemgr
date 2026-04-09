#!/bin/bash
# Lazy Playwright chromium installer — runs as pretest:e2e hook.
# Skips download if the expected chromium version is already cached.

set -euo pipefail

CHROMIUM_DIR=$(npx playwright install --dry-run chromium 2>/dev/null \
  | grep -oP 'Install location:\s+\K.*' | head -1 || true)

if [ -n "$CHROMIUM_DIR" ] && [ -d "$CHROMIUM_DIR" ]; then
  echo "Playwright chromium already cached at $CHROMIUM_DIR"
else
  echo "Installing Playwright chromium..."
  npx playwright install --with-deps chromium
fi
