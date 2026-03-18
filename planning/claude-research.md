# Research Findings: Fix Session-Start Hook

## Codebase Research

### Current State of `.claude/hooks/session-start.sh`

The fix described in the spec is **already implemented** on this branch (`claude/check-deep-plan-skill-68AV4`). The current file (139 lines) contains a fully resilient hook that installs Supabase CLI via direct binary download.

#### Key Implementation Details

**Script structure:**
- Only runs in remote environments (`CLAUDE_CODE_REMOTE=true` check at top)
- `FAILURES` counter tracks failures without stopping execution
- `log()` / `fail()` helper functions with `[session-start]` prefix
- `exit 0` at the end ensures session always starts

**Per-step isolation pattern (subshell):**
```bash
if (
  set -e
  mkdir -p /tmp/supabase-install && cd /tmp/supabase-install
  curl -sL "..." -o supabase.tar.gz
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
```

**Supabase CLI installation (lines 55-76):**
- Hardcoded version: `2.78.1`
- Download URL: `https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_linux_amd64.tar.gz`
- Extracted binary name: `supabase` (single binary in tarball root)
- Install path: `/usr/local/bin/supabase` with fallback to `$HOME/.local/bin/supabase`
- Pattern is identical to the `gh` CLI installation above it

**Steps in order:**
1. gh CLI (binary download from GitHub)
2. GH_REPO env var detection from git remote
3. Supabase CLI (binary download from GitHub) ← the fix
4. Vercel CLI (`npm install -g vercel` — still npm, not changed)
5. Playwright chromium (`npx playwright install`)
6. Web app dependencies (`npm install` in `web/`)
7. Start local Supabase (`supabase start`)

#### Session Startup Output Confirms Fix Works

From the session startup in this session:
```
[session-start] gh CLI already present.
[session-start] GH_REPO set to mandric/sitemgr
[session-start] Supabase CLI already present.    ← fix working
[session-start] Vercel CLI already present.
[session-start] Playwright chromium already present.
[session-start] Installing web app dependencies...
[session-start] Web app dependencies installed.
[session-start] Starting local Supabase...
failed to inspect service: Cannot connect to the Docker daemon ...  ← expected: no Docker in cloud env
[session-start] Completed with 1 failure(s). Review errors above.
```

The Supabase CLI is successfully installed. The only failure is `supabase start` failing because Docker is not available in the Claude Code web environment — this is expected and acceptable.

### `.claude/settings.json` Hook Configuration

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"
          }
        ]
      }
    ]
  }
}
```

The hook is registered as a `SessionStart` event handler, uses `$CLAUDE_PROJECT_DIR` for path resolution.

### Git History Summary

- `c919930`: Initial hook (Python/Node deps)
- `e9bdf4b`: Added Supabase, Vercel, Playwright
- `bcab68b`: Made hook resilient (removed global `set -euo pipefail`, added per-step isolation)
- `4ef8ba0`: Changed Supabase from `npm install -g supabase` to direct binary download ← the key fix

---

## Web Research (Summary from Domain Knowledge)

Web research agent timed out, but the following is well-established:

### Supabase CLI Release Tarball Format

The official release URL pattern (confirmed by the already-working implementation):
```
https://github.com/supabase/cli/releases/download/v{VERSION}/supabase_linux_amd64.tar.gz
```

The tarball contains a single `supabase` binary at the root (no nested directory unlike the `gh` CLI tarball which nests under `gh_{VERSION}_linux_amd64/bin/`).

### `npm install -g supabase` Is Blocked

The Supabase package explicitly rejects global npm installs with:
```
Installing Supabase CLI as a global module is not supported.
Please use one of the supported package managers: https://github.com/supabase/cli#install-the-cli
```

Binary download from GitHub releases is the correct approach for Linux CI/CD/scripted environments.

### Shell Script Resilience Pattern

The implemented pattern (subshell with `set -e`) is the correct approach:
- Global `set -e` or `set -euo pipefail` at script top causes entire script to abort on first error
- Per-step subshell isolation `(set -e; ...)` limits error propagation to that step
- Idempotency via `command -v` checks prevents re-running steps that already succeeded

---

## Testing Setup

The project uses:
- **Vitest** for unit/integration tests (in `web/`)
- **Playwright** for E2E tests
- No dedicated test framework for shell scripts

For validating the hook fix, testing is primarily manual/observational:
- Run a new Claude Code web session and check session-start output
- Verify `supabase` binary is accessible via `command -v supabase`
- The Docker failure for `supabase start` is expected and acceptable behavior
