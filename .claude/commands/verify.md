# Verify Everything Passes

Run the verification suite. On failure, enter the fix loop (see CLAUDE.md "The Fix Loop").

**Note:** Supabase is always running (started by session-start hook). Always run integration tests alongside unit tests.

## Run all checks

```bash
cd web
echo "=== TypeCheck ===" && npm run typecheck 2>&1 | tail -20
echo "=== Lint ===" && npm run lint 2>&1 | tail -20
echo "=== Unit Tests ===" && npm run test 2>&1 | tail -30
echo "=== Integration Tests ===" && npm run test:integration 2>&1 | tail -30
echo "=== Build ===" && npm run build 2>&1 | tail -20
```

## On failure

1. Read the error output — don't guess.
2. Fix the code (not the test, not the lint rule).
3. Re-run **only the failing check**, not the full suite.
4. If it passes, continue to the next check. If it fails, try a different fix (max 3 attempts per check).
5. After all checks pass, re-run the full suite once as a final confirmation.
6. If stuck after 3 attempts on any check, report what failed, what was tried, and why each attempt didn't work.

## CI pipeline check

If on a branch with a PR, also verify the CI pipeline:

1. Check CI status on the PR.
2. If any check fails, read the failure logs, fix, push, and wait for re-run.
3. If CI passes, done.

Report a summary of pass/fail status for each check.
