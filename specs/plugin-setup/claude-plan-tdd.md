# Plugin Setup — TDD Plan

## Testing Context

This is a configuration/operations task, not a feature implementation. There is no application code to unit test. Testing focuses on **verifying configuration state** and **behavioral acceptance tests** in the web environment.

**Testing tools:** Shell commands (`claude plugin list`, `jq`, `diff`), manual verification in web sessions.

---

## Section 1: Backup and Audit Current State

### Tests before implementation

```bash
# Test: settings.json exists and is valid JSON
# Test: settings.json contains hooks.SessionStart block
# Test: settings.json contains enabledPlugins block (pre-migration state)
# Test: settings.json contains extraKnownMarketplaces block (pre-migration state)
# Test: current branch has a clean git state for .claude/settings.json (or changes are committed)
```

---

## Section 2: Remove Manual Plugin Configuration

### Tests before implementation

```bash
# Test: after removal, settings.json is valid JSON
# Test: after removal, settings.json contains hooks.SessionStart referencing session-start.sh
# Test: after removal, settings.json does NOT contain enabledPlugins
# Test: after removal, settings.json does NOT contain extraKnownMarketplaces
```

---

## Section 3: Add Marketplaces via CLI

### Tests after each command

```bash
# Test: claude plugin marketplace add exits with code 0
# Test: settings.json is still valid JSON after marketplace add
# Test: hooks.SessionStart block still exists in settings.json (not clobbered)
# Test: marketplace entry for the added repo appears in settings.json
# Test: marketplace name assigned by CLI is captured for use in Section 4
```

---

## Section 4: Install Plugins via CLI

### Tests after each command

```bash
# Test: claude plugin install exits with code 0
# Test: settings.json is still valid JSON after install
# Test: hooks.SessionStart block still exists in settings.json (not clobbered)
# Test: plugin entry appears in settings.json enabledPlugins (or equivalent CLI format)
```

### Tests after all installs

```bash
# Test: claude plugin list shows all three plugins installed at project scope
# Test: settings.json contains entries for all three marketplaces
# Test: settings.json contains entries for all three plugins
```

---

## Section 5: Validate settings.json

### Tests

```bash
# Test: diff between old and new settings.json shows only plugin/marketplace changes
# Test: hooks block is byte-identical to original (or structurally equivalent)
# Test: no unexpected keys were added or removed
```

---

## Section 6: Test on Web (Phase 1 Verification)

### Acceptance tests (manual, in web session)

```
# Test: start new web session after pushing updated settings.json
# Test: instruct Claude to "run deep-plan" — should respond with skill prompt, NOT "skill not available"
# Test: instruct Claude to "run deep-project" — same check
# Test: instruct Claude to "run deep-implement" — same check
```

---

## Section 7: SessionStart Hook Fallback (Conditional)

### Pre-requisite tests

```bash
# Test: `which claude` succeeds in the hook's execution context
# Test: `claude plugin install` can be called from within a SessionStart hook without deadlock
```

### Tests after implementation

```bash
# Test: session-start.sh is valid bash (bash -n .claude/hooks/session-start.sh)
# Test: session-start.sh still has set -euo pipefail at the top
# Test: plugin install block is wrapped in a subshell with set +e
# Test: subshell ends with || true
# Test: guard check (claude plugin list | grep deep-plan) is present
# Test: all three marketplace add commands are present
# Test: all three plugin install commands use --scope project
```

### Behavioral tests (manual, in web session)

```
# Test: start new web session — plugins available without manual prompting
# Test: session-start.sh completes without error (check hook output)
# Test: subsequent sessions skip install (guard check works — "already installed" message)
```

---

## Section 8: Final Verification and Commit

### Tests

```bash
# Test: claude plugin list shows all three plugins
# Test: git diff shows only expected file changes (.claude/settings.json, optionally session-start.sh)
# Test: no sensitive data in the diff (no API keys, tokens, etc.)
# Test: commit succeeds
# Test: push succeeds
```
