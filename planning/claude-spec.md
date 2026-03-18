# Specification: Fix Session-Start Hook — Supabase CLI Installation

## Summary

The `.claude/hooks/session-start.sh` hook failed to install the Supabase CLI because `npm install -g supabase` is explicitly blocked by the Supabase package. This caused cascading failures: CLI not installed → `supabase start` step skipped → session starts with errors.

The fix replaces the npm install with a direct binary download from GitHub releases, following the same pattern already used for the `gh` CLI. The fix is implemented on branch `claude/check-deep-plan-skill-68AV4` and confirmed working. This plan covers validation and merge to main.

---

## Problem

**Root cause:** `npm install -g supabase` outputs:
```
Installing Supabase CLI as a global module is not supported.
Please use one of the supported package managers: https://github.com/supabase/cli#install-the-cli
```

**Original hook behavior (before fix):**
- Used global `set -euo pipefail` — script aborted on first error
- Supabase npm install failed → script exited → Vercel, Playwright, npm install, supabase start all skipped
- Session started but all tools were missing

**Cascading effect:**
1. Supabase CLI installation fails (npm blocked)
2. supabase start step skipped (CLI unavailable)
3. All subsequent steps also skipped (set -e propagation)

---

## Solution (Already Implemented)

Two changes were made on the branch:

### Change 1: Per-step resilience (commit bcab68b)

Removed global `set -euo pipefail`. Each step is now isolated in a subshell:
```bash
if (set -e; <step commands>); then
  log "Step succeeded."
else
  fail "Step failed."
fi
```

A `FAILURES` counter tracks failures. The script always exits 0.

### Change 2: Supabase CLI binary download (commit 4ef8ba0)

Replaced `npm install -g supabase` with direct binary download from GitHub releases:
- Version: `2.78.1` (hardcoded, pinned for reproducibility)
- URL: `https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_linux_amd64.tar.gz`
- Install path: `/usr/local/bin/supabase` with fallback to `$HOME/.local/bin/supabase`
- Pattern is identical to the existing `gh` CLI installation

---

## Constraints and Decisions

### Environment
- Linux amd64 only (Claude Code on the web)
- No Docker daemon available (cloud environment)
- May or may not have write access to `/usr/local/bin` (fallback to `$HOME/.local/bin`)
- `CLAUDE_ENV_FILE` is set for persistent PATH additions across the session

### Docker / `supabase start`
- `supabase start` fails with "Cannot connect to Docker daemon" — this is **expected and acceptable**
- The hook reports 1 failure but sessions still starts (exit 0)
- No change needed to this step — the informative error message is appropriate

### Version Pinning
- Supabase CLI version stays hardcoded at `2.78.1`
- Rationale: predictable, reproducible, avoids surprises from upstream releases
- Update manually when a newer version is needed

### Idempotency
- All install steps check `command -v <tool>` before attempting install
- Re-running the hook in the same session skips already-installed tools

---

## Current Hook Steps (Post-Fix)

1. **gh CLI** — binary download from GitHub releases v2.65.0
2. **GH_REPO** — parsed from `git remote get-url origin`, exported to env
3. **Supabase CLI** — binary download from GitHub releases v2.78.1 ← **the fix**
4. **Vercel CLI** — `npm install -g vercel` (still npm, no change needed)
5. **Playwright chromium** — `npx playwright install --with-deps chromium`
6. **Web app dependencies** — `npm install` in `web/`
7. **Local Supabase** — `supabase start` (fails gracefully if Docker unavailable)

---

## Acceptance Criteria

1. Branch `claude/check-deep-plan-skill-68AV4` is merged to `main`
2. A new Claude Code web session starts and session-start output shows:
   - `[session-start] Supabase CLI installed.` (or `already present.` on subsequent sessions)
   - No error about npm global install
3. `command -v supabase` succeeds in the session
4. The Docker failure for `supabase start` remains a reported-but-acceptable failure (1 failure)
5. All other steps (gh, Vercel, Playwright, npm install) still work as before

---

## Files Changed

- `.claude/hooks/session-start.sh` — hook script (the fix)
- `.claude/settings.json` — no changes needed (already correct hook config)
