# Section 6: Test on Web (Phase 1 Verification)

## Overview

This section covers committing and pushing the CLI-managed `settings.json` (produced by sections 2-5) to the remote, then verifying in a new web session that all three plugins (deep-project, deep-plan, deep-implement) are available without manual intervention. The outcome of this section determines whether section 7 (hook fallback) is needed.

## Dependencies

- **Section 05 (Validate settings.json)** must be complete. At this point, `.claude/settings.json` should contain CLI-generated marketplace and plugin entries plus the preserved `hooks` block. The file should have been validated by diffing against the git baseline.

## Files Modified

- No files are created or modified in this section. This section performs a git commit, push, and manual verification in a web session.
- `.claude/settings.json` is committed (not modified -- it was modified in sections 2-4).

## Tests

All tests for this section are **manual acceptance tests** performed in a Claude Code web session. There is no automated test suite for this section because the verification requires interacting with the web runtime.

### Pre-condition: commit and push

Before running acceptance tests, the updated settings must be available on the remote:

```bash
# Test: settings.json has uncommitted changes (from sections 2-5)
git -C /home/user/sitemgr diff --name-only | grep -q ".claude/settings.json"

# Test: commit succeeds
git -C /home/user/sitemgr add .claude/settings.json
git -C /home/user/sitemgr commit -m "chore: migrate plugin config to CLI-managed format"

# Test: push succeeds (branch must be pushed to remote)
git -C /home/user/sitemgr push
```

### Acceptance tests (manual, in web session)

These tests must be performed in a **new** web session started after the push. An existing session will not pick up the updated settings.

```
# Test 1: Start a new web session after pushing updated settings.json
#   - Navigate to the Claude Code web interface
#   - Ensure the session is on the correct branch that was just pushed
#   - The session must be freshly started (not resumed)

# Test 2: Instruct Claude to "run deep-plan"
#   - Expected: Claude responds with the deep-plan skill prompt (asks for planning input)
#   - Failure: Claude responds with "skill not available", "I don't have access to that plugin",
#     or similar error indicating the plugin is not installed

# Test 3: Instruct Claude to "run deep-project"
#   - Expected: Claude responds with the deep-project skill prompt
#   - Failure: Same as Test 2

# Test 4: Instruct Claude to "run deep-implement"
#   - Expected: Claude responds with the deep-implement skill prompt
#   - Failure: Same as Test 2
```

### How to interpret results

Each test involves asking Claude to invoke a plugin skill by name. A successful response means the web runtime recognized the plugin from `settings.json` and loaded it automatically. The exact response content will vary (each plugin has its own skill prompt), but the key indicator is that Claude **does not** report the skill as unavailable.

## Implementation Steps

### Step 1: Commit the updated settings.json

Run a git commit for the file that was modified by sections 2 through 5. The commit should be on the current working branch (which should be a feature branch, confirmed in section 1).

The commit message should clearly indicate this is a plugin configuration migration:

```
chore: migrate plugin config to CLI-managed format
```

If other files were inadvertently modified, ensure only `.claude/settings.json` is staged. Do not commit `session-start.sh` at this point -- that file is only modified in section 7 if this section's tests fail.

### Step 2: Push to remote

Push the branch to the remote so the web interface can access the updated settings. If this is a new branch that has not been pushed before, use `git push -u origin <branch-name>`.

### Step 3: Start a new web session

Open the Claude Code web interface and start a **fresh** session on the branch that was just pushed. It is critical that this is a new session -- resuming an existing session will not reload `settings.json`.

### Step 4: Test each plugin

In the new web session, issue the following prompts one at a time:

1. "run deep-plan"
2. "run deep-project"
3. "run deep-implement"

For each prompt, observe whether Claude responds with the plugin's skill prompt or reports the skill as unavailable.

### Step 5: Record the outcome

This is the **decision point** for the entire two-phase approach:

- **All three plugins available:** Phase 1 succeeded. The CLI-managed `settings.json` format is sufficient for web session auto-install. **Skip section 7 entirely** and proceed to section 8 (final commit).
- **Any plugin unavailable:** Phase 1 failed. The web runtime does not auto-install plugins from `settings.json` alone. **Proceed to section 7** to implement the SessionStart hook fallback.
- **Partial success** (some plugins work, others do not): Investigate the settings.json entries for the failing plugins. They may have different marketplace names or formats. Fix and re-test before deciding on section 7.

## Rollback

If the commit or push fails, or if you need to revert for any reason:

```bash
# Undo the commit but keep changes staged
git -C /home/user/sitemgr reset --soft HEAD~1

# Or fully revert to the pre-migration state
git -C /home/user/sitemgr checkout -- .claude/settings.json
```

## Context: Why This Test Matters

The entire motivation for this plan is that hand-edited `settings.json` does not reliably activate plugins in Claude Code web sessions. This section is the critical experiment: does the CLI-generated format solve the problem? If it does, the fix is a one-time config migration. If it does not, the hook fallback (section 7) provides a guaranteed solution at the cost of added startup latency on every web session.