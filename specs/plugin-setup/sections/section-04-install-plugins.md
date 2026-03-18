I have all the context needed. Here is the section content.

# Section 4: Install Plugins via CLI

## Overview

This section installs the three Claude Code plugins (`deep-project`, `deep-plan`, `deep-implement`) using the CLI at project scope. It uses the marketplace names that the CLI assigned during Section 3 (Add Marketplaces via CLI). After installation, each plugin entry appears in `.claude/settings.json` and the plugin cache is populated.

## Dependencies

- **Section 3 (Add Marketplaces via CLI) must be completed first.** The marketplace names assigned by the CLI in Section 3 are required to construct the install commands. Do not use the hand-edited names from the original `settings.json` -- inspect the file after Section 3 to get the exact names the CLI wrote.

## File Modified

- `/home/user/sitemgr/.claude/settings.json` -- the CLI writes plugin entries here when `--scope project` is used

## Tests (Verify After Each Command)

These verification checks should be run after each individual `claude plugin install` command.

```bash
# Test: claude plugin install exits with code 0
claude plugin install <plugin-id>@<marketplace-name> --scope project
echo "Exit code: $?"

# Test: settings.json is still valid JSON after install
jq . /home/user/sitemgr/.claude/settings.json > /dev/null

# Test: hooks.SessionStart block still exists in settings.json (not clobbered)
jq -e '.hooks.SessionStart' /home/user/sitemgr/.claude/settings.json > /dev/null

# Test: plugin entry appears in settings.json enabledPlugins (or equivalent CLI format)
jq -e '.enabledPlugins["<plugin-id>@<marketplace-name>"]' /home/user/sitemgr/.claude/settings.json > /dev/null
```

### Tests After All Three Installs

```bash
# Test: claude plugin list shows all three plugins installed at project scope
claude plugin list | grep -q "deep-project"
claude plugin list | grep -q "deep-plan"
claude plugin list | grep -q "deep-implement"

# Test: settings.json contains entries for all three marketplaces (from Section 3)
jq -e '.extraKnownMarketplaces | length >= 3' /home/user/sitemgr/.claude/settings.json > /dev/null

# Test: settings.json contains entries for all three plugins
jq -e '.enabledPlugins | length >= 3' /home/user/sitemgr/.claude/settings.json > /dev/null
```

## Implementation

### Step 1: Determine plugin identifiers from Section 3 output

Before running install commands, inspect `.claude/settings.json` to find the marketplace names the CLI assigned in Section 3. Look at the keys under `extraKnownMarketplaces` (or whatever key name the CLI used).

```bash
jq 'keys' /home/user/sitemgr/.claude/settings.json
jq '.extraKnownMarketplaces | keys' /home/user/sitemgr/.claude/settings.json
```

The plugin install command format is `<plugin-name>@<marketplace-name>`. The expected marketplace names (based on the piercelamb repo naming convention) are:

- `piercelamb-deep-project`
- `piercelamb-deep-plan`
- `piercelamb-deep-implement`

The plugin names correspond to the repo names: `deep-project`, `deep-plan`, `deep-implement`. Combine them to form the full plugin identifier: `deep-project@piercelamb-deep-project`, etc.

**If the CLI assigned different names in Section 3, use those instead.**

### Step 2: Install each plugin

Run each install command one at a time. After each command, run the per-command verification tests above before proceeding to the next.

```bash
claude plugin install deep-project@piercelamb-deep-project --scope project
```

Verify exit code is 0, `settings.json` is valid JSON, and the `hooks.SessionStart` block is intact. Then proceed:

```bash
claude plugin install deep-plan@piercelamb-deep-plan --scope project
```

Same verification. Then:

```bash
claude plugin install deep-implement@piercelamb-deep-implement --scope project
```

Same verification.

### Step 3: Run post-install verification

After all three installs succeed, run the "after all installs" tests above. Confirm `claude plugin list` shows all three plugins.

## Expected Behavior

Each `claude plugin install --scope project` command does the following:

1. Downloads the plugin to `~/.claude/plugins/cache/`
2. Registers it in `~/.claude/plugins/installed_plugins.json`
3. Writes the plugin entry to `.claude/settings.json` (project-scoped config)

The `--scope project` flag is critical -- it ensures the plugin config is written to the project's `.claude/settings.json` (checked into git, shared with the team) rather than the user's global config.

## Error Handling

If any install command fails:

1. Check the error message -- common issues include network failures or invalid plugin identifiers
2. Verify the marketplace was correctly added in Section 3 (the marketplace must exist before you can install from it)
3. Retry the failed command -- transient network failures are common
4. **If the command fails after retries**, restore `settings.json` from git and restart from Section 3:
   ```bash
   git checkout -- /home/user/sitemgr/.claude/settings.json
   ```

If the CLI clobbers the `hooks` block at any point, immediately restore from git before proceeding. The `hooks.SessionStart` block is critical infrastructure and must be preserved.

## Rollback

At any point, the full rollback path is:

```bash
git checkout -- /home/user/sitemgr/.claude/settings.json
```

This restores the file to the last committed state. If Section 3 was already committed, you may need `git checkout HEAD~1 -- .claude/settings.json` to go back further.