I now have all the context needed. Here is the section content.

# Section 5: Validate settings.json

## Overview

After Sections 3 and 4 have added marketplaces and installed plugins via the CLI, this section performs a comprehensive validation of `.claude/settings.json` to confirm the migration succeeded. The goal is to verify that the CLI-generated configuration is complete and that nothing was lost or corrupted during the process.

**Dependencies:** Section 4 (Install Plugins via CLI) must be complete before starting this section. All three marketplaces must have been added and all three plugins must have been installed.

**File under validation:** `/home/user/sitemgr/.claude/settings.json`

---

## Tests (Run These First)

These validation checks serve as the acceptance criteria. Run each one and confirm it passes before considering this section complete.

```bash
# Test 1: Diff between old and new settings.json shows only plugin/marketplace changes
# Compare the current settings.json against the git baseline (before any changes were made).
# The diff should show changes to plugin and marketplace entries only.
git diff HEAD -- .claude/settings.json

# Test 2: settings.json is valid JSON
# A malformed file would break Claude Code entirely.
cat .claude/settings.json | jq . > /dev/null && echo "PASS: valid JSON" || echo "FAIL: invalid JSON"

# Test 3: hooks.SessionStart block still references session-start.sh
# This is the most critical check — if the hooks block was clobbered, web session
# bootstrapping (tool installation, environment setup) is broken.
jq -e '.hooks.SessionStart[0].hooks[0].command' .claude/settings.json | grep -q 'session-start.sh' \
  && echo "PASS: SessionStart hook intact" \
  || echo "FAIL: SessionStart hook missing or corrupted"

# Test 4: All three plugins are present in the configuration
# The CLI may use a different key name or structure than the hand-edited "enabledPlugins".
# Check for each plugin's presence regardless of the exact format.
for plugin in deep-project deep-plan deep-implement; do
  jq -e '.. | strings | select(test("'"$plugin"'"))' .claude/settings.json > /dev/null 2>&1 \
    && echo "PASS: $plugin found" \
    || echo "FAIL: $plugin not found"
done

# Test 5: All three marketplaces are present in the configuration
# Again, the CLI may use different key names than "extraKnownMarketplaces".
for repo in "piercelamb/deep-project" "piercelamb/deep-plan" "piercelamb/deep-implement"; do
  jq -e '.. | strings | select(test("'"$repo"'"))' .claude/settings.json > /dev/null 2>&1 \
    && echo "PASS: marketplace for $repo found" \
    || echo "FAIL: marketplace for $repo not found"
done

# Test 6: No unexpected top-level keys were added or removed
# Expected keys after CLI migration: hooks, plus whatever the CLI uses for plugins
# and marketplaces. There should be no surprise keys (e.g., no stray "env" or "model" keys
# that were not there before).
jq 'keys' .claude/settings.json

# Test 7: claude plugin list confirms all three plugins are installed at project scope
claude plugin list 2>/dev/null | grep -q 'deep-project' && echo "PASS: deep-project listed" || echo "FAIL: deep-project not listed"
claude plugin list 2>/dev/null | grep -q 'deep-plan' && echo "PASS: deep-plan listed" || echo "FAIL: deep-plan not listed"
claude plugin list 2>/dev/null | grep -q 'deep-implement' && echo "PASS: deep-implement listed" || echo "FAIL: deep-implement not listed"
```

---

## Implementation Steps

### Step 1: Generate the diff against git baseline

Run `git diff HEAD -- .claude/settings.json` to see exactly what changed. Review the diff carefully:

- **Expected changes:** The `enabledPlugins` and `extraKnownMarketplaces` blocks should look different from the hand-edited originals. The CLI may have renamed keys, reordered them, or used an entirely different structure.
- **Unexpected changes:** If the `hooks` block is missing, modified, or reformatted in a way that changes its meaning, this is a failure. Restore from git immediately with `git checkout -- .claude/settings.json` and re-run Sections 2-4.
- **Whitespace/formatting changes:** The CLI may reformat the JSON (different indentation, key ordering). This is acceptable as long as the content is semantically equivalent.

### Step 2: Confirm the hooks block is intact

The `hooks.SessionStart` entry is the most critical piece of configuration in this file. It must still reference `$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh`. Use the `jq` check from Test 3 above. The hooks block should be structurally equivalent to:

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

If the CLI reformatted this (e.g., different whitespace, key order), that is fine as long as the structure and values are identical.

### Step 3: Confirm all three plugins are registered

Verify that the settings file contains entries for all three plugins: `deep-project`, `deep-plan`, and `deep-implement`. The CLI may have written these in a different format than the original hand-edited `enabledPlugins` block. What matters is that all three are present, not that they match the old format exactly.

The original hand-edited format used:
```json
"enabledPlugins": {
  "deep-project@piercelamb-deep-project": true,
  ...
}
```

The CLI may use a different key name, a list instead of an object, or include additional metadata. All of these are acceptable.

### Step 4: Confirm all three marketplaces are registered

Similarly, verify that marketplace entries exist for all three repos: `piercelamb/deep-project`, `piercelamb/deep-plan`, and `piercelamb/deep-implement`. The CLI may have written these under a different top-level key than `extraKnownMarketplaces`.

### Step 5: Run `claude plugin list` for runtime verification

The `jq` checks above validate the file on disk, but `claude plugin list` validates what the runtime actually sees. All three plugins must appear in the output as installed at project scope. If `claude plugin list` shows the plugins but the file checks fail (or vice versa), investigate the discrepancy before proceeding.

### Step 6: Check for no unexpected keys or data loss

Run `jq 'keys' .claude/settings.json` and compare the top-level keys against what you expect. The file should contain:
- The `hooks` key (preserved from the original)
- Whatever key(s) the CLI uses for plugins and marketplaces
- Nothing else that was not there before or that suggests corruption

---

## Acceptance Criteria

All of the following must be true before proceeding to Section 6:

1. `settings.json` is valid JSON
2. `hooks.SessionStart` exists and references `session-start.sh`
3. Three plugins are registered (in whatever format the CLI uses)
4. Three marketplaces are registered (in whatever format the CLI uses)
5. `claude plugin list` shows all three plugins as installed at project scope
6. No other settings were lost or corrupted (diff shows only expected changes)

---

## Failure Recovery

If any validation check fails:

1. **Do not proceed to Section 6.** A broken settings.json will cause problems in web sessions.
2. **Restore from git:** `git checkout -- .claude/settings.json`
3. **Investigate:** Determine which step (Section 2, 3, or 4) introduced the problem.
4. **Re-run from Section 2:** Start the migration sequence over from the clean-slate step.