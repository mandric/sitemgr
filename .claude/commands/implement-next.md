# Implement Next Task

## Phase 1: Select (human intervention welcome)

Find what needs doing. Check these sources in order:
- Open GitHub issues — pick the highest-priority unassigned issue
- The project manifest (`project-manifest.md`) — find "NOT YET IMPLEMENTED" items
- Existing TODOs/FIXMEs in the codebase (`grep -r "TODO\|FIXME" web/`)

Pick the highest-impact item that has all dependencies met. Present the choice to the user and wait for confirmation before proceeding.

## Phase 2: Research & Plan (front-load all decisions)

The goal of this phase is to produce a plan so complete that implementation can run fully autonomously — no questions, no blockers, no surprises.

### 2a. Deep research

Before planning, build a thorough understanding of the problem space:

1. **Codebase research** — Use parallel subagents to explore:
   - Existing patterns: how similar features are structured (routes, lib modules, tests)
   - Related code: grep for types, functions, imports that touch this area
   - Test patterns: how neighboring features are tested (unit vs integration, mocking approach)
   - Dependencies: what this feature depends on and what depends on the area being changed

2. **Spec research** — Read the relevant spec file (`01-data-foundation/spec.md` through `05-cli/spec.md`) and cross-reference with `project-manifest.md` to understand scope boundaries

3. **Constraint discovery** — Identify anything that would require human decisions:
   - Database schema changes (new migrations, RLS policies)
   - New environment variables needed in production
   - Auth flow or security-sensitive changes
   - Ambiguous requirements with multiple valid interpretations
   - External service dependencies not yet configured

### 2b. Generate autonomous implementation plan

Synthesize research into a concrete plan. The plan must be specific enough that implementation requires zero human input:

1. **Files to create/modify** — exact paths, not vague descriptions
2. **Data flow** — how data moves through the system for this feature
3. **Test strategy** — which tests to write first (TDD), what to mock, expected assertions
4. **Edge cases** — enumerate them now so implementation handles them without pausing to think
5. **Integration points** — how this connects to existing code, what imports/exports change
6. **Verification criteria** — what "done" looks like beyond passing tests

### 2c. Surface blockers for approval

If the plan touches anything in the "stop and report" list from CLAUDE.md (migrations, RLS, auth, env vars, public API changes), present these specific items for approval **now**.

For everything else, the plan itself serves as the approval gate — once the user confirms (or if nothing needs confirmation), Phase 3 runs without interruption.

## Phase 3: Implement (autonomous, don't block)

From here, work autonomously. Don't ask questions — make reasonable decisions. The plan from Phase 2 is your source of truth.

1. **Create a branch** from `main`:
   ```
   git checkout main && git pull origin main
   git checkout -b claude/<short-description>-$(date +%s)
   ```

2. **Implement with TDD:**
   - Write or update tests first (following the test strategy from the plan)
   - Run tests: `cd web && npm run test` (unit) or `npm run test:integration`
   - Implement until tests pass
   - Follow the plan's file list and data flow — don't deviate without good reason

3. **Verify the full suite:**
   ```bash
   cd web && npm run typecheck && npm run lint && npm run test && npm run test:integration && npm run build
   ```
   All five must pass. Fix any failures.

4. **Commit and push.** Use clear commit messages. Create a PR with `gh pr create` including:
   - Summary of what was implemented
   - Link to the issue (if applicable)
   - Test results

5. **Report** — summarize the PR URL and changes made.

## Decision-making during implementation

- Follow existing code patterns — match the style of neighboring files
- Preserve `{ data, error }` return shapes from Supabase (per CLAUDE.md)
- Use `vi.stubEnv()` for test fixtures, never real secrets
- If something is ambiguous, pick the simpler option
- If blocked by a missing dependency or external service, skip and move to the next task
- Don't modify migrations, RLS policies, or auth config (these should have been surfaced in Phase 2)
