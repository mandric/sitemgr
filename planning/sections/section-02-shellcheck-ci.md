Now I have all the information needed to write the section. The existing `ci.yml` already has a `shellcheck` step but it only covers `scripts/*.sh tests/*.sh` — it does not cover `.claude/hooks/session-start.sh`. The task is to extend that to include the session-start hook.

# section-02-shellcheck-ci

## Overview

This section adds `shellcheck` linting coverage for `.claude/hooks/session-start.sh` to CI. It is optional/low-priority relative to section-03, but provides ongoing protection against shell script regressions — unquoted variables, incorrect `&&`/`||` precedence, broken subshell patterns, and similar issues.

**Dependency:** Requires section-01-script-fixes to be complete first. Section-01 fixes the PATH fallback bug pattern that shellcheck may flag; running shellcheck against the pre-fix script may produce noise.

**Parallelizable with:** section-03-validation-merge.

---

## Background

The existing `.github/workflows/ci.yml` already has a `shellcheck` step in the `lint` job:

```yaml
- name: Lint shell scripts
  run: shellcheck scripts/*.sh tests/*.sh
```

This covers scripts in `scripts/` and `tests/` but does not include `.claude/hooks/session-start.sh`. The session-start hook is the most complex shell script in the repo and the one most likely to have subtle bugs.

`shellcheck` is already available on `ubuntu-latest` GitHub Actions runners — no installation step is required.

---

## Tests (Verification Checks)

These are not automated unit tests — they are manual checks to verify the CI change is correct before committing.

**Check 1 — shellcheck passes locally against the post-section-01 script:**
```bash
shellcheck .claude/hooks/session-start.sh
```
Expected: no output, exit code 0. If there are warnings, they need to be resolved before adding the CI step (otherwise CI immediately fails on merge).

**Check 2 — The PATH fallback pattern passes shellcheck.**
The correct pattern (established in section-01) separates binary copy from `CLAUDE_ENV_FILE` check:
```bash
cp tool /usr/local/bin/tool 2>/dev/null \
  || { mkdir -p "$HOME/.local/bin" && cp tool "$HOME/.local/bin/tool"; }
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
```
The old chained-`&&` pattern (pre-section-01) would trigger shellcheck SC2015 or similar. Confirm the fixed version is clean.

**Check 3 — CI lint job includes the hook after the change:**
```bash
grep -n 'session-start' .github/workflows/ci.yml
```
Expected: at least one line referencing `.claude/hooks/session-start.sh`.

**Check 4 — The lint job does not introduce a new dependency or install step:**
```bash
grep -A5 'Lint shell scripts' .github/workflows/ci.yml
```
Expected: only a `run:` line, no `uses:` or separate install step. `shellcheck` is pre-installed on `ubuntu-latest`.

---

## Implementation

### File to Modify

**`/home/user/sitemgr/.github/workflows/ci.yml`**

Locate the `Lint shell scripts` step inside the `lint` job (currently around line 29-30). Update the `run:` command to also include the session-start hook.

Current:
```yaml
- name: Lint shell scripts
  run: shellcheck scripts/*.sh tests/*.sh
```

Updated:
```yaml
- name: Lint shell scripts
  run: shellcheck scripts/*.sh tests/*.sh .claude/hooks/session-start.sh
```

That is the entire code change. No new jobs, no new steps, no new dependencies.

### Glob Safety Note

The current command uses glob patterns (`scripts/*.sh`, `tests/*.sh`). These will fail with a "no matches found" error if either directory is empty. The session-start hook path is a literal path, so it will fail with "No such file or directory" if the file is missing — which is the correct behavior.

If the `scripts/` or `tests/` directories could be empty (no `.sh` files), add `|| true` to the glob expansions or use `find`. For now, those directories contain `.sh` files so this is not an issue.

---

## Shellcheck Directives (If Needed)

If `shellcheck` reports warnings on intentional patterns in the hook, suppress them with inline directives rather than changing the code logic. For example:

```bash
# shellcheck disable=SC2064
trap "rm -rf $TMPDIR" EXIT
```

Use the minimum scope for suppressions — prefer line-level `# shellcheck disable=SCxxxx` over file-level.

Common false positives to watch for in this script:
- **SC2086** (double-quote to prevent globbing): Variables like `$SUPABASE_VERSION` used in strings — should already be quoted.
- **SC2015** (A && B || C is not if-then-else): The old chained fallback pattern. The section-01 fix should eliminate this.
- **SC2129** (consider using `{ ...; } >> file`): Multiple appends to `CLAUDE_ENV_FILE`. Cosmetic; can suppress or restructure.

---

## Rollback

If shellcheck begins failing on a future PR due to a new shell script construct being flagged, the options are:

1. Fix the flagged pattern (preferred).
2. Add a targeted `# shellcheck disable=SCxxxx` comment on the offending line.
3. If shellcheck produces persistent false positives, add a `.shellcheckrc` at the repo root to configure default behavior globally.

Do not remove the hook path from the `shellcheck` command — that defeats the purpose.