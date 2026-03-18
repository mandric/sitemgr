# Implementation Plan: Fix Session-Start Hook — Supabase CLI Installation

## Background

This project uses a Claude Code session-start hook (`.claude/hooks/session-start.sh`) that runs automatically at the beginning of every Claude Code web session. The hook's purpose is to bootstrap the development environment — installing required CLI tools, setting environment variables, and starting local services — so the session is immediately usable.

The hook had two defects:

**Defect 1 — Global error propagation:** The script used `set -euo pipefail` at the top level, which caused the entire script to abort at the first failure. When any single step failed, all subsequent steps were silently skipped. The session would start but the environment would be broken in hard-to-diagnose ways.

**Defect 2 — Blocked npm install:** The Supabase CLI explicitly refuses global npm installation with the message "Installing Supabase CLI as a global module is not supported." This was the first step to fail, so the entire hook chain aborted — Supabase CLI, Vercel CLI, Playwright, npm install, and supabase start were all skipped.

Both defects have been corrected on branch `claude/check-deep-plan-skill-68AV4`. This plan documents the implemented solution, its design rationale, and the steps required to validate and merge it.

---

## What Was Built

### Change 1: Per-Step Isolation

The global `set -euo pipefail` was removed and replaced with per-step subshell isolation. Each step follows this pattern:

- Wrap multi-command steps in `(set -e; ...)` subshell
- Evaluate success/failure with an `if ... then ... else ... fi` block
- On success: call `log()` with a confirmation message
- On failure: call `fail()` which increments a `FAILURES` counter and writes to stderr
- At the end: report the failure count or success; always exit with code 0

This approach contains each step's failures within that step. A failure in Supabase installation does not prevent Vercel CLI, Playwright, or any other step from running.

The `FAILURES` counter and the final summary message give the user a clear signal: "Completed with N failure(s). Review errors above." The `[session-start] ERROR:` prefix on failure messages makes them easy to spot in the session startup output.

### Change 2: Supabase CLI Binary Download

The Supabase CLI is now installed by downloading the Linux amd64 binary directly from GitHub releases, following the identical pattern already used for the `gh` CLI:

1. Create a temp directory at `/tmp/supabase-install`
2. Download `supabase_linux_amd64.tar.gz` from the GitHub releases URL for the pinned version
3. Extract the tarball — produces a single `supabase` binary at the root
4. Attempt to copy to `/usr/local/bin/supabase` (may succeed if the environment grants write access)
5. If that copy fails, fall back to `$HOME/.local/bin/supabase`, and if `CLAUDE_ENV_FILE` is set, append `export PATH="$HOME/.local/bin:$PATH"` to it so the binary is available for the session
6. Remove the temp directory

The version is hardcoded at `2.78.1`. This is intentional — it makes the hook reproducible and predictable. Automated "fetch latest" logic adds complexity and risk (e.g., a breaking API change in a new release would affect all future sessions without notice). The version should be updated manually when a newer release is needed.

**Important tarball structure note:** The `supabase_linux_amd64.tar.gz` tarball places the `supabase` binary at the tarball root (not in a nested directory). This is unlike the `gh` CLI tarball, which nests the binary under `gh_{VERSION}_linux_amd64/bin/`. The copy command must reference `supabase` directly, not a subdirectory path.

**curl flags:** The download uses `curl -sfL` (`-s` silent, `-f` fail on HTTP errors, `-L` follow redirects). The `-f` flag is important: without it, a 404 or server error silently produces an HTML error page on disk, and the subsequent `tar xzf` fails with an opaque "not a gzip file" error. A `--max-time 60` limit prevents network issues from hanging the session indefinitely.

**PATH fallback correctness:** The fallback install to `$HOME/.local/bin` must copy the binary first and then separately handle the `CLAUDE_ENV_FILE` PATH export. These operations must not be chained with `&&` because if `CLAUDE_ENV_FILE` is unset, the PATH export test fails and (inside the `set -e` subshell) causes the entire step to report failure — even though the binary was successfully installed. The correct pattern:

```bash
cp tool /usr/local/bin/tool 2>/dev/null \
  || { mkdir -p "$HOME/.local/bin" && cp tool "$HOME/.local/bin/tool"; }
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
```

**No integrity verification:** The script does not verify checksums or GPG signatures on downloaded tarballs. This is a known limitation — an acceptable tradeoff for a developer bootstrap script, but worth acknowledging. The GitHub releases CDN is the trust boundary.

---

## Hook Execution Flow (Post-Fix)

Each step in the hook follows a consistent structure. Steps are skipped automatically if the tool is already present (`command -v` check), making the hook idempotent.

**Step 1 — gh CLI:** Download v2.65.0 binary tarball, extract, install to `/usr/local/bin` or `$HOME/.local/bin`. Unchanged from before.

**Step 2 — GH_REPO env var:** Parse `git remote get-url origin` to extract the `owner/repo` slug, export as `GH_REPO`, and persist to `CLAUDE_ENV_FILE`. This enables `gh` commands to work without a `--repo` flag.

**Step 3 — Supabase CLI:** Download v2.78.1 binary tarball, extract single binary, install to `/usr/local/bin` or `$HOME/.local/bin`. This is the fixed step.

**Step 4 — Vercel CLI:** `npm install -g vercel`. Still uses npm — this is intentional. The Vercel CLI npm package does not block global installs (unlike Supabase), so this approach remains appropriate.

**Step 5 — Playwright chromium:** `npx playwright install --with-deps chromium`. Skipped if already installed (detected via dry-run).

**Step 6 — Web app dependencies:** `npm install` in `$PROJECT_DIR/web/`. Fails gracefully if `web/package.json` does not exist.

**Step 7 — Local Supabase:** `supabase start` in `$PROJECT_DIR`. This step will always fail in the Claude Code web environment because Docker is not available. This is acceptable — the failure message clearly identifies the cause ("Cannot connect to the Docker daemon"), the step is counted in `FAILURES`, but the session proceeds. No change is needed here.

---

## Expected Session Output (After Fix)

A fresh session (first run, all tools need installing) should show:

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

A subsequent session (tools already installed) shows:

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

The "1 failure" is the expected Docker failure. Everything else is operational.

---

## Validation Plan

Since the code is already written and confirmed working in the current session, validation is about ensuring the fix behaves correctly across session boundaries — specifically, a brand-new session where Supabase CLI is not yet cached.

### Step 1: Verify Current State

Read the current session-start output (visible at session startup). Confirm:
- `[session-start] Supabase CLI already present.` or `installed.` is present
- No mention of npm global install failure
- The failure count is 1 (Docker only) or 0

### Step 2: Merge to Main

Open a pull request from `claude/check-deep-plan-skill-68AV4` to `main`. The PR should include both commits:
- `bcab68b` — resilience refactor (per-step isolation)
- `4ef8ba0` — Supabase CLI binary download

Confirm no unrelated changes are included in the PR.

### Step 3: Fresh Session Test

After merging, start a new Claude Code web session on the `main` branch. Inspect the session-start output:
- Confirm `[session-start] Installing Supabase CLI v2.78.1...` appears (not "already present")
- Confirm `[session-start] Supabase CLI installed.` follows
- Confirm `command -v supabase` succeeds in the session terminal
- Confirm failure count is 1 (Docker) not 2+ (Docker + Supabase)

### Step 4: Subsequent Session Test

Start a second session. Confirm:
- `[session-start] Supabase CLI already present.` (binary cached from prior session or re-installed, depending on session persistence)
- All other "already present" messages appear as expected

---

## Rollback Plan

If the merged hook breaks sessions (e.g., the hook errors before exit 0, or a dependency change makes existing steps fail), the recovery path is:

1. **Immediate:** Revert the merge commit on `main` (`git revert <merge-sha>`) and push. This restores the pre-fix hook.
2. **Root cause:** Identify which step is failing from the session-start output. The `[session-start] ERROR:` prefix and `FAILURES` counter make failures easy to locate.
3. **Re-fix:** Make a corrected change on a new branch, validate in a fresh session, re-merge.

The hook's `exit 0` guarantee means a broken step does not prevent the session from starting — but tools may be missing. If the hook fails to exit (e.g., an infinite loop or unhandled error before the final `exit 0`), the session will hang. This is guarded against by the `--max-time` flag on all curl commands and the absence of unbounded loops.

---

## Design Rationale

**Why binary download instead of a package manager?**
The Supabase CLI explicitly blocks `npm install -g`. The GitHub releases binary is the officially recommended installation method for Linux scripted environments. It requires only `curl` and `tar`, which are universally available.

**Why keep the version pinned?**
Fetching the latest version dynamically adds complexity (GitHub API call, jq parsing, rate limiting) and unpredictability (a new release might have breaking behavior). Pinned versions are the convention used for the `gh` CLI in this same script. The tradeoff is that versions need manual updates, but that is a low-cost maintenance task.

**Why not fix the Vercel CLI the same way?**
The Vercel CLI npm package does not block global installs. `npm install -g vercel` works correctly today. Switching to binary download would add complexity without solving any problem.

**Why not detect Docker and skip `supabase start` silently?**
The current "fail with informative message" behavior is appropriate. The message "Cannot connect to the Docker daemon" is clear and actionable. Silently skipping would hide a useful signal. The `exit 0` guarantee ensures sessions start regardless.

**Why not add shell script unit tests?**
The hook runs in a specific environment (Claude Code web, Linux amd64, specific env vars) that is not easily reproducible in CI. Manual validation in an actual session is more reliable than mock-based shell tests for this kind of environment bootstrap script. A future improvement worth considering: add `shellcheck` linting to CI (`.github/workflows/`), which catches syntax errors and common shell pitfalls without requiring environment simulation.

**Why does the GH_REPO regex use `/git/`?**
The sed pattern `s|.*/git/\(.*\)$|\1|p` targets the Claude Code web environment's local proxy remote URL format: `http://local_proxy@127.0.0.1:{PORT}/git/owner/repo`. This format is specific to Claude Code on the web and is not a standard GitHub remote URL. The regex is intentional and correct for this environment.

---

## Files

- `.claude/hooks/session-start.sh` — The only file changed. Contains both the resilience refactor and the Supabase binary download fix.
- `.claude/settings.json` — No changes. Hook registration is correct.
