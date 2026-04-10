#!/bin/bash

# SessionStart hook — sets up the full dev environment for Claude Code web sessions.
#
# EXIT CODE POLICY: Always exit 0.
#   SessionStart hooks are non-blocking — a non-zero exit code doesn't prevent
#   the session from starting, it just adds noise to the transcript.
#   See: https://docs.anthropic.com/en/docs/claude-code/hooks
#   Everything in this script is a dev dependency. Log errors so they surface
#   in /tmp/session-start.log, but let the session proceed. Failures will show
#   up naturally when something tries to use a missing service.

# Only run in remote (Claude Code on the web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Log all output for debugging (read with: cat /tmp/session-start.log)
exec > >(tee -a /tmp/session-start.log) 2>&1

# Timestamped, prefixed logging for readable parallel output.
# Usage: log <label> <message>
#   log docker "started"        → [00:03] docker: started
#   log npm "install failed"    → [01:42] npm: install failed
HOOK_START=$SECONDS
log() {
  local elapsed=$(( SECONDS - HOOK_START ))
  printf "[%02d:%02d] %s: %s\n" $((elapsed/60)) $((elapsed%60)) "$1" "$2"
}

# Wraps a command with start/done/FAILED logging. Captures the label from $1,
# runs the rest as a command.
# Usage: run <label> <command> [args...]
run() {
  local label="$1"; shift
  log "$label" "started"
  if "$@"; then
    log "$label" "done"
  else
    log "$label" "FAILED (exit $?)"
  fi
}

log "hook" "=== session-start $(date -Iseconds) ==="

# Source shared shell library and .env.local (if it exists from a previous session)
# shellcheck source=../../../scripts/init.sh
source "$CLAUDE_PROJECT_DIR/scripts/init.sh"

# ---------------------------------------------------------------------------
# Phase 1: Start Docker + all independent work in parallel
#   Docker takes up to 30s. Tool installs, npm install, and GH_REPO
#   detection all run concurrently while it starts.
# ---------------------------------------------------------------------------

run docker start_docker &
DOCKER_PID=$!

run gh install_gh &
run jq install_jq &
run shellcheck install_shellcheck &
run supabase-cli install_supabase_cli &
run vercel install_vercel &
run npm bash -c "cd '$CLAUDE_PROJECT_DIR/web' && npm install" &

# Set GH_REPO so gh works through the git proxy (can't infer repo from proxy URL)
GH_REPO_DETECTED=$(git -C "$CLAUDE_PROJECT_DIR" remote get-url origin 2>/dev/null \
  | sed -n 's|.*/git/\(.*\)$|\1|p' \
  | sed 's/\.git$//')
if [ -n "${GH_REPO_DETECTED:-}" ]; then
  echo "export GH_REPO=\"${GH_REPO_DETECTED}\"" >> "$CLAUDE_ENV_FILE"
  export GH_REPO="$GH_REPO_DETECTED"
  log gh-repo "set GH_REPO=$GH_REPO_DETECTED"
fi

# ---------------------------------------------------------------------------
# Phase 2: Wait for Docker, then start Supabase (backgrounded)
#
# NOTE: Playwright chromium is NOT installed here — it's ~200MB and only
# needed for E2E web tests. It installs lazily via npm run setup:playwright.
# ---------------------------------------------------------------------------

wait $DOCKER_PID
(
  run supabase setup_supabase
  # Generate .env.local from running Supabase (needed for integration tests)
  if [ ! -f "$CLAUDE_PROJECT_DIR/.env.local" ]; then
    print_setup_env_vars > "$CLAUDE_PROJECT_DIR/.env.local" \
      && log env "generated .env.local"
  fi
) &

# ---------------------------------------------------------------------------
# Phase 3: Plugin installation (best-effort)
# ---------------------------------------------------------------------------

if claude plugin list 2>/dev/null | grep -q "deep-plan"; then
  log plugins "already installed, skipping"
else
  log plugins "installing"
  claude plugin marketplace add piercelamb/deep-project --scope project 2>&1 || log plugins "FAILED: add deep-project marketplace"
  claude plugin marketplace add piercelamb/deep-plan --scope project 2>&1 || log plugins "FAILED: add deep-plan marketplace"
  claude plugin marketplace add piercelamb/deep-implement --scope project 2>&1 || log plugins "FAILED: add deep-implement marketplace"
  claude plugin marketplace add anthropics/claude-plugins-official --scope project 2>&1 || log plugins "FAILED: add claude-plugins-official marketplace"

  claude plugin install deep-project@piercelamb-plugins --scope project 2>&1 || log plugins "FAILED: install deep-project"
  claude plugin install deep-plan@piercelamb-deep-plan --scope project 2>&1 || log plugins "FAILED: install deep-plan"
  claude plugin install deep-implement@piercelamb-plugins --scope project 2>&1 || log plugins "FAILED: install deep-implement"
  claude plugin install code-review@claude-plugins-official --scope project 2>&1 || log plugins "FAILED: install code-review"
  log plugins "done"
fi

# Wait for any remaining background jobs (npm install, tool installs, supabase)
wait
log "hook" "=== done ==="
