# Section 7: SessionStart Hook Fallback (Conditional)

## Overview

This section is **conditional** -- it should only be implemented if Section 6 (web session verification) fails, meaning that CLI-managed `settings.json` alone does not cause plugins to auto-install in Claude Code web sessions.

The fallback adds plugin installation commands to the existing `.claude/hooks/session-start.sh` so that every web session automatically installs the three `piercelamb` plugins (deep-project, deep-plan, deep-implement) at startup.

**Scope limitation:** This fallback only affects web/remote sessions. The existing `session-start.sh` already exits early when `CLAUDE_CODE_REMOTE` is not `true` (line 5-7), so local CLI sessions are unaffected and continue to rely on `settings.json` from Phase 1.

## Dependencies

- **Section 04 (Install Plugins):** The plugin identifiers and marketplace names used in the hook commands must match those discovered during CLI installation in Section 04. The expected identifiers are:
  - `deep-project@piercelamb-deep-project`
  - `deep-plan@piercelamb-deep-plan`
  - `deep-implement@piercelamb-deep-implement`
- **Section 06 (Web Test):** This section is only executed if Section 06 failed (plugins not available in web session).

## Files to Modify

- `/home/user/sitemgr/.claude/hooks/session-start.sh` -- add plugin installation block

## Tests (Write First)

### Pre-requisite tests

These must pass before attempting the implementation. Run them manually in a web session context or simulate the hook environment.

```bash
# Test: `which claude` succeeds in the hook's execution context
# Verifies the claude binary is available when session-start.sh runs.
# If this fails, the fallback strategy cannot work as designed.

# Test: `claude plugin install` can be called from within a SessionStart hook without deadlock
# The hook is invoked by the claude process itself. Calling `claude plugin install`
# from within it could cause re-entrancy issues. Test with a minimal hook that
# runs `claude plugin list` and confirm it completes without hanging.
```

If either pre-requisite fails, do NOT proceed with this approach. Instead investigate alternatives documented in the "Alternative approaches" subsection below.

### Tests after implementation

Run these after modifying `session-start.sh`:

```bash
# Test: session-start.sh is valid bash (bash -n .claude/hooks/session-start.sh)
# Syntax validation -- catches unclosed quotes, missing keywords, etc.
bash -n /home/user/sitemgr/.claude/hooks/session-start.sh

# Test: session-start.sh still has set -euo pipefail at the top
# The strict error mode must remain for the existing tool installation commands.
head -3 /home/user/sitemgr/.claude/hooks/session-start.sh | grep -q 'set -euo pipefail'

# Test: plugin install block is wrapped in a subshell with set +e
# The subshell isolates plugin failures from the strict error handling.
grep -q '(^[[:space:]]*($$' /home/user/sitemgr/.claude/hooks/session-start.sh || \
grep -q 'set +e' /home/user/sitemgr/.claude/hooks/session-start.sh

# Test: subshell ends with || true
# Ensures a subshell failure does not kill the entire hook.
grep -q '|| true' /home/user/sitemgr/.claude/hooks/session-start.sh

# Test: guard check (claude plugin list | grep deep-plan) is present
# The guard prevents re-running 6 CLI commands when plugins are already installed.
grep -q 'claude plugin list' /home/user/sitemgr/.claude/hooks/session-start.sh
grep -q 'grep.*deep-plan' /home/user/sitemgr/.claude/hooks/session-start.sh

# Test: all three marketplace add commands are present
grep -q 'marketplace add piercelamb/deep-project' /home/user/sitemgr/.claude/hooks/session-start.sh
grep -q 'marketplace add piercelamb/deep-plan' /home/user/sitemgr/.claude/hooks/session-start.sh
grep -q 'marketplace add piercelamb/deep-implement' /home/user/sitemgr/.claude/hooks/session-start.sh

# Test: all three plugin install commands use --scope project
grep -q 'plugin install deep-project@piercelamb-deep-project --scope project' /home/user/sitemgr/.claude/hooks/session-start.sh
grep -q 'plugin install deep-plan@piercelamb-deep-plan --scope project' /home/user/sitemgr/.claude/hooks/session-start.sh
grep -q 'plugin install deep-implement@piercelamb-deep-implement --scope project' /home/user/sitemgr/.claude/hooks/session-start.sh
```

### Behavioral tests (manual, in web session)

These are performed manually after pushing the changes:

```
# Test: start new web session -- plugins available without manual prompting
# Test: session-start.sh completes without error (check hook output in session logs)
# Test: subsequent sessions skip install (guard check works -- "already installed" message appears)
```

## Implementation Details

### Pre-requisite check

Before writing any code, verify two things in the hook execution context:

1. **`claude` binary availability:** Run `which claude` inside a hook or simulated hook context. The `claude` binary must be on `PATH` for the plugin commands to work.

2. **No deadlock on re-entrant call:** The SessionStart hook is invoked by the `claude` process. Calling `claude plugin install` from within it could theoretically deadlock. Test with a minimal `claude plugin list` call from inside a hook to confirm it completes.

If either check fails, skip this section and see "Alternative approaches" below.

### What to add to session-start.sh

Add the following block to `/home/user/sitemgr/.claude/hooks/session-start.sh` **after** the existing tool installations (gh, supabase, vercel, playwright, npm install, supabase start) but **before** any final status output. This means appending it at the end of the current file.

The block must be wrapped in a subshell with relaxed error handling to isolate it from the script's `set -euo pipefail`:

```bash
# Plugin installation (ensures plugins are available in web sessions)
# Wrapped in subshell to isolate from set -euo pipefail
(
  set +e  # Disable exit-on-error for this block

  # Skip if plugins already installed
  if claude plugin list 2>/dev/null | grep -q "deep-plan"; then
    echo "Plugins already installed, skipping"
  else
    claude plugin marketplace add piercelamb/deep-project
    claude plugin marketplace add piercelamb/deep-plan
    claude plugin marketplace add piercelamb/deep-implement

    claude plugin install deep-project@piercelamb-deep-project --scope project
    claude plugin install deep-plan@piercelamb-deep-plan --scope project
    claude plugin install deep-implement@piercelamb-deep-implement --scope project
  fi
) || true  # Ensure subshell failure doesn't kill the hook
```

### Key design decisions

| Decision | Rationale |
|----------|-----------|
| Subshell with `set +e` | Isolates plugin install failures from the script's strict `set -euo pipefail` mode. A failed plugin install must not prevent tool bootstrapping from completing. |
| `\|\| true` after subshell | Ensures even a subshell crash (non-zero exit) does not terminate the hook. |
| Guard check on `deep-plan` | Checks one representative plugin. If `deep-plan` is installed, all three are assumed present (they are always installed together). Skips 6 CLI calls on subsequent sessions, reducing startup latency. |
| `2>/dev/null` on guard check | Suppresses stderr from `claude plugin list` in case the command itself has issues. |
| Placement at end of file | All tool dependencies (gh, npm, etc.) are already installed. The `claude` binary is the host process and always available. Plugin install is the last step before the session is ready. |

### Resulting file structure

After modification, `session-start.sh` should have this structure:

1. Shebang and `set -euo pipefail` (unchanged)
2. `CLAUDE_CODE_REMOTE` guard (unchanged)
3. gh CLI installation (unchanged)
4. GH_REPO detection (unchanged)
5. Supabase CLI installation (unchanged)
6. Vercel CLI installation (unchanged)
7. Playwright browser installation (unchanged)
8. npm install for web app (unchanged)
9. Supabase start (unchanged)
10. **NEW: Plugin installation subshell** (added by this section)

### Alternative approaches (if pre-requisites fail)

If the `claude` binary is not available in the hook context or calling it causes deadlock:

- **Direct file manipulation:** Write entries directly to `~/.claude/plugins/installed_plugins.json` and populate the plugin cache at `~/.claude/plugins/cache/`. This bypasses the CLI but requires understanding the internal file format.
- **Background process:** Spawn `claude plugin install` commands via `nohup` or `&` so they run asynchronously after the hook completes. Risk: plugins may not be ready when the session conversation starts.

These alternatives are not specified in detail because they are last-resort options. If pre-requisites fail, investigate the current state of the hook execution environment before choosing an approach.

## Verification Checklist

After implementing this section, confirm:

- [ ] `bash -n /home/user/sitemgr/.claude/hooks/session-start.sh` passes (valid syntax)
- [ ] `set -euo pipefail` is still present at the top of the file
- [ ] The plugin block is inside a subshell `( ... ) || true`
- [ ] The subshell uses `set +e` internally
- [ ] The guard check tests for `deep-plan` in `claude plugin list` output
- [ ] All three `marketplace add` commands reference `piercelamb/deep-project`, `piercelamb/deep-plan`, `piercelamb/deep-implement`
- [ ] All three `plugin install` commands use `--scope project`
- [ ] The plugin block appears after all existing tool installations
- [ ] A new web session shows plugins as available
- [ ] A second web session prints "Plugins already installed, skipping" and completes faster