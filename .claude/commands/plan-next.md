# Plan Next

Orchestrate the full autonomous development process: find spec → plan → implement → verify → review → present.

## Steps

1. **Find spec** — Check `specs/` for a numbered directory with `spec.md`. If none, ask the user or use `/deep-project`.

2. **Confirm with user** — Present the spec. Flag anything from the "stop and report" list (migrations, RLS, auth, new env vars, public API changes) before proceeding.

3. **Plan** — Run `/deep-plan` with the spec path. Skip if a plan already exists (check for `sections/` directory).

4. **Implement** — Run `/deep-implement` against the sections directory.

5. **Run the Autonomous Development Process** — See CLAUDE.md "Autonomous Development Process". This runs end-to-end without stopping for human input unless a "stop and report" item is hit or the fix loop is exhausted:
   - Phase 1: Verify (fix loop on failures)
   - Phase 2: Push & PR
   - Phase 3: Code review → auto-fix findings → re-verify
   - Phase 4: CI check (fix loop on failures)
   - Phase 5: Present to human with PR URL, summary, and items needing attention
