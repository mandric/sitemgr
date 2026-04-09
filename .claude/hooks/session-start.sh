#!/bin/bash
set -euo pipefail

# Only run in remote (Claude Code on the web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Source shared shell library (Supabase version constants, install/start helpers)
# shellcheck source=../../../scripts/lib.sh
source "$CLAUDE_PROJECT_DIR/scripts/lib.sh"

# ---------------------------------------------------------------------------
# Phase 1: Start Docker + parallel tool installs
#   Docker takes up to 30s. Install tools concurrently while it starts.
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

# Set GH_REPO so gh works through the git proxy (can't infer repo from proxy URL)
GH_REPO_DETECTED=$(git -C "$CLAUDE_PROJECT_DIR" remote get-url origin 2>/dev/null \
  | sed -n 's|.*/git/\(.*\)$|\1|p' \
  | sed 's/\.git$//')
if [ -n "${GH_REPO_DETECTED:-}" ]; then
  echo "export GH_REPO=\"${GH_REPO_DETECTED}\"" >> "$CLAUDE_ENV_FILE"
  export GH_REPO="$GH_REPO_DETECTED"
fi

# ---------------------------------------------------------------------------
# Phase 2: npm install (can run while Docker + tools are still installing)
# ---------------------------------------------------------------------------

cd "$CLAUDE_PROJECT_DIR/web"
npm install

# ---------------------------------------------------------------------------
# Phase 3: Playwright — skip download if chromium is already cached
#   Parse the expected install path from --dry-run and check if it exists.
# ---------------------------------------------------------------------------

PW_CHROMIUM_DIR=$(npx playwright install --dry-run chromium 2>/dev/null \
  | grep -oP 'Install location:\s+\K.*' | head -1)

if [ -n "$PW_CHROMIUM_DIR" ] && [ -d "$PW_CHROMIUM_DIR" ]; then
  echo "Playwright chromium already cached at $PW_CHROMIUM_DIR, skipping download"
  # Still install system deps if needed (fast, idempotent)
  npx playwright install-deps chromium 2>/dev/null || true
else
  npx playwright install --with-deps chromium
fi

# ---------------------------------------------------------------------------
# Phase 4: Wait for Docker + tools, then start Supabase
# ---------------------------------------------------------------------------

# Wait for all background tool installs
# Docker is required (Supabase depends on it); tools are best-effort.
wait $DOCKER_PID
for pid in $GH_PID $JQ_PID $SC_PID $SB_PID $VERCEL_PID; do
  wait "$pid" || echo "Warning: background install (PID $pid) failed" >&2
done

# Start local Supabase — uses setup_supabase (not start_supabase which tails
# logs and blocks forever)
cd "$CLAUDE_PROJECT_DIR"
setup_supabase

# Generate .env.local from running Supabase (needed for integration tests)
if [ ! -f "$CLAUDE_PROJECT_DIR/.env.local" ]; then
  print_setup_env_vars > "$CLAUDE_PROJECT_DIR/.env.local" \
    && echo "Generated .env.local from Supabase"
fi

# ---------------------------------------------------------------------------
# Phase 5: Plugin installation
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
