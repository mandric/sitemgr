Now I have all the information needed. Let me generate the section content.

# section-01-script-fixes

## Overview

This section applies two remaining polish improvements to `.claude/hooks/session-start.sh`. The core fixes (per-step resilience refactor and Supabase binary download) are already implemented on branch `claude/check-deep-plan-skill-68AV4`. This section targets two specific defects that remain in the script as-merged.

**File to modify:** `.claude/hooks/session-start.sh`

**Branch:** `claude/check-deep-plan-skill-68AV4` (or a new branch off `main` if already merged)

---

## Background

The session-start hook runs at the beginning of every Claude Code web session. It installs CLI tools (gh, Supabase CLI, Vercel CLI, Playwright) and starts local services. The hook has already been refactored to use per-step subshell isolation with a `FAILURES` counter, so a single step failure does not abort subsequent steps.

Two defects remain:

**Defect A — Missing curl robustness flags:** The `curl` calls in the `gh` and Supabase install steps use `-sL` but are missing `-f` (`--fail`) and `--max-time 60`. Without `-f`, a 404 or server error produces an HTML error page on disk instead of a non-zero exit. The subsequent `tar xzf` then fails with an opaque "not a gzip file" error — the real problem (bad URL or network issue) is invisible. Without `--max-time`, a network hang blocks the entire session indefinitely.

**Defect B — PATH fallback chained with `&&`:** In both the `gh` and Supabase install steps, the fallback path (when `/usr/local/bin` is not writable) chains the binary copy and the `CLAUDE_ENV_FILE` PATH export with `&&`:

```bash
cp tool "$HOME/.local/bin/tool" \
  && [ -n "${CLAUDE_ENV_FILE:-}" ] \
  && echo "export PATH=..." >> "$CLAUDE_ENV_FILE"
```

When `CLAUDE_ENV_FILE` is unset, the `[ -n "${CLAUDE_ENV_FILE:-}" ]` test returns false. Inside the `(set -e; ...)` subshell, this false exit causes the subshell to exit non-zero — even though the binary was successfully copied. The step reports failure despite succeeding at its actual job.

---

## Tests

There is no shell test framework in this project. Validation is by static analysis and manual inspection.

**Static checks (run after editing):**

```bash
# Confirm -f flag is present on all curl calls
grep 'curl -s' .claude/hooks/session-start.sh
# Expected: all curl calls show -sfL (not -sL)

# Confirm --max-time is present on all curl calls
grep 'curl -sfL' .claude/hooks/session-start.sh | grep -v 'max-time'
# Expected: no output (all curl calls have --max-time)

# Confirm PATH export is separated from cp (not chained with &&)
grep -A5 'mkdir -p.*\.local/bin' .claude/hooks/session-start.sh
# Expected: cp and CLAUDE_ENV_FILE check are separate statements, not &&-chained

# Confirm script exits 0
tail -1 .claude/hooks/session-start.sh
# Expected: exit 0

# Confirm set -euo pipefail is NOT at the top level
grep -n 'set -euo pipefail' .claude/hooks/session-start.sh
# Expected: no output
```

**PATH fallback correctness test (manual, informal):**

The corrected pattern separates `cp` from the PATH export so an unset `CLAUDE_ENV_FILE` does not cause the subshell to exit non-zero:

```bash
cp tool /usr/local/bin/tool 2>/dev/null \
  || { mkdir -p "$HOME/.local/bin" && cp tool "$HOME/.local/bin/tool"; }
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
```

To manually verify: set `CLAUDE_ENV_FILE` to empty/unset, make `/usr/local/bin` non-writable (or test in a user-land-only environment), and confirm the step reports success (binary copied to `~/.local/bin`) not failure.

---

## Implementation

### Fix A: Add `-f` and `--max-time 60` to curl calls

Locate the two `curl` calls in the script (one for `gh` CLI, one for Supabase CLI). Both currently read:

```bash
curl -sL <URL> -o <file>
```

Change both to:

```bash
curl -sfL --max-time 60 <URL> -o <file>
```

The flags:
- `-s` — silent (suppress progress output)
- `-f` — fail on HTTP error responses (4xx/5xx). Without this, curl exits 0 and writes the HTTP error body to disk.
- `-L` — follow redirects (GitHub releases redirect to the CDN)
- `--max-time 60` — abort if the transfer takes longer than 60 seconds

There are exactly two curl calls to update, at the `gh` CLI install step and the Supabase CLI install step.

### Fix B: Separate binary copy from PATH export

For both the `gh` and Supabase install steps, the fallback block currently reads (abbreviated):

```bash
cp binary /usr/local/bin/binary 2>/dev/null \
  || { mkdir -p "$HOME/.local/bin" && cp binary "$HOME/.local/bin/binary" \
       && [ -n "${CLAUDE_ENV_FILE:-}" ] \
       && echo "export PATH=..." >> "$CLAUDE_ENV_FILE"; }
```

Rewrite each fallback block as two separate operations inside the subshell:

```bash
cp binary /usr/local/bin/binary 2>/dev/null \
  || { mkdir -p "$HOME/.local/bin" && cp binary "$HOME/.local/bin/binary"; }
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
```

Apply this pattern to both the `gh` install step and the Supabase install step.

Note: the `if [ -n "${CLAUDE_ENV_FILE:-}" ]` block runs regardless of whether the install went to `/usr/local/bin` or `~/.local/bin`. This is acceptable — appending to `CLAUDE_ENV_FILE` when the binary is in `/usr/local/bin` is harmless (PATH already includes `/usr/local/bin`). If you prefer to only export when using the fallback path, that logic can be added, but it is not required for correctness.

---

## Acceptance Criteria

After applying both fixes, the following must be true:

1. `grep 'curl -s' .claude/hooks/session-start.sh` shows only `-sfL` (no bare `-sL`)
2. `grep 'curl -sfL' .claude/hooks/session-start.sh | grep -v 'max-time'` returns no output
3. The PATH fallback block for `gh` uses an `if` statement for `CLAUDE_ENV_FILE`, not `&&` chaining
4. The PATH fallback block for `supabase` uses an `if` statement for `CLAUDE_ENV_FILE`, not `&&` chaining
5. The script ends with `exit 0`
6. `set -euo pipefail` does not appear at the top level of the script

---

## Dependencies

This section has no dependencies. It modifies only `.claude/hooks/session-start.sh`.

**Blocks:**
- `section-02-shellcheck-ci` — adding shellcheck to CI should run against the corrected script
- `section-03-validation-merge` — the PR to main should include these fixes before merging

---

## Notes

- Do not change any other behavior in the script. The goal is targeted fixes only.
- The Supabase version (`2.78.1`) remains pinned. Do not update it as part of this section.
- The `gh` CLI version (`2.65.0`) also remains pinned.
- The `supabase start` step is expected to fail with a Docker error in the Claude Code web environment. This is not a bug — the step reports 1 failure and the session continues. Do not attempt to fix or silence this.