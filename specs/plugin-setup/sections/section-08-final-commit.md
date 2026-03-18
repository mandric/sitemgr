# Section 8: Final Verification and Commit

## Overview

This is the final section of the plugin setup workflow. All prior configuration work is complete: manual plugin config has been removed (section 02), marketplaces have been added via CLI (section 03), plugins have been installed via CLI (section 04), settings have been validated (section 05), web testing has been performed (section 06), and the hook fallback has been conditionally applied (section 07). This section performs a final round of verification, commits all changes, and pushes to the remote.

## Dependencies

- **section-07-hook-fallback**: Must be complete (either implemented or skipped based on section 06 results)
- All prior sections (01 through 07) must be complete before executing this section

## Files Involved

- `/home/user/sitemgr/.claude/settings.json` -- always committed (modified by sections 02-04)
- `/home/user/sitemgr/.claude/hooks/session-start.sh` -- committed only if section 07 was implemented

## Tests (Execute First)

These verification checks serve as the acceptance gate before committing. Run each one and confirm it passes before proceeding to the commit step.

```bash
# Test 1: claude plugin list shows all three plugins
# Run `claude plugin list` and verify the output contains deep-project, deep-plan,
# and deep-implement, all at project scope.
claude plugin list

# Test 2: git diff shows only expected file changes
# The diff against the baseline should only touch .claude/settings.json and
# optionally .claude/hooks/session-start.sh. No other files should be modified.
git diff --name-only HEAD

# Test 3: no sensitive data in the diff
# Inspect the full diff output for any API keys, tokens, passwords, or secrets.
# The plugin config contains only repo names and plugin identifiers -- no secrets.
git diff HEAD

# Test 4: if session-start.sh was modified, verify it is valid bash
# Only applicable if section 07 was implemented.
bash -n /home/user/sitemgr/.claude/hooks/session-start.sh

# Test 5: settings.json is valid JSON
cat /home/user/sitemgr/.claude/settings.json | jq . > /dev/null
```

All five checks must pass. If any fail, do not commit -- go back and fix the issue in the relevant section first.

## Implementation Steps

### Step 1: Run final plugin verification

Run `claude plugin list` and confirm all three plugins appear as installed at project scope:

- `deep-project`
- `deep-plan`
- `deep-implement`

If any plugin is missing, return to section 04 and re-run the install command for the missing plugin before continuing.

### Step 2: Review the diff

Run `git diff HEAD` to see the full set of changes. Confirm:

1. **`.claude/settings.json`** contains the CLI-managed marketplace and plugin entries, plus the preserved `hooks` block with the `SessionStart` reference to `session-start.sh`.
2. **`.claude/hooks/session-start.sh`** (only if section 07 was needed) contains the subshell-wrapped plugin install block with `set +e`, the guard check, and `|| true`.
3. **No other files** were inadvertently modified.
4. **No secrets or tokens** appear anywhere in the diff. The plugin configuration contains only GitHub org/repo names and plugin identifiers.

### Step 3: Stage the files

Stage only the files that were intentionally modified:

```bash
git add /home/user/sitemgr/.claude/settings.json
```

If section 07 was implemented (hook fallback was needed), also stage the hook script:

```bash
git add /home/user/sitemgr/.claude/hooks/session-start.sh
```

Do not use `git add .` or `git add -A` -- stage only the known files to avoid committing unrelated changes.

### Step 4: Commit with a descriptive message

Use a commit message that explains what was done and why:

```bash
git commit -m "chore: migrate plugin config from hand-edited to CLI-managed

Replaced hand-edited enabledPlugins and extraKnownMarketplaces blocks in
.claude/settings.json with CLI-generated equivalents via:
  claude plugin marketplace add
  claude plugin install --scope project

This produces a settings.json format that the Claude Code web runtime
recognizes for automatic plugin loading on session start.

Plugins: deep-project, deep-plan, deep-implement (all from piercelamb org)"
```

If section 07 was also implemented, amend the message to note the hook fallback:

```bash
git commit -m "chore: migrate plugin config to CLI-managed + add hook fallback

Replaced hand-edited plugin config in .claude/settings.json with
CLI-generated equivalents. Added plugin install commands to
session-start.sh as a fallback for web sessions where settings.json
alone does not trigger auto-install.

Hook fallback is web-only (guarded by CLAUDE_CODE_REMOTE check).
Plugin install block is wrapped in a subshell with set +e to isolate
failures from the hook's set -euo pipefail.

Plugins: deep-project, deep-plan, deep-implement (all from piercelamb org)"
```

### Step 5: Push to remote

```bash
git push
```

If the current branch does not have an upstream tracking branch set, use:

```bash
git push --set-upstream origin "$(git branch --show-current)"
```

### Step 6: Confirm clean git state

After the push, verify there are no uncommitted changes:

```bash
git status
```

The working tree should be clean. If any tracked files show as modified, investigate before considering this section complete.

## Rollback

If something went wrong and the commit needs to be undone:

```bash
# Undo the commit but keep changes staged
git reset --soft HEAD~1

# Or fully restore to pre-migration state
git checkout -- /home/user/sitemgr/.claude/settings.json
git checkout -- /home/user/sitemgr/.claude/hooks/session-start.sh
```

Git history is the backup mechanism for this entire workflow. No external backups are needed.

## Acceptance Criteria

This section is complete when all of the following are true:

- `claude plugin list` shows all three plugins installed at project scope
- `git diff` against the previous commit shows only `.claude/settings.json` (and optionally `.claude/hooks/session-start.sh`)
- No sensitive data appears in the committed diff
- The commit has been pushed to the remote
- `git status` shows a clean working tree