# Section 1: Backup and Audit Current State

## Overview

This section ensures that the current project state is properly recorded before making any changes to the plugin configuration. The rollback strategy relies on git history -- there is no need to copy files to temporary locations. By the end of this section you will have verified the starting conditions and confirmed a safe rollback path exists.

## Dependencies

- None. This is the first section in the sequence.

## What This Section Blocks

- **section-02-remove-manual-config** depends on this section completing successfully.

## Files Involved

- `/home/user/sitemgr/.claude/settings.json` -- the shared project configuration file (read-only in this section)
- `/home/user/sitemgr/.claude/hooks/session-start.sh` -- the SessionStart hook script (read-only in this section)

## Current State of settings.json

The file currently has three top-level keys:

- **`hooks`** -- contains the `SessionStart` hook that runs `session-start.sh`. This block must be preserved throughout the entire migration.
- **`enabledPlugins`** -- hand-edited block listing three plugins: `deep-project@piercelamb-deep-project`, `deep-plan@piercelamb-deep-plan`, `deep-implement@piercelamb-deep-implement`. This will be removed in section-02 and recreated by the CLI.
- **`extraKnownMarketplaces`** -- hand-edited block listing three marketplace sources for the `piercelamb` GitHub repos. This will be removed in section-02 and recreated by the CLI.

## Current State of session-start.sh

The hook script uses `set -euo pipefail` and exits early when `CLAUDE_CODE_REMOTE` is not `true` (i.e., it only runs in web/remote sessions). It installs `gh`, `supabase`, `vercel`, and Playwright, then runs `npm install` and starts the local Supabase instance. No plugin commands exist in this file yet.

## Tests (Run Before and During This Section)

These tests verify the pre-conditions needed for the migration to proceed safely. Run them as shell commands from the project root (`/home/user/sitemgr`).

```bash
# Test 1: settings.json exists and is valid JSON
jq . .claude/settings.json > /dev/null 2>&1 && echo "PASS: valid JSON" || echo "FAIL: invalid JSON"

# Test 2: settings.json contains hooks.SessionStart block
jq -e '.hooks.SessionStart' .claude/settings.json > /dev/null 2>&1 && echo "PASS: hooks.SessionStart exists" || echo "FAIL: hooks.SessionStart missing"

# Test 3: settings.json contains enabledPlugins block (pre-migration state)
jq -e '.enabledPlugins' .claude/settings.json > /dev/null 2>&1 && echo "PASS: enabledPlugins exists" || echo "FAIL: enabledPlugins missing"

# Test 4: settings.json contains extraKnownMarketplaces block (pre-migration state)
jq -e '.extraKnownMarketplaces' .claude/settings.json > /dev/null 2>&1 && echo "PASS: extraKnownMarketplaces exists" || echo "FAIL: extraKnownMarketplaces missing"

# Test 5: current branch has a clean git state for .claude/settings.json (no uncommitted changes)
git -C /home/user/sitemgr diff --quiet -- .claude/settings.json && echo "PASS: settings.json is clean" || echo "WARN: settings.json has uncommitted changes -- commit or stash before proceeding"
```

All five tests must pass (Test 5 may warn -- uncommitted changes should be committed before proceeding to section-02).

## Implementation Steps

### Step 1: Verify you are on a feature branch

Run `git branch --show-current` from `/home/user/sitemgr`. Confirm you are on a branch other than `main`. If you are on `main`, create and switch to a feature branch first (e.g., `git checkout -b fix/plugin-cli-setup`). Git history on this branch is the rollback mechanism -- at any point during the migration, you can restore the original settings with:

```bash
git checkout -- .claude/settings.json
```

### Step 2: Record the current plugin list

Run `claude plugin list` to see what the Claude runtime currently reports as installed. Capture the output for comparison after the migration. If `claude plugin list` is not available or errors, that is acceptable -- proceed using `settings.json` as the source of truth.

### Step 3: Record the current settings.json structure

Confirm the three top-level keys are present by running:

```bash
jq 'keys' /home/user/sitemgr/.claude/settings.json
```

Expected output: `["enabledPlugins", "extraKnownMarketplaces", "hooks"]`

Also confirm the hooks block references the correct script:

```bash
jq '.hooks.SessionStart[0].hooks[0].command' /home/user/sitemgr/.claude/settings.json
```

Expected output: `"$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"`

### Step 4: Confirm session-start.sh is valid bash

```bash
bash -n /home/user/sitemgr/.claude/hooks/session-start.sh && echo "PASS: valid bash" || echo "FAIL: syntax error"
```

## Completion Criteria

All of the following must be true before proceeding to section-02:

1. You are on a feature branch (not `main`)
2. `settings.json` is valid JSON with all three top-level keys (`hooks`, `enabledPlugins`, `extraKnownMarketplaces`)
3. The `hooks.SessionStart` block references `session-start.sh`
4. `session-start.sh` passes `bash -n` syntax check
5. There are no uncommitted changes to `settings.json` (or they have been committed)
6. You have recorded the output of `claude plugin list` (or noted it is unavailable)