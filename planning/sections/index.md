<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: cd web && npm test
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-script-fixes
section-02-shellcheck-ci
section-03-validation-merge
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-script-fixes | - | section-02, section-03 | No |
| section-02-shellcheck-ci | section-01 | section-03 | Yes |
| section-03-validation-merge | section-01 | - | No |

## Execution Order

1. **section-01-script-fixes** (no dependencies — apply remaining improvements to hook script)
2. **section-02-shellcheck-ci** (after section-01 — optional: add shellcheck to CI)
3. **section-03-validation-merge** (after section-01 — create PR, merge to main, validate in fresh session)

Note: sections 02 and 03 can be done in parallel after section-01, but section-03 is the primary deliverable.

## Section Summaries

### section-01-script-fixes

Apply the remaining improvements identified during review to `.claude/hooks/session-start.sh`:
- Add `--fail` and `--max-time 60` to all `curl` calls
- Fix the PATH fallback bug: separate the binary copy from the `CLAUDE_ENV_FILE` PATH export so an unset `CLAUDE_ENV_FILE` does not cause a false step failure

The core Supabase binary download fix (npm → binary download) and per-step resilience refactor are already implemented. This section applies the polish improvements.

### section-02-shellcheck-ci

Add a GitHub Actions workflow that runs `shellcheck` on `.claude/hooks/session-start.sh` for every PR that touches `.claude/hooks/`. This is a future improvement — it catches shell script syntax errors and common pitfalls without requiring environment simulation.

This section is optional/low-priority. Skip if the team prefers to keep CI minimal.

### section-03-validation-merge

Create a pull request from `claude/check-deep-plan-skill-68AV4` to `main`, merge it, and validate in a fresh Claude Code web session:
- Confirm `[session-start] Supabase CLI installed.` or `already present.` appears
- Confirm no npm global install error
- Confirm `command -v supabase` succeeds
- Confirm failure count is 1 (Docker only)
