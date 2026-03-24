# Verify Everything Passes

Run the verification suite. Fix any issues found. Report results.

**Note:** Supabase is always running (started by session-start hook). Always run integration tests alongside unit tests.

## Steps

```bash
cd web
echo "=== TypeCheck ===" && npm run typecheck 2>&1 | tail -20
echo "=== Lint ===" && npm run lint 2>&1 | tail -20
echo "=== Unit Tests ===" && npm run test 2>&1 | tail -30
echo "=== Integration Tests ===" && npm run test:integration 2>&1 | tail -30
echo "=== Build ===" && npm run build 2>&1 | tail -20
```

If anything fails, fix it and re-run. Report a summary of pass/fail status for each check.
