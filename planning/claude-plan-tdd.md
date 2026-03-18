# TDD Plan: Fix Session-Start Hook

## Testing Context

This is a shell script hook for the Claude Code web environment. The project uses:
- **Vitest** for unit/integration tests (web app)
- **Playwright** for E2E tests (web app)
- **No dedicated test framework for shell scripts**

Shell script testing options:
- **shellcheck** — static analysis, catches syntax errors and common pitfalls. Can run in CI.
- **bats / shunit2** — unit test frameworks for bash. Require environment mocking that is impractical for a hook that depends on `CLAUDE_CODE_REMOTE=true`, Docker status, GitHub network access, etc.
- **Manual session validation** — the primary validation method. Start a real Claude Code web session; observe session-start output.

**Recommendation:** Use `shellcheck` for automated static analysis in CI, and manual session validation for integration verification.

---

## Section: Per-Step Isolation (Change 1)

**Before implementing:** Verify the test harness

- Test: `set -euo pipefail` is NOT present at the top of the script
  - Check: `grep -n 'set -euo pipefail' session-start.sh` returns no matches
- Test: each multi-command step is wrapped in a subshell
  - Check: `grep -n '(set -e' session-start.sh` shows at least 2 subshells (gh, supabase)
- Test: `FAILURES` counter is incremented on failure but script continues
  - Manual: introduce a deliberate failure (bad URL in one step); confirm subsequent steps still run
- Test: script always exits 0
  - Check: `tail -1 session-start.sh` is `exit 0`

---

## Section: Supabase CLI Binary Download (Change 2 — the core fix)

**Before implementing:** Define acceptance for the happy path

- Test: the tarball URL resolves to a valid binary
  - Manual pre-check: `curl -sfL --max-time 60 https://github.com/supabase/cli/releases/download/v2.78.1/supabase_linux_amd64.tar.gz -o /tmp/test.tar.gz && tar tzf /tmp/test.tar.gz | grep '^supabase$'`
  - Confirms: binary is named `supabase` at tarball root (not nested)

- Test: installation succeeds in an environment with `/usr/local/bin` write access
  - Condition: `cp supabase /usr/local/bin/supabase` succeeds
  - Expected: `command -v supabase` returns `/usr/local/bin/supabase`

- Test: installation falls back to `$HOME/.local/bin` when `/usr/local/bin` is not writable
  - Condition: `/usr/local/bin` write fails
  - Expected: `$HOME/.local/bin/supabase` exists AND `$HOME/.local/bin` is in PATH

- Test: `CLAUDE_ENV_FILE` PATH export does not cause failure when var is unset
  - Condition: `CLAUDE_ENV_FILE` not set; `/usr/local/bin` not writable
  - Expected: step succeeds (binary copied), no PATH export attempted, no false failure

- Test: step is idempotent — skipped if already installed
  - Condition: `command -v supabase` succeeds before the step
  - Expected: `[session-start] Supabase CLI already present.` in output, no download attempted

---

## Section: curl Robustness Flags

**Before implementing:** Know what each flag catches

- Test: `--fail` flag causes non-zero exit on HTTP 404
  - Check: `grep 'curl -sfL' session-start.sh` shows `-f` present in all curl calls
  - shellcheck will not catch missing `-f`; must be manual code review

- Test: `--max-time` flag is present on all curl calls
  - Check: `grep 'curl -sfL' session-start.sh | grep -v 'max-time'` returns no matches

---

## Section: PATH Fallback Bug Fix

**Before implementing:** Understand the failure mode

- Test: copy + PATH export are separate operations (not chained with `&&`)
  - Check: fallback block structure separates `cp` from `CLAUDE_ENV_FILE` check
  - shellcheck may catch some patterns here

- Test: PATH export only runs if install went to `$HOME/.local/bin`
  - Condition: `/usr/local/bin` write succeeds
  - Expected: NO PATH export written to `CLAUDE_ENV_FILE`
  - This prevents duplicate exports when both `gh` and `supabase` use fallback

---

## Section: Validation (Manual Session Test Checklist)

**Before merging to main:** Run this checklist in a fresh Claude Code web session

- [ ] Session-start output shows `[session-start] Supabase CLI installed.` (first session) or `already present.` (subsequent)
- [ ] No output containing "Installing Supabase CLI as a global module is not supported"
- [ ] `command -v supabase` succeeds in the session terminal
- [ ] `supabase --version` shows `2.78.1`
- [ ] Failure count is exactly 1 (Docker only, not Docker + Supabase)
- [ ] All other steps (gh, GH_REPO, Vercel, Playwright, npm install) still work as before

---

## Future Improvement: shellcheck in CI

Add a GitHub Actions workflow that runs `shellcheck .claude/hooks/session-start.sh` on every PR touching `.claude/hooks/`. This catches:
- Unquoted variables
- Unset variable usage
- Incorrect `&&` / `||` precedence
- Broken subshell patterns

This does not require environment simulation and runs in seconds.
