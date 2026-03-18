# Opus Review Integration Notes

## What I'm Integrating

### 1. CLAUDE_ENV_FILE bug (Integrating — real bug)

The PATH fallback chaining bug is real. When `CLAUDE_ENV_FILE` is unset, the `[ -n "${CLAUDE_ENV_FILE:-}" ]` test fails and propagates a non-zero exit inside the `set -e` subshell, causing the step to report failure even though the binary was successfully copied. The fix is to separate the `PATH` export into a standalone conditional after the copy succeeds:

```bash
cp tool /usr/local/bin/tool 2>/dev/null \
  || { mkdir -p "$HOME/.local/bin" && cp tool "$HOME/.local/bin/tool"; }
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
```

This also addresses the duplicate PATH export issue (#2) if we add the PATH check.

### 2. Add `--fail` to curl calls (Integrating — trivial improvement)

Adding `--fail` (`-f`) to `curl -sL` → `curl -sfL` ensures HTTP errors (404, 5xx) return non-zero exit codes instead of silently producing an HTML error page that then fails tar with an opaque message.

### 3. Add `--max-time` to curl calls (Integrating — prevents hung sessions)

Adding `--max-time 60` prevents network issues from hanging the session indefinitely.

### 4. Add rollback section to plan (Integrating — important for operators)

The plan should document what to do if the hook breaks sessions after merge.

### 5. Acknowledge no-checksum tradeoff (Integrating — documentation)

Brief note in the design rationale that checksum verification is not performed.

### 6. Add shellcheck to CI as a future improvement (Integrating — good practice)

Note this in the validation section as a future improvement.

---

## What I'm NOT Integrating

### GH_REPO regex is brittle (Not integrating — false alarm)

The Opus reviewer identified the sed pattern `s|.*/git/\(.*\)$|\1|p` as broken for standard GitHub URLs. However, investigation of the actual git remote URL confirms the Claude Code web environment uses a local proxy format: `http://local_proxy@127.0.0.1:{PORT}/git/owner/repo`. This URL DOES contain `/git/` and the regex works correctly. The reviewer was not aware of this environment-specific URL format. The plan should document this to prevent future confusion.

### Playwright `--dry-run` detection (Not integrating as a code change)

This is a pre-existing behavior in the hook not changed by this fix. Adding uncertainty about it to the plan would be misleading for a change that doesn't touch it. The plan's scope is the Supabase fix.

### Automated shell tests (Not integrating as a scope item)

The hook's critical paths require `CLAUDE_CODE_REMOTE=true`, GitHub network access, and specific environment variables. Mocking all of this creates more maintenance burden than value for a simple bootstrap script. Shellcheck in CI is a reasonable suggestion (noted as future improvement), but full test coverage is out of scope.

### Version pinning maintenance undocumented (Not integrating)

This is a minor editorial concern. The plan documents the design rationale. Tracking version updates is an ops concern, not a planning artifact concern.
