# Plan Next

Orchestrate: find spec → plan → implement → verify → review → present.

## Steps

1. **Find spec** — Check `specs/` for a numbered directory with `spec.md`. If none, ask the user or use `/deep-project`.

2. **Confirm with user** — Present the spec. Flag anything from the "stop and report" list (migrations, RLS, auth, new env vars, public API changes) before proceeding.

3. **Plan** — Run `/deep-plan` with the spec path. Skip if a plan already exists (check for `sections/` directory).

4. **Implement** — Run `/deep-implement` against the sections directory.

5. **Follow post-implementation checklist** — See CLAUDE.md "Post-Implementation Checklist (mandatory)". This includes: verify, PR, code-review, address findings, re-verify, update PR, present for human review.
