#!/bin/bash
set -euo pipefail

# Only run in remote (Claude Code on the web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install gh CLI if not present
if ! command -v gh &>/dev/null; then
  mkdir -p /tmp/gh-install && cd /tmp/gh-install
  curl -sL https://github.com/cli/cli/releases/download/v2.65.0/gh_2.65.0_linux_amd64.tar.gz -o gh.tar.gz
  tar xzf gh.tar.gz
  cp gh_2.65.0_linux_amd64/bin/gh /usr/local/bin/gh 2>/dev/null \
    || { mkdir -p "$HOME/.local/bin" && cp gh_2.65.0_linux_amd64/bin/gh "$HOME/.local/bin/gh" && echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"; }
  rm -rf /tmp/gh-install
fi

# Set GH_REPO so gh works through the git proxy (can't infer repo from proxy URL)
# Parse owner/repo from the git remote
GH_REPO_DETECTED=$(git -C "$CLAUDE_PROJECT_DIR" remote get-url origin 2>/dev/null \
  | sed -n 's|.*/git/\(.*\)$|\1|p' \
  | sed 's/\.git$//')
if [ -n "${GH_REPO_DETECTED:-}" ]; then
  echo "export GH_REPO=\"${GH_REPO_DETECTED}\"" >> "$CLAUDE_ENV_FILE"
  export GH_REPO="$GH_REPO_DETECTED"
fi

# Source shared shell library (Supabase version constants, install/start helpers)
# shellcheck source=../../../scripts/lib.sh
source "$CLAUDE_PROJECT_DIR/scripts/lib.sh"

# Install jq (required for env var generation and smoke tests)
install_jq

# Install shellcheck (required for shell script linting)
install_shellcheck

# Install Supabase CLI if not present
install_supabase_cli

# Install Vercel CLI if not present
if ! command -v vercel &>/dev/null; then
  npm install -g vercel
fi

# Install Playwright browsers if not present
if ! npx playwright install --dry-run chromium &>/dev/null 2>&1; then
  npx playwright install --with-deps chromium
fi

# Start Docker daemon if not running (needed for Supabase)
if ! docker info &>/dev/null 2>&1; then
  echo "Starting Docker daemon..."
  sudo dockerd &>/tmp/dockerd.log &
  # Wait for Docker to be ready (up to 30 seconds)
  for i in $(seq 1 30); do
    if docker info &>/dev/null 2>&1; then
      echo "Docker daemon started"
      break
    fi
    sleep 1
  done
fi

# Install Node.js dependencies for the web app
cd "$CLAUDE_PROJECT_DIR/web"
npm install

# Start local Supabase (if not already running)
cd "$CLAUDE_PROJECT_DIR"
start_supabase

# Generate .env.local from running Supabase (needed for integration tests)
if [ ! -f "$CLAUDE_PROJECT_DIR/.env.local" ]; then
  print_setup_env_vars > "$CLAUDE_PROJECT_DIR/.env.local" \
    && echo "Generated .env.local from Supabase"
fi

# Plugin installation (ensures plugins are available in web sessions)
# Wrapped in subshell to isolate from set -euo pipefail
(
  set +e  # Disable exit-on-error for this block

  # Skip if plugins already installed
  if claude plugin list 2>/dev/null | grep -q "deep-plan"; then
    echo "Plugins already installed, skipping"
  else
    claude plugin marketplace add piercelamb/deep-project --scope project
    claude plugin marketplace add piercelamb/deep-plan --scope project
    claude plugin marketplace add piercelamb/deep-implement --scope project
    claude plugin marketplace add anthropics/claude-plugins-official --scope project

    claude plugin install deep-project@piercelamb-plugins --scope project
    claude plugin install deep-plan@piercelamb-deep-plan --scope project
    claude plugin install deep-implement@piercelamb-plugins --scope project
    claude plugin install code-review@claude-plugins-official --scope project
  fi
) || true  # Ensure subshell failure doesn't kill the hook
