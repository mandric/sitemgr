#!/bin/bash

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

start_docker &
DOCKER_PID=$!

install_gh &
install_jq &
install_shellcheck &
install_supabase_cli &

# Vercel CLI uses npm (no lib.sh function needed for a one-liner)
if ! command -v vercel &>/dev/null; then
  npm install -g vercel &
fi

# npm install — independent of Docker
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
# needed for E2E web tests. It installs lazily via setup:playwright / the
# pretest:e2e hook in package.json.
# ---------------------------------------------------------------------------

# Docker is required (Supabase depends on it). Tool installs are best-effort
# — wait for all background jobs, only fail on Docker.
wait $DOCKER_PID || { echo "Error: Docker failed to start" >&2; exit 1; }
wait $NPM_PID || echo "Warning: npm install failed" >&2

# setup_supabase (not start_supabase which tails logs and blocks forever)
cd "$CLAUDE_PROJECT_DIR" || exit 1
setup_supabase || echo "Warning: Supabase setup failed" >&2

# Generate .env.local from running Supabase (needed for integration tests)
if [ ! -f "$CLAUDE_PROJECT_DIR/.env.local" ]; then
  print_setup_env_vars > "$CLAUDE_PROJECT_DIR/.env.local" \
    && echo "Generated .env.local from Supabase"
fi

# ---------------------------------------------------------------------------
# Phase 3: Plugin installation (best-effort)
# ---------------------------------------------------------------------------

if claude plugin list 2>/dev/null | grep -q "deep-plan"; then
  echo "Plugins already installed, skipping"
else
  claude plugin marketplace add piercelamb/deep-project --scope project || true
  claude plugin marketplace add piercelamb/deep-plan --scope project || true
  claude plugin marketplace add piercelamb/deep-implement --scope project || true
  claude plugin marketplace add anthropics/claude-plugins-official --scope project || true

  claude plugin install deep-project@piercelamb-plugins --scope project || true
  claude plugin install deep-plan@piercelamb-deep-plan --scope project || true
  claude plugin install deep-implement@piercelamb-plugins --scope project || true
  claude plugin install code-review@claude-plugins-official --scope project || true
fi
