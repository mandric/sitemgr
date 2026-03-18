#!/bin/bash
# Session start hook for Claude Code on the web
# Each step is isolated — a failure in one step does not block subsequent steps.

# Only run in remote (Claude Code on the web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

LOG_PREFIX="[session-start]"
FAILURES=0

log()  { echo "$LOG_PREFIX $*"; }
fail() { echo "$LOG_PREFIX ERROR: $*" >&2; FAILURES=$((FAILURES + 1)); }

# Resolve project dir (fallback to script location)
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

# --- gh CLI ---
if ! command -v gh &>/dev/null; then
  log "Installing gh CLI..."
  if (
    set -e
    mkdir -p /tmp/gh-install && cd /tmp/gh-install
    curl -sL https://github.com/cli/cli/releases/download/v2.65.0/gh_2.65.0_linux_amd64.tar.gz -o gh.tar.gz
    tar xzf gh.tar.gz
    cp gh_2.65.0_linux_amd64/bin/gh /usr/local/bin/gh 2>/dev/null \
      || { mkdir -p "$HOME/.local/bin" && cp gh_2.65.0_linux_amd64/bin/gh "$HOME/.local/bin/gh" \
           && [ -n "${CLAUDE_ENV_FILE:-}" ] \
           && echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"; }
  ); then
    log "gh CLI installed."
  else
    fail "gh CLI installation failed."
  fi
  rm -rf /tmp/gh-install
else
  log "gh CLI already present."
fi

# --- GH_REPO env var ---
GH_REPO_DETECTED=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null \
  | sed -n 's|.*/git/\(.*\)$|\1|p' \
  | sed 's/\.git$//')
if [ -n "${GH_REPO_DETECTED:-}" ]; then
  export GH_REPO="$GH_REPO_DETECTED"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export GH_REPO=\"${GH_REPO_DETECTED}\"" >> "$CLAUDE_ENV_FILE"
  fi
  log "GH_REPO set to $GH_REPO_DETECTED"
else
  fail "Could not detect GH_REPO from git remote."
fi

# --- Supabase CLI (direct binary — npm install -g is not supported) ---
if ! command -v supabase &>/dev/null; then
  SUPABASE_VERSION="2.78.1"
  log "Installing Supabase CLI v${SUPABASE_VERSION}..."
  if (
    set -e
    mkdir -p /tmp/supabase-install && cd /tmp/supabase-install
    curl -sL "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_linux_amd64.tar.gz" -o supabase.tar.gz
    tar xzf supabase.tar.gz
    cp supabase /usr/local/bin/supabase 2>/dev/null \
      || { mkdir -p "$HOME/.local/bin" && cp supabase "$HOME/.local/bin/supabase" \
           && [ -n "${CLAUDE_ENV_FILE:-}" ] \
           && echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"; }
  ); then
    log "Supabase CLI installed."
  else
    fail "Supabase CLI installation failed."
  fi
  rm -rf /tmp/supabase-install
else
  log "Supabase CLI already present."
fi

# --- Vercel CLI ---
if ! command -v vercel &>/dev/null; then
  log "Installing Vercel CLI..."
  if npm install -g vercel 2>&1; then
    log "Vercel CLI installed."
  else
    fail "Vercel CLI installation failed (npm install -g vercel)."
  fi
else
  log "Vercel CLI already present."
fi

# --- Playwright browsers ---
if ! npx playwright install --dry-run chromium &>/dev/null 2>&1; then
  log "Installing Playwright chromium..."
  if npx playwright install --with-deps chromium 2>&1; then
    log "Playwright chromium installed."
  else
    fail "Playwright chromium installation failed."
  fi
else
  log "Playwright chromium already present."
fi

# --- Node.js dependencies for web app ---
if [ -f "$PROJECT_DIR/web/package.json" ]; then
  log "Installing web app dependencies..."
  if (cd "$PROJECT_DIR/web" && npm install 2>&1); then
    log "Web app dependencies installed."
  else
    fail "npm install in web/ failed."
  fi
else
  fail "web/package.json not found at $PROJECT_DIR/web."
fi

# --- Start local Supabase ---
if command -v supabase &>/dev/null; then
  if ! supabase status &>/dev/null 2>&1; then
    log "Starting local Supabase..."
    if (cd "$PROJECT_DIR" && supabase start 2>&1); then
      log "Supabase started."
    else
      fail "supabase start failed."
    fi
  else
    log "Supabase already running."
  fi
else
  fail "Skipping supabase start — CLI not available."
fi

# --- Summary ---
if [ "$FAILURES" -gt 0 ]; then
  log "Completed with $FAILURES failure(s). Review errors above."
else
  log "All steps completed successfully."
fi

# Always exit 0 so the session starts even if some steps failed
exit 0
