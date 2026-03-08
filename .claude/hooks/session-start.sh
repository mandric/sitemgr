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

# Install Node.js dependencies only when needed
cd "$CLAUDE_PROJECT_DIR/web"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm install
fi
