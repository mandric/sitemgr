# Section 03: Validation and Merge

## Overview

This section covers creating a pull request from `claude/check-deep-plan-skill-68AV4` to `main`, merging it, and validating the Supabase CLI fix in a fresh Claude Code web session. This is the primary deliverable of the overall plan.

**Depends on:** section-01-script-fixes (the script must be fully polished before merging)

**No automated tests exist for this section.** The validation is entirely manual — it requires a real Claude Code web session to observe hook execution behavior. This is the appropriate testing approach because the hook depends on the Claude Code web environment (`CLAUDE_CODE_REMOTE=true`), Docker status, and GitHub network access, none of which are reproducible in CI.

---

## Background

The session-start hook at `.claude/hooks/session-start.sh` had two defects now fixed on branch `claude/check-deep-plan-skill-68AV4`:

1. **Global error propagation**: `set -euo pipefail` at the top level caused the entire script to abort at the first failure. This has been replaced with per-step subshell isolation — each step runs in `(set -e; ...)`, increments a `FAILURES` counter on failure, and the script always exits 0 so sessions are not blocked.

2. **Blocked npm install for Supabase CLI**: The Supabase CLI explicitly refuses `npm install -g`. It is now installed by downloading the Linux amd64 binary from GitHub releases (version `2.78.1`), identical to how `gh` CLI is installed.

Both commits are already on the branch:
- `bcab68b` — resilience refactor (per-step isolation)
- `4ef8ba0` — Supabase CLI binary download

The only file changed is `.claude/hooks/session-start.sh`.

---

## Pre-Merge Verification Checklist

Before opening the PR, verify the current session shows a healthy state. Run these shell checks in the current session terminal:

**Script structure checks (run in the repo root):**

```bash
# Should return no matches
grep -n 'set -euo pipefail' .claude/hooks/session-start.sh

# Should show at least 2 subshells
grep -n '(set -e' .claude/hooks/session-start.sh

# Should be 'exit 0'
tail -1 .claude/hooks/session-start.sh
```

**curl flag checks:**

```bash
# All curl calls should include -f (fail on HTTP error)
grep 'curl -sfL' .claude/hooks/session-start.sh

# Should return no matches (all curl calls must have --max-time)
grep 'curl -sfL' .claude/hooks/session-start.sh | grep -v 'max-time'
```

**Supabase tarball structure pre-check** (confirms binary is at tarball root, not nested):

```bash
curl -sfL --max-time 60 https://github.com/supabase/cli/releases/download/v2.78.1/supabase_linux_amd64.tar.gz -o /tmp/test.tar.gz && tar tzf /tmp/test.tar.gz | grep '^supabase$'
```

Expected output: `supabase` (single line, no path prefix).

**Current session state check:**

Inspect the session-start output from when this session was started. It should show:
- `[session-start] Supabase CLI installed.` or `[session-start] Supabase CLI already present.`
- No line containing "Installing Supabase CLI as a global module is not supported"
- Failure count of 1 (Docker only)

---

## Step 1: Create the Pull Request

Open a PR from `claude/check-deep-plan-skill-68AV4` to `main` using the `gh` CLI:

```bash
gh pr create \
  --base main \
  --head claude/check-deep-plan-skill-68AV4 \
  --title "Fix session-start hook: Supabase CLI binary download + per-step resilience" \
  --body "Fixes two defects in .claude/hooks/session-start.sh:

1. Per-step isolation: replaced global set -euo pipefail with per-step subshell isolation. Each step's failure is counted but does not abort subsequent steps. Script always exits 0.

2. Supabase CLI installation: replaced blocked npm install -g with direct binary download from GitHub releases (v2.78.1), matching the existing gh CLI installation pattern.

Expected session output after fix:
- [session-start] Supabase CLI installed. (first session)
- [session-start] Supabase CLI already present. (subsequent sessions)
- Failure count: 1 (Docker only, not Docker + Supabase)

Commits:
- bcab68b: resilience refactor
- 4ef8ba0: Supabase CLI binary download"
```

Confirm the PR includes exactly the two commits above and no unrelated changes.

---

## Step 2: Merge

Once the PR is created, merge it:

```bash
gh pr merge --squash --delete-branch
# or
gh pr merge --merge --delete-branch
```

Either merge strategy is acceptable. The branch `claude/check-deep-plan-skill-68AV4` should be deleted after merging.

---

## Step 3: Fresh Session Validation

After merging, start a **new Claude Code web session** on the `main` branch. This must be a genuinely fresh session — not the current one — so the hook runs again from scratch. The fresh session is required to simulate a first-run installation where Supabase CLI is not yet present.

Observe the session-start output. The checklist for a successful validation:

- [ ] `[session-start] Installing Supabase CLI v2.78.1...` appears (on first run) OR `[session-start] Supabase CLI already present.` (if binary was cached from a prior session)
- [ ] `[session-start] Supabase CLI installed.` follows the "Installing..." line (no error)
- [ ] No output containing `"Installing Supabase CLI as a global module is not supported"`
- [ ] `command -v supabase` succeeds in the fresh session terminal
- [ ] `supabase --version` outputs `2.78.1`
- [ ] Failure count is exactly `1` (Docker only) — not `2` or more
- [ ] All other steps complete: `gh CLI`, `GH_REPO`, `Vercel CLI`, `Playwright`, `web app dependencies`

---

## Step 4: Subsequent Session Validation

Start a second new session (after the fresh session above). Confirm idempotency:

- [ ] `[session-start] Supabase CLI already present.` (not "Installing...")
- [ ] All other tools also show `already present.` (except npm install which always runs)
- [ ] Failure count remains 1 (Docker only)

---

## Expected Session Output Reference

**First session (fresh install):**

```
[session-start] Installing gh CLI...
[session-start] gh CLI installed.
[session-start] GH_REPO set to owner/repo
[session-start] Installing Supabase CLI v2.78.1...
[session-start] Supabase CLI installed.
[session-start] Installing Vercel CLI...
[session-start] Vercel CLI installed.
[session-start] Installing Playwright chromium...
[session-start] Playwright chromium installed.
[session-start] Installing web app dependencies...
[session-start] Web app dependencies installed.
[session-start] Starting local Supabase...
failed to inspect service: Cannot connect to the Docker daemon ...
[session-start] Completed with 1 failure(s). Review errors above.
```

**Subsequent session (tools cached):**

```
[session-start] gh CLI already present.
[session-start] GH_REPO set to owner/repo
[session-start] Supabase CLI already present.
[session-start] Vercel CLI already present.
[session-start] Playwright chromium already present.
[session-start] Installing web app dependencies...
[session-start] Web app dependencies installed.
[session-start] Starting local Supabase...
failed to inspect service: Cannot connect to the Docker daemon ...
[session-start] Completed with 1 failure(s). Review errors above.
```

The "1 failure" for Docker is the expected and permanent state in the Claude Code web environment. It does not indicate a problem.

---

## Rollback Plan

If the merged hook breaks sessions:

1. **Immediate recovery**: Revert the merge commit on `main`:
   ```bash
   git revert <merge-sha>
   git push origin main
   ```
   This restores the pre-fix hook without requiring a full branch reset.

2. **Diagnosis**: Identify which step is failing from the `[session-start] ERROR:` prefixed lines in session-start output. The `FAILURES` counter gives the count; the error lines above the summary identify the cause.

3. **Re-fix**: Create a new branch from `main`, make the corrected change, validate in a fresh session, and re-merge.

The hook's `exit 0` guarantee means a broken step cannot prevent the session from starting. The only scenario that would hang a session is an infinite loop or a `curl` call without `--max-time`. Both are guarded against by the implementation.

---

## Files

- `.claude/hooks/session-start.sh` — The only file changed by this entire plan. Both the resilience refactor and the Supabase binary download fix are already committed on the branch.
- `.claude/settings.json` — No changes needed. Hook registration is already correct.