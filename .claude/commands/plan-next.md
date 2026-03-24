# Plan Next Task

Orchestrates task selection → planning → implementation → review using existing plugins.

## Phase 1: Find the spec

Every task starts from a spec. Find or create one:

1. **Check for an existing spec** — look in `specs/` for a numbered directory matching the task, or in a GitHub issue with a detailed description
2. **If no spec exists** — ask the user to provide one, or use `/deep-project` to decompose a vague requirement into spec-ready planning units

The spec is the source of truth for what to build. It may live as:
- A `spec.md` file in `specs/<NN>-<name>/`
- A GitHub issue body with requirements and acceptance criteria

## Phase 2: Confirm spec with user (human intervention welcome)

Present the spec to the user and wait for confirmation before proceeding.

If the spec touches anything in the "stop and report" list from CLAUDE.md (migrations, RLS, auth, new production env vars, public API changes), flag it **now** before planning begins.

## Phase 3: Plan → `/deep-plan`

Run `/deep-plan`, passing the spec (file path or issue URL) as input. `/deep-plan` owns task breakdown internally — a spec is a single unit of work for one session. This produces a detailed, sectionized, TDD-oriented implementation plan with multi-LLM review.

## Phase 4: Implement → `/deep-implement`

Run `/deep-implement` against the plan produced by Phase 2. This handles TDD implementation, verification, and commits.

## Phase 5: Create PR

After `/deep-implement` finishes, push and create a PR:

```bash
git push -u origin <branch-name>
gh pr create --title "<short title>" --body "<summary of changes, test results, link to issue>"
```

## Phase 6: Wait for CI, then review

Wait for the CI pipeline to complete on the PR. Poll with `gh pr checks <pr-number>` until all checks finish.

- **All checks pass** — proceed to code review.
- **Any check fails** — read the failure logs, fix the issue, push, and wait again.

Once CI is green, run `/code-review` on the PR. The review posts comments on the PR.

## Phase 7: Address review findings

Read the code review comments and triage:

- **Clear bugs or correctness issues** — fix them, commit, push.
- **Style/quality suggestions that align with project conventions** — fix them, commit, push.
- **Subjective or architectural suggestions** — don't act on these; note them for the human.

If you made fixes, run `/verify` to make sure nothing broke, then push.

## Phase 8: Ready for human review

Present to the user:
- PR URL
- Summary of what was implemented
- Code review findings: what was fixed autonomously, what was left for human judgment
- Any items that need human attention before merge

**Stop here.** The user decides when to merge.
