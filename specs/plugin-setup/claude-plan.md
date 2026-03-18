# Plugin Setup — Implementation Plan

## Background

The sitemgr project uses three Claude Code plugins from the `piercelamb` GitHub org: `deep-project`, `deep-plan`, and `deep-implement`. These are currently configured by hand-editing `.claude/settings.json` with `extraKnownMarketplaces` and `enabledPlugins` blocks. While this is the documented team configuration pattern, it **fails to reliably install plugins in Claude Code web sessions** — skills don't appear and Claude reports them as unavailable.

Running the CLI equivalents (`claude plugin marketplace add` + `claude plugin install`) in-session fixes the problem for the rest of that session. The goal is to make plugins reliably available on every web session start without manual intervention.

## Strategy: Two-Phase Approach

**Phase 1 — CLI-managed settings.json:** Run `claude plugin marketplace add` and `claude plugin install --scope project` commands to produce a CLI-generated `.claude/settings.json`. This may produce a different JSON shape than hand-editing, and that difference might be what the web runtime needs to auto-install plugins.

**Phase 2 — SessionStart hook fallback (if needed):** If Phase 1's settings.json still doesn't auto-install on web session start, add the CLI install commands to the existing `session-start.sh` hook. This guarantees plugins are installed at the start of every web session. **Note:** This fallback only applies to web/remote sessions (the hook exits early when `CLAUDE_CODE_REMOTE` is not `true`). Local CLI sessions rely solely on Phase 1's settings.json.

The plan attempts Phase 1 first. Phase 2 is only needed if Phase 1 doesn't solve the web auto-install problem.

---

## Section 1: Backup and Audit Current State

### What to do

Before making any changes, capture the current state for rollback and comparison:

1. **Ensure you're on a feature branch** — git history is the backup. The current state of `.claude/settings.json` can be restored with `git checkout -- .claude/settings.json` at any point.
2. **Record which plugins are currently listed** by running `claude plugin list` (if available) to see what the runtime thinks is installed vs what's in settings.json
3. **Record the current `settings.json` structure** — note the three sections: `hooks`, `enabledPlugins`, `extraKnownMarketplaces`

### Why

The migration modifies a shared config file. Git history provides the rollback path — no need for manual copies to volatile locations like `/tmp`.

---

## Section 2: Remove Manual Plugin Configuration

### What to do

Edit `.claude/settings.json` to remove the hand-edited plugin blocks while preserving the hooks:

1. **Remove the `enabledPlugins` block entirely** — the CLI will recreate this
2. **Remove the `extraKnownMarketplaces` block entirely** — the CLI will recreate this
3. **Preserve the `hooks` block exactly as-is** — the SessionStart hook is critical for web session bootstrapping

After removal, `settings.json` should contain only:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"
      }]
    }]
  }
}
```

### Why

Starting clean ensures no conflict between hand-edited and CLI-managed config. The CLI may use different key names, ordering, or structure. Removing old config first avoids merging two potentially incompatible formats.

---

## Section 3: Add Marketplaces via CLI

### What to do

Run the marketplace add commands for all three plugin repos:

```bash
claude plugin marketplace add piercelamb/deep-project
claude plugin marketplace add piercelamb/deep-plan
claude plugin marketplace add piercelamb/deep-implement
```

**After each command:**
1. Verify it succeeded (check exit code)
2. **Immediately verify the `hooks` block is still present in `settings.json`** — if the CLI clobbered it, abort and restore from git (`git checkout -- .claude/settings.json`) before proceeding
3. Inspect `settings.json` to see what marketplace name the CLI assigned — this may differ from the hand-edited names

### Expected behavior

Each command registers a GitHub-based marketplace. The CLI should write marketplace entries to `.claude/settings.json` (since we're operating at project scope). The format may differ from the hand-edited `extraKnownMarketplaces` — that's expected and desired.

### Error handling

If a marketplace add fails:
- Check network connectivity (GitHub must be reachable)
- Check if the repo URL is valid (`piercelamb/deep-project` etc.)
- Try again — transient failures happen

**If any command fails after retries**, restore settings.json from git (`git checkout -- .claude/settings.json`) and investigate before retrying the full sequence.

---

## Section 4: Install Plugins via CLI

### What to do

**Important:** Derive plugin identifiers from the marketplace names the CLI assigned in Section 3, not from the old hand-edited config. Inspect `settings.json` after Section 3 to get the exact marketplace names, then use those in the install commands.

Expected format (verify against actual CLI output):

```bash
claude plugin install deep-project@piercelamb-deep-project --scope project
claude plugin install deep-plan@piercelamb-deep-plan --scope project
claude plugin install deep-implement@piercelamb-deep-implement --scope project
```

**After each command:**
1. Verify it succeeded (check exit code)
2. **Verify the `hooks` block is still intact in `settings.json`** — abort and restore from git if clobbered
3. Check `settings.json` to see what the CLI wrote for plugin entries

### Expected behavior

Each command downloads the plugin to `~/.claude/plugins/cache/`, registers it in `~/.claude/plugins/installed_plugins.json`, and writes the plugin entry to `.claude/settings.json` at project scope.

### Verification

Run `claude plugin list` to confirm all three plugins appear as installed at project scope.

### Error handling

**If any install command fails after retries**, restore settings.json from git (`git checkout -- .claude/settings.json`) and investigate before retrying the full sequence.

---

## Section 5: Validate settings.json

### What to do

1. **Diff the new `settings.json` against the git baseline** — understand what changed
2. **Confirm the `hooks` block is intact** — the SessionStart hook must still be present and reference `session-start.sh`
3. **Confirm all three plugins are present** — whatever format the CLI uses
4. **Confirm all three marketplaces are present** — whatever format the CLI uses

### Acceptance criteria

- `hooks.SessionStart` exists and references `session-start.sh`
- Three plugins are registered (format may differ from original)
- Three marketplaces are registered (format may differ from original)
- No other settings were lost or corrupted

---

## Section 6: Test on Web (Phase 1 Verification)

### What to do

1. **Commit the updated `settings.json`** to the working branch
2. **Push to remote** so the web interface picks up the change
3. **Start a new web session** and check if plugins are available
4. **Concrete acceptance test:** Instruct Claude to "run deep-plan" and verify it responds with the skill prompt rather than "skill not available" or similar error. Repeat for deep-project and deep-implement.

### Decision point

- **If plugins are available on web session start:** Phase 1 succeeded. Skip Section 7. Done.
- **If plugins are NOT available:** Proceed to Section 7 (hook fallback).

---

## Section 7: SessionStart Hook Fallback (Conditional)

**Only implement this section if Phase 1 verification (Section 6) fails.**

**Scope:** This fallback only applies to web/remote sessions. The existing `session-start.sh` exits early when `CLAUDE_CODE_REMOTE` is not `true`, so these commands will not run in local CLI sessions. Local sessions rely on Phase 1's settings.json.

### Pre-requisite check

Before adding CLI commands to the hook, verify that the `claude` binary is available in the hook's execution context:

1. Check if `which claude` succeeds inside the hook environment
2. Test whether `claude plugin install` can be called from within a SessionStart hook without deadlock or re-entrancy issues (the hook is invoked by the `claude` process itself)

**If `claude` is not available or deadlocks when called from the hook**, this fallback strategy won't work. Alternative approaches to investigate:
- Direct manipulation of `~/.claude/plugins/installed_plugins.json` and cache
- A wrapper script that runs `claude plugin install` in a background process

### What to do

Add plugin CLI commands to `.claude/hooks/session-start.sh`, after the existing tool bootstrapping section.

### Handling `set -euo pipefail`

The existing hook uses `set -euo pipefail` (strict error mode). Plugin install commands must not break the hook if they fail. **Wrap the plugin section in a subshell with relaxed error handling:**

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

### Placement in session-start.sh

Add after the existing tool installations (gh, supabase, vercel) but before any final status output. This ensures:
- The `claude` binary is available (it's the host process)
- Network-dependent tools are already installed
- Plugin installation doesn't block subsequent hook steps

### Why this works

The SessionStart hook runs at the beginning of every web session. By the time Claude's main conversation starts, the plugins will be installed and available. The guard check (`claude plugin list | grep deep-plan`) makes this fast on subsequent runs — if plugins are already installed, all 6 CLI commands are skipped.

---

## Section 8: Final Verification and Commit

### What to do

1. **Run `claude plugin list`** — confirm all three plugins installed at project scope
2. **Diff `settings.json`** against git baseline — confirm it looks correct
3. **If Section 7 was implemented**, verify `session-start.sh` has the new commands
4. **Commit all changes** with a descriptive message
5. **Push to remote**

### Files to commit

- `.claude/settings.json` (always)
- `.claude/hooks/session-start.sh` (only if Section 7 was needed)

---

## Decision Log

| Decision | Rationale |
|----------|-----------|
| Remove manual config before CLI install | Avoids merging two potentially incompatible formats |
| Try settings.json first, hook as fallback | User preference; settings.json is cleaner if it works |
| Separate marketplace per plugin | Follows plugin author README convention |
| Project scope for all installs | Config shared via git, consistent team experience |
| Subshell with `set +e` for hook commands | Isolates plugin failures from `set -euo pipefail` in the hook |
| Guard check before installing | Skips 6 CLI commands when plugins already installed, reducing latency |
| Derive plugin IDs from CLI output | Hand-edited IDs may not match CLI-assigned names |
| Git history as backup (not /tmp) | `.claude/settings.json` is tracked; `git checkout --` is the rollback path |
| Don't pin plugin versions | User specified "use latest for now" |
| Hook fallback is web-only | By design — local sessions use settings.json; the hook has a `CLAUDE_CODE_REMOTE` guard |

## Extensibility

To add a new plugin later:
```bash
claude plugin marketplace add owner/repo-name
claude plugin install plugin-id@marketplace-name --scope project
```

If using the hook fallback, also add corresponding lines to `session-start.sh` (inside the subshell block).

To remove a plugin:
```bash
claude plugin uninstall plugin-id@marketplace-name --scope project
claude plugin marketplace remove marketplace-name
```
