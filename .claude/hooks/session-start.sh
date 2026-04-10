#!/bin/bash
set -euo pipefail

# Only run in remote (Claude Code on the web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Source shared shell library and .env.local (if it exists from a previous session)
# shellcheck source=../../../scripts/init.sh
source "$CLAUDE_PROJECT_DIR/scripts/init.sh"

# ---------------------------------------------------------------------------
# Phase 1: Start Docker + all independent work in parallel
#   Docker takes up to 30s. Tool installs, npm install, and GH_REPO
#   detection all run concurrently while it starts.
# ---------------------------------------------------------------------------

# Start Docker in background (Supabase depends on it)
start_docker &
DOCKER_PID=$!

# Install gh CLI if not present (background)
(
  if ! command -v gh &>/dev/null; then
    mkdir -p /tmp/gh-install && cd /tmp/gh-install
    curl -sL https://github.com/cli/cli/releases/download/v2.65.0/gh_2.65.0_linux_amd64.tar.gz -o gh.tar.gz
    tar xzf gh.tar.gz
    cp gh_2.65.0_linux_amd64/bin/gh /usr/local/bin/gh 2>/dev/null \
      || { mkdir -p "$HOME/.local/bin" && cp gh_2.65.0_linux_amd64/bin/gh "$HOME/.local/bin/gh" && echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"; }
    rm -rf /tmp/gh-install
  fi
) &
GH_PID=$!

# Install jq, shellcheck, supabase CLI, vercel CLI in parallel
install_jq &
JQ_PID=$!

install_shellcheck &
SC_PID=$!

install_supabase_cli &
SB_PID=$!

(
  if ! command -v vercel &>/dev/null; then
    npm install -g vercel
  fi
) &
VERCEL_PID=$!

# npm install — independent of Docker, runs concurrently with everything
(cd "$CLAUDE_PROJECT_DIR/web" && npm install) &
NPM_PID=$!

# Set GH_REPO so gh works through the git proxy (can't infer repo from proxy URL)
GH_REPO_DETECTED=$(git -C "$CLAUDE_PROJECT_DIR" remote get-url origin 2>/dev/null \
  | sed -n 's|.*/git/\(.*\)$|\1|p' \
  | sed 's/\.git$//')
if [ -n "${GH_REPO_DETECTED:-}" ]; then
  echo "export GH_REPO=\"${GH_REPO_DETECTED}\"" >> "$CLAUDE_ENV_FILE"
  export GH_REPO="$GH_REPO_DETECTED"
fi

# ---------------------------------------------------------------------------
# Phase 2: Wait for Docker + tools, then start Supabase
#
# NOTE: Playwright chromium is NOT installed here — it's ~200MB and only
# needed for E2E web tests. It installs lazily via the pretest:e2e script
# in package.json when `npm run test:e2e` is first run.
# ---------------------------------------------------------------------------

# Docker is required (Supabase depends on it); tools are best-effort.
wait $DOCKER_PID
for pid in $GH_PID $JQ_PID $SC_PID $SB_PID $VERCEL_PID; do
  wait "$pid" || echo "Warning: background install (PID $pid) failed" >&2
done

# Start Supabase and npm install in parallel — setup_supabase needs Docker
# (done above) but not npm; npm install needs nothing from Supabase.
# Uses setup_supabase (not start_supabase which tails logs and blocks forever)
cd "$CLAUDE_PROJECT_DIR"
setup_supabase

# Wait for npm install to finish before generating .env.local
wait $NPM_PID

# Generate .env.local from running Supabase (needed for integration tests)
if [ ! -f "$CLAUDE_PROJECT_DIR/.env.local" ]; then
  print_setup_env_vars > "$CLAUDE_PROJECT_DIR/.env.local" \
    && echo "Generated .env.local from Supabase"
fi

# ---------------------------------------------------------------------------
# Phase 4: Plugin installation
# ---------------------------------------------------------------------------
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
