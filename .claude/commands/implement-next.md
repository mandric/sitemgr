# Implement Next Task

## Phase 1: Select (human intervention welcome here)

Find what needs doing. Check these sources in order:
- Open GitHub issues — pick the highest-priority unassigned issue
- The project manifest (`project-manifest.md`) — find "NOT YET IMPLEMENTED" items
- Existing TODOs/FIXMEs in the codebase (`grep -r "TODO\|FIXME" web/`)

Pick the highest-impact item that has all dependencies met. Present the choice to the user and wait for confirmation before proceeding.

## Phase 2: Plan (minimize future blockers)

Before writing code, do upfront work to avoid getting stuck mid-implementation:

1. Read the relevant spec file and grep the codebase for related code
2. Identify anything that would require human decisions (schema changes, new env vars, ambiguous requirements) — surface these **now**, not mid-implementation
3. Write a brief implementation plan: what files to create/modify, what tests to write, what the happy path looks like
4. If the plan touches anything in the "stop and report" list from CLAUDE.md (migrations, RLS, auth, env vars, public API changes), get approval now

Once the plan is confirmed (or if nothing needs confirmation), proceed autonomously.

## Phase 3: Implement (autonomous, don't block)

From here, work autonomously. Don't ask questions — make reasonable decisions.

1. **Create a branch** from `main`:
   ```
   git checkout main && git pull origin main
   git checkout -b claude/<short-description>-$(date +%s)
   ```

2. **Implement with TDD:**
   - Write or update tests first
   - Run tests: `cd web && npm run test` (unit) or `npm run test:integration`
   - Implement until tests pass

3. **Verify the full suite:**
   ```bash
   cd web && npm run typecheck && npm run lint && npm run test && npm run test:integration && npm run build
   ```
   All five must pass. Fix any failures.

4. **Commit and push.** Use clear commit messages. Create a PR with `gh pr create` including what was done and test results.

5. **Report** — summarize the PR URL and changes made.

## Decision-making during implementation

- Follow existing code patterns — match the style of neighboring files
- Preserve `{ data, error }` return shapes from Supabase (per CLAUDE.md)
- Use `vi.stubEnv()` for test fixtures, never real secrets
- If something is ambiguous, pick the simpler option
- If blocked by a missing dependency or external service, skip and move to the next task
- Don't modify migrations, RLS policies, or auth config (these should have been surfaced in Phase 2)
