# Fix Failing Tests

Run the test suite autonomously and fix all failures. Do not ask for help — use the codebase and test output to diagnose and fix issues.

**Important:** Unit tests (`npm run test`) always work. Integration and E2E tests both require local Supabase **and** the web app running (`next dev`). The session-start hook starts Supabase automatically. Ensure the dev server is running before attempting integration or E2E tests.

## Steps

1. **Run unit tests and capture output:**
   ```bash
   cd web && npm run test 2>&1 | head -200
   ```

2. **If tests pass**, run the broader suite:
   ```bash
   cd web && npm run typecheck && npm run lint && npm run build
   ```

3. **For each failure:**
   - Read the failing test file and the source file it tests
   - Understand what the test expects vs what the code does
   - Fix the source code (not the test) unless the test itself has a bug
   - Re-run just that test file to confirm: `cd web && npx vitest run <path>`

4. **After all fixes**, run the full suite again to confirm no regressions:
   ```bash
   cd web && npm run test && npm run typecheck && npm run lint
   ```

5. **Commit fixes** with a message describing what was broken and why.

## Rules

- Fix source code to match test expectations, not the other way around
- Only fix a test if it's clearly wrong (testing old behavior, wrong assertion)
- Don't refactor unrelated code
- If a test requires a service that isn't running, start it (Supabase should already be running via session-start hook)
