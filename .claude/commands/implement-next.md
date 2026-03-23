# Implement Next Task

You are running autonomously. Complete as much work as possible without asking the user questions. Make decisions based on CLAUDE.md, the project manifest, and existing code patterns.

## Steps

1. **Find what needs doing.** Check these sources in order:
   - Open GitHub issues assigned to you or labeled `autonomous`
   - The project manifest (`project-manifest.md`) — find "NOT YET IMPLEMENTED" items
   - Existing TODOs/FIXMEs in the codebase (`grep -r "TODO\|FIXME" web/`)
   - Pick the highest-impact item that has all dependencies met

2. **Create a branch** from `main` for the work:
   ```
   git checkout main && git pull origin main
   git checkout -b claude/<short-description>-$(date +%s)
   ```

3. **Plan before coding.** Read the relevant spec file (`01-data-foundation/spec.md` through `05-cli/spec.md`) and understand what exists. Grep the codebase for related code. Write a brief plan as a comment in the PR description later.

4. **Implement with TDD:**
   - Write or update tests first
   - Run tests: `cd web && npm run test` (unit) or `npm run test:integration`
   - Implement until tests pass
   - Run `npm run typecheck` and `npm run lint` — fix any issues

5. **Verify the full suite:**
   ```bash
   cd web && npm run typecheck && npm run lint && npm run test && npm run build
   ```

6. **Commit and push:**
   - Use clear, descriptive commit messages
   - Push the branch
   - Create a PR with `gh pr create` including what was done and test results

7. **Report what you did** — summarize the PR URL and changes made.

## Decision-making rules

- Follow existing code patterns — match the style of neighboring files
- Preserve `{ data, error }` return shapes from Supabase (per CLAUDE.md)
- Use `vi.stubEnv()` for test fixtures, never real secrets
- If something is ambiguous, pick the simpler option
- If blocked by a missing dependency or external service, skip and move to the next task
- Don't modify migrations, RLS policies, or auth config without explicit approval
