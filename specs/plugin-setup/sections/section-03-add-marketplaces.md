# Section 3: Add Marketplaces via CLI

## Overview

This section registers three plugin marketplace sources using the `claude plugin marketplace add` CLI command. After Section 2 has removed the hand-edited `enabledPlugins` and `extraKnownMarketplaces` blocks, the file `/home/user/sitemgr/.claude/settings.json` contains only the `hooks` block. This section re-adds the marketplace entries using the CLI so the format matches what the Claude Code runtime expects.

## Dependencies

- **Section 2 (Remove Manual Config)** must be completed first. The `settings.json` file should contain only the `hooks` block at this point -- no `enabledPlugins`, no `extraKnownMarketplaces`.

## Marketplaces to Add

Three GitHub-based plugin repositories from the `piercelamb` org:

| Repository | Expected CLI marketplace name |
|---|---|
| `piercelamb/deep-project` | `piercelamb-deep-project` (verify from CLI output) |
| `piercelamb/deep-plan` | `piercelamb-deep-plan` (verify from CLI output) |
| `piercelamb/deep-implement` | `piercelamb-deep-implement` (verify from CLI output) |

The CLI-assigned marketplace names may differ from what was previously hand-edited. The actual names assigned by the CLI are what Section 4 will use for plugin installation. Capture them.

## Tests (Run After Each Command)

These verification checks run after each `claude plugin marketplace add` invocation. They are shell-based checks, not unit tests.

```bash
# Test: claude plugin marketplace add exits with code 0
claude plugin marketplace add piercelamb/deep-project
echo "Exit code: $?"
# Expected: 0

# Test: settings.json is still valid JSON after marketplace add
jq . /home/user/sitemgr/.claude/settings.json > /dev/null
echo "JSON valid: $?"
# Expected: 0

# Test: hooks.SessionStart block still exists in settings.json (not clobbered)
jq -e '.hooks.SessionStart' /home/user/sitemgr/.claude/settings.json > /dev/null
echo "Hooks present: $?"
# Expected: 0

# Test: marketplace entry for the added repo appears in settings.json
# (Check after adding piercelamb/deep-project — adjust repo name for each)
jq -e '.extraKnownMarketplaces | to_entries[] | select(.value.source.repo == "piercelamb/deep-project")' /home/user/sitemgr/.claude/settings.json > /dev/null
echo "Marketplace entry found: $?"
# Expected: 0

# Test: marketplace name assigned by CLI is captured for use in Section 4
# Extract the CLI-assigned key name for later use
jq -r '.extraKnownMarketplaces | to_entries[] | select(.value.source.repo == "piercelamb/deep-project") | .key' /home/user/sitemgr/.claude/settings.json
# Expected: something like "piercelamb-deep-project" (capture this value)
```

Repeat these checks for each of the three marketplace add commands, substituting the repo name.

## Implementation Steps

### Step 1: Add first marketplace

```bash
claude plugin marketplace add piercelamb/deep-project
```

After the command completes:
1. Check exit code is 0.
2. Run `jq -e '.hooks.SessionStart' /home/user/sitemgr/.claude/settings.json` to confirm hooks were not clobbered.
3. If hooks are missing, immediately abort and restore: `git checkout -- /home/user/sitemgr/.claude/settings.json`. Do not proceed.
4. Inspect `settings.json` to see what key name the CLI assigned for this marketplace. Record it.

### Step 2: Add second marketplace

```bash
claude plugin marketplace add piercelamb/deep-plan
```

Run the same verification checks as Step 1. Confirm hooks intact. Record the assigned marketplace name.

### Step 3: Add third marketplace

```bash
claude plugin marketplace add piercelamb/deep-implement
```

Run the same verification checks as Step 1. Confirm hooks intact. Record the assigned marketplace name.

### Step 4: Capture marketplace names for Section 4

After all three commands succeed, extract and record all marketplace names:

```bash
jq -r '.extraKnownMarketplaces | keys[]' /home/user/sitemgr/.claude/settings.json
```

These names are required by Section 4 to construct the `claude plugin install` commands. The plugin install identifier format is `plugin-name@marketplace-name`.

## Expected State After Completion

The file `/home/user/sitemgr/.claude/settings.json` should contain:

- The original `hooks` block, unchanged
- A new `extraKnownMarketplaces` block (or equivalent CLI-generated key) with entries for all three repos
- No `enabledPlugins` block yet (that comes from Section 4)

The exact JSON structure may differ from the hand-edited version. The CLI may use different key names, nesting, or ordering. This is expected and desired -- the goal is to have the CLI's own format, which the runtime is more likely to recognize.

## Error Handling

**If any marketplace add command fails:**
- Check network connectivity (GitHub must be reachable for marketplace registration).
- Verify the repository path is correct (`piercelamb/deep-project`, `piercelamb/deep-plan`, `piercelamb/deep-implement`).
- Retry the failed command -- transient network failures are common.

**If a command fails after retries:**
- Restore settings.json from git: `git checkout -- /home/user/sitemgr/.claude/settings.json`
- Investigate the failure before retrying the full sequence from Step 1.
- All three marketplace adds should be retried as a group after a restore, since partial state may cause issues.

**If hooks are clobbered by a marketplace add command:**
- This indicates the CLI rewrites the entire file rather than merging. Restore immediately with `git checkout -- /home/user/sitemgr/.claude/settings.json`.
- This would be a blocking issue. Document the CLI behavior and consider filing a bug or using a different approach (direct JSON editing with `jq` to add marketplace entries in the CLI's expected format).

## File Modified

- `/home/user/sitemgr/.claude/settings.json` -- marketplace entries added by CLI commands