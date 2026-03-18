I have all the context needed. Here is the section content:

# Section 2: Remove Manual Plugin Configuration

## Overview

This section removes the hand-edited `enabledPlugins` and `extraKnownMarketplaces` blocks from `.claude/settings.json`, leaving only the `hooks` block. This creates a clean slate so that Section 3 and Section 4 can re-add plugins via the CLI, which may produce a different JSON structure that the web runtime needs to auto-install plugins.

**Depends on:** Section 01 (backup/audit must be complete so git history provides a rollback path)

**Blocks:** Section 03 (marketplace add commands must run against a clean settings.json)

## File to Modify

`/home/user/sitemgr/.claude/settings.json`

## Tests (Run After Implementation)

These tests verify the removal was done correctly. Run each one after editing the file.

```bash
# Test: after removal, settings.json is valid JSON
jq . /home/user/sitemgr/.claude/settings.json > /dev/null 2>&1 && echo "PASS: valid JSON" || echo "FAIL: invalid JSON"

# Test: after removal, settings.json contains hooks.SessionStart referencing session-start.sh
jq -e '.hooks.SessionStart[0].hooks[0].command | test("session-start.sh")' /home/user/sitemgr/.claude/settings.json > /dev/null 2>&1 \
  && echo "PASS: hooks.SessionStart references session-start.sh" \
  || echo "FAIL: hooks.SessionStart missing or wrong"

# Test: after removal, settings.json does NOT contain enabledPlugins
jq -e '.enabledPlugins' /home/user/sitemgr/.claude/settings.json > /dev/null 2>&1 \
  && echo "FAIL: enabledPlugins still present" \
  || echo "PASS: enabledPlugins removed"

# Test: after removal, settings.json does NOT contain extraKnownMarketplaces
jq -e '.extraKnownMarketplaces' /home/user/sitemgr/.claude/settings.json > /dev/null 2>&1 \
  && echo "FAIL: extraKnownMarketplaces still present" \
  || echo "PASS: extraKnownMarketplaces removed"
```

## Current State (Before This Section)

The file `/home/user/sitemgr/.claude/settings.json` currently contains three top-level keys:

- `hooks` -- the SessionStart hook configuration that runs `session-start.sh`. This must be preserved exactly.
- `enabledPlugins` -- hand-edited plugin enable flags. Must be removed.
- `extraKnownMarketplaces` -- hand-edited marketplace definitions. Must be removed.

The current structure looks like:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"
      }]
    }]
  },
  "enabledPlugins": {
    "deep-project@piercelamb-deep-project": true,
    "deep-plan@piercelamb-deep-plan": true,
    "deep-implement@piercelamb-deep-implement": true
  },
  "extraKnownMarketplaces": {
    "piercelamb-deep-project": { ... },
    "piercelamb-deep-plan": { ... },
    "piercelamb-deep-implement": { ... }
  }
}
```

## Implementation Steps

### Step 1: Remove the two plugin blocks

Edit `/home/user/sitemgr/.claude/settings.json` to remove the `enabledPlugins` and `extraKnownMarketplaces` keys entirely. The easiest approach is to use `jq` to produce a clean file:

```bash
jq '{ hooks: .hooks }' /home/user/sitemgr/.claude/settings.json > /tmp/settings-clean.json \
  && mv /tmp/settings-clean.json /home/user/sitemgr/.claude/settings.json
```

Alternatively, manually edit the file to contain only:

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

### Step 2: Verify the result

Run the four test commands listed above. All must pass before proceeding to Section 03.

### Step 3: Confirm rollback path

If anything goes wrong, the original file can be restored from git:

```bash
git checkout -- /home/user/sitemgr/.claude/settings.json
```

Do not commit this change yet. The commit happens in Section 06 (if Phase 1 works) or Section 08 (final commit). Keeping the change uncommitted preserves the easy `git checkout --` rollback path during Sections 03 and 04.

## Why Remove Before Re-Adding

Starting from a clean `hooks`-only settings file avoids conflicts between hand-edited config and CLI-managed config. The CLI's `plugin marketplace add` and `plugin install` commands may:

- Use different key names than `enabledPlugins` / `extraKnownMarketplaces`
- Use different value structures or ordering
- Add additional metadata that the web runtime needs for auto-installation

By removing the old blocks first, the CLI writes fresh entries without having to merge with potentially incompatible hand-edited values. This is the core hypothesis of the migration: the CLI-generated format may be what the web runtime requires.