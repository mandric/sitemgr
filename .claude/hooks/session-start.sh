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

# Install Supabase CLI if not present (npm global install is blocked by the package)
if ! command -v supabase &>/dev/null; then
  SUPABASE_VERSION="2.83.0"
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
  esac
  curl -fsSL "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin supabase
fi

# Install Vercel CLI if not present
if ! command -v vercel &>/dev/null; then
  npm install -g vercel
fi

# Install Playwright browsers if not present
if ! npx playwright install --dry-run chromium &>/dev/null 2>&1; then
  npx playwright install --with-deps chromium
fi

# Install Node.js dependencies for the web app
cd "$CLAUDE_PROJECT_DIR/web"
npm install

# Start local Supabase (if not already running)
# In web sessions: exclude edge-runtime (needs external DNS) and realtime (needs IPv6)
cd "$CLAUDE_PROJECT_DIR"
if ! supabase status &>/dev/null 2>&1; then
  if [ "$CLAUDE_CODE_REMOTE" = "true" ]; then
    supabase start --exclude edge-runtime,realtime
  else
    supabase start
  fi
fi

# Generate .env.local from running Supabase (needed for integration tests)
if [ ! -f "$CLAUDE_PROJECT_DIR/.env.local" ]; then
  if command -v jq &>/dev/null; then
    "$CLAUDE_PROJECT_DIR/scripts/local-dev.sh" print_setup_env_vars > "$CLAUDE_PROJECT_DIR/.env.local" \
      && echo "Generated .env.local from Supabase"
  else
    echo "Warning: jq not installed, skipping .env.local generation"
  fi
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
