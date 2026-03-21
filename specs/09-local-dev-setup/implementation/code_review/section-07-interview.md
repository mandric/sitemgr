# Code Review Interview: section-07-verify-sh

## Review Triage

### Issue 1: Wrong env var names (High) → Let go
Reviewer flagged `SMGR_API_URL`/`SMGR_API_KEY` as wrong. These are explicitly specified by the section spec (Dependencies section lists them, and Implementation Details specifies the exact curl command). They are output by `local-dev.sh print_setup_env_vars` into `.env.local`.

### Issue 2: set -e tension with failures counter (Medium) → Let go
Already handled per spec guidance: check functions always return 0 (they increment a counter rather than returning non-zero), and the `curl` call is inside an `if` condition so it cannot trigger `set -e` exit.

### Issue 3: CWD-relative .env.local (Medium) → Let go
Spec does not require script-relative sourcing. The integration docs show calling `./scripts/setup/verify.sh` from the repo root, which is the intended usage.

### Issue 4: Secret leakage via set -a (Low-Medium) → Let go
Spec prescribes the `set -a`/`set +a` pattern. The only child process is `curl` which already needs these env vars.

### Issue 5: Misleading curl error message (Low) → Let go
Spec explicitly specifies the exact string "curl returned non-200".

### Issue 6: Missing vars from .env.example (Low) → Let go
Spec defines the exact list of vars to check.

### Issue 7: No banner (Cosmetic) → Let go
Not in spec.

## Outcome
No fixes applied. Implementation matches spec exactly.
