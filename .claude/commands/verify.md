# Verify Everything Passes

Run the verification suite. Fix any issues found. Report results.

**Note:** Only unit tests are runnable in Claude Code web sessions. Integration and E2E tests require local Supabase (Docker) which is unavailable here. Do not attempt them.

## Steps

```bash
cd web
echo "=== TypeCheck ===" && npm run typecheck 2>&1 | tail -20
echo "=== Lint ===" && npm run lint 2>&1 | tail -20
echo "=== Unit Tests ===" && npm run test 2>&1 | tail -30
echo "=== Build ===" && npm run build 2>&1 | tail -20
```

If anything fails, fix it and re-run. Report a summary of pass/fail status for each check.
