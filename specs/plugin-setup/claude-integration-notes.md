# Integration Notes — Opus Review

## Suggestions Integrated

### 1. `set -euo pipefail` conflict (High priority) — INTEGRATED
The reviewer correctly identified that the hook uses strict error handling. The plan will be updated to wrap plugin commands in a subshell with `set +e` to isolate failures.

### 2. `claude` CLI re-entrancy in hook (High priority) — INTEGRATED
Valid concern. The plan will add a `which claude` check and note the re-entrancy risk. If `claude` can't be called from within its own hook, this changes the fallback strategy entirely.

### 3. CLI may clobber hooks in settings.json (High priority) — INTEGRATED
Critical safety issue. The plan will add a hooks verification check after each CLI command, with git restore as the abort path.

### 4. Plugin identifiers should be derived, not hardcoded (Medium) — INTEGRATED
Good catch. After `marketplace add`, inspect settings.json to get the actual marketplace name the CLI assigned, then use that for install commands.

### 5. Remote-only guard means hook fallback is web-only (Medium) — INTEGRATED
Will add explicit note that this is by design — local sessions rely on settings.json (Phase 1). The hook fallback is specifically for the web reliability problem.

### 6. Rollback procedure for partial failures (Medium) — INTEGRATED
Will add `git checkout -- .claude/settings.json` as the rollback path.

### 7. Backup to `/tmp` is not durable (Low) — INTEGRATED
Will replace with "git history is the backup" guidance.

### 8. Session startup latency (Low) — INTEGRATED
Will add a guard check: `claude plugin list | grep deep-plan` before running all 6 commands.

### 9. Concrete acceptance test (Low) — INTEGRATED
Will specify: "Instruct Claude to 'run deep-plan' and verify it responds with the skill prompt, not 'skill not available'."

## Suggestions NOT Integrated

### 10. Version pinning revisit timeline — NOT INTEGRATED
Out of scope for this spec. The user explicitly said "use latest for now." Adding a revisit timeline is project management, not implementation planning.

### 11. Merge conflict guidance for settings.json — NOT INTEGRATED
Valid concern but out of scope. This is a general git workflow issue, not specific to this migration. The file is already shared via git and already has this problem.
