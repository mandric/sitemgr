# Opus Review

**Model:** claude-opus-4
**Generated:** 2026-03-18T06:35:00Z

---

## Review of Plugin Setup Implementation Plan

### Overall Assessment

This is a well-structured, conservative plan for a narrowly-scoped operational task. The two-phase approach (try the clean fix, fall back to the brute-force fix) is sensible. That said, there are several gaps and risks worth addressing before execution.

---

### 1. The `set -euo pipefail` in session-start.sh conflicts with the error suppression strategy in Section 7

This is the most important issue. The existing hook at `/home/user/sitemgr/.claude/hooks/session-start.sh` starts with `set -euo pipefail` (line 2). The plan says to add plugin install commands with `2>/dev/null || true` to suppress errors. While `|| true` does prevent a non-zero exit from triggering `set -e`, the `set -o pipefail` flag means any command piped through something else will still fail the script. More critically, if someone later removes the `|| true` or writes a slightly different form (e.g., `command 2>/dev/null` without `|| true`), the entire hook dies and no subsequent commands run -- including the npm install, supabase start, etc.

**Recommendation:** The plan should explicitly call out the `set -euo pipefail` context and either (a) wrap the plugin section in a subshell with `set +e`, or (b) use an explicit function with a trap. At minimum, document why `|| true` is non-negotiable here.

---

### 2. The `claude` CLI may not be on PATH inside the SessionStart hook

The hook is designed for remote/web environments (`CLAUDE_CODE_REMOTE=true` guard on line 5). In that context, is the `claude` binary guaranteed to be on `$PATH` when the hook runs? The hook installs `gh`, `supabase`, and `vercel` CLIs because they are NOT present by default. If `claude` is the host process invoking the hook, calling `claude plugin install` from within the hook may work -- but it may also deadlock or error if the CLI doesn't support being called recursively from its own hook. The plan does not address this at all.

**Recommendation:** Add a verification step in Section 7: confirm `which claude` succeeds inside the hook context, and test whether `claude plugin install` can be called from within a SessionStart hook without deadlock or re-entrancy issues.

---

### 3. The remote-only guard in session-start.sh means Section 7 will not run locally

The existing hook has an early exit on line 5-7: if `CLAUDE_CODE_REMOTE` is not `true`, the script exits immediately. This means the fallback plugin install commands added in Section 7 would never run in local CLI sessions. The plan does not mention this. If the intent is that local sessions rely solely on `settings.json` (Phase 1), that should be stated explicitly. If not, the plugin install commands need to be placed before the remote-only guard, or in a separate block that runs unconditionally.

**Recommendation:** Add a note in Section 7 clarifying that the hook fallback only applies to web/remote sessions. If local sessions also need this fallback, the commands must be placed before the `CLAUDE_CODE_REMOTE` check.

---

### 4. Backup to `/tmp` is not a real backup

Section 1 suggests copying to `/tmp/settings.json.bak`. This is a volatile location that gets wiped on reboot or container restart (relevant for web environments). The plan also suggests `git stash` as an alternative, but since the file is already tracked in git, the real backup is just the current git commit.

**Recommendation:** Replace the `/tmp` suggestion with "the current state is already captured in git history; ensure changes are on a branch so they can be reverted with `git checkout`." Remove the `/tmp` suggestion -- it gives false confidence.

---

### 5. No verification that CLI-managed settings.json preserves hooks

Section 3 and Section 4 say to check `settings.json` after each CLI command. But the plan does not account for the possibility that `claude plugin marketplace add` or `claude plugin install` might **overwrite** the file entirely rather than merging into it. If the CLI writes a fresh file, the `hooks` block would be lost.

**Recommendation:** After the very first CLI command in Section 3, immediately verify the hooks block is still present before proceeding. If it was clobbered, abort and restore from git. This check should happen after each command, not just at the end in Section 5.

---

### 6. Plugin identifier format is assumed, not verified

Section 4 uses identifiers like `deep-project@piercelamb-deep-project`. This format is taken from the current hand-edited config. But the plan's entire premise is that the hand-edited format may be wrong. The CLI's `marketplace add` command in Section 3 may register the marketplace under a different identifier than `piercelamb-deep-project`, which would make the Section 4 install commands fail.

**Recommendation:** Section 4 should derive the plugin identifiers from the output of Section 3, not hardcode them. Add a step: "After marketplace add, inspect settings.json to determine the exact marketplace name the CLI assigned, and use that in the install command."

---

### 7. No rollback procedure if Phase 1 partially succeeds

If the first `marketplace add` succeeds but the second fails, or if `install` succeeds for one plugin but not another, the plan doesn't describe how to recover to a clean state. "Try again" is the only error handling.

**Recommendation:** Add a rollback step: "If any command in Sections 3-4 fails after retries, restore settings.json from git (`git checkout -- .claude/settings.json`) and investigate before retrying the full sequence."

---

### 8. Missing consideration: `.claude/settings.json` merge conflicts in team workflows

The plan says this file is shared via git (project scope). Multiple team members running different plugin versions or making config changes will create merge conflicts in this JSON file. JSON does not merge well with git's line-based merge strategy.

**Recommendation:** Note this as a known risk. Consider adding `.claude/settings.json` merge strategy guidance (e.g., always accept theirs and re-run the CLI commands).

---

### 9. Session startup latency impact is not discussed

Section 7 adds 6 CLI commands (3 marketplace adds + 3 installs) to every web session start. Even if idempotent, each command has startup overhead (process spawn, file I/O, possibly network calls to check marketplace). The existing hook already installs multiple tools. Adding 6 more commands could meaningfully increase session start time.

**Recommendation:** Add a timing estimate or at least acknowledge the latency concern. Consider wrapping the plugin commands in a single check: "if plugins are already installed, skip all 6 commands" (e.g., check `claude plugin list` output once).

---

### 10. "Don't pin plugin versions" is a risk that should be time-boxed

The decision log says "use latest for now." Unpinned plugins mean any upstream push to the plugin repos could break the workflow silently. This is fine for early development but should have a revisit date.

**Recommendation:** Add to the decision log: "Revisit version pinning before production use or when more than 2 people use the project."

---

### 11. Minor: Section 6 testing methodology is vague

"Start a new web session and check if plugins are available" -- how? The plan should specify the exact check: run a specific skill command, check for specific output, or look for specific log entries. "Ask Claude to run a skill" is not a reproducible test.

**Recommendation:** Define a concrete acceptance test, e.g., "In the new web session, run `/deep-project` and verify it produces output rather than 'skill not found' or similar error."

---

### Summary of Priority Issues

| Priority | Issue | Section |
|----------|-------|---------|
| High | `set -euo pipefail` conflicts with error suppression strategy | Section 7 |
| High | `claude` CLI re-entrancy/availability in hook context unknown | Section 7 |
| High | CLI commands may clobber hooks block in settings.json | Sections 3-4 |
| Medium | Plugin identifiers are hardcoded, not derived from CLI output | Section 4 |
| Medium | Remote-only guard means hook fallback is web-only | Section 7 |
| Medium | No rollback procedure for partial failures | Sections 3-4 |
| Low | `/tmp` backup is not durable | Section 1 |
| Low | Session startup latency from 6 additional commands | Section 7 |
| Low | Unpinned versions need a revisit timeline | Decision Log |
