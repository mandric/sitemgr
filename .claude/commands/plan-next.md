# Plan Next Task

Orchestrates task selection → planning → implementation → review using existing plugins.

## Phase 1: Select (human intervention welcome)

Find what needs doing. Check these sources in order:
- Open GitHub issues — pick the highest-priority unassigned issue
- The project manifest (`project-manifest.md`) — find "NOT YET IMPLEMENTED" items
- Existing TODOs/FIXMEs in the codebase (`grep -r "TODO\|FIXME" web/`)

Pick the highest-impact item that has all dependencies met. Present the choice to the user and wait for confirmation before proceeding.

If the task touches anything in the "stop and report" list from CLAUDE.md (migrations, RLS, auth, new production env vars, public API changes), flag it **now** before planning begins.

## Phase 2: Plan → `/deep-plan`

Run `/deep-plan` for the selected task. This produces a detailed, sectionized, TDD-oriented implementation plan with multi-LLM review.

Provide the task description, relevant spec files, and any constraints discovered in Phase 1 as input.

## Phase 3: Implement → `/deep-implement`

Run `/deep-implement` against the plan produced by Phase 2. This handles TDD implementation, verification, and commits.

## Phase 4: Create PR

After `/deep-implement` finishes, push and create a PR:

```bash
git push -u origin <branch-name>
gh pr create --title "<short title>" --body "<summary of changes, test results, link to issue>"
```

## Phase 5: Review → `/code-review`

Run `/code-review` on the PR. The review posts comments on the PR.

## Phase 6: Address review findings

Read the code review comments and triage:

- **Clear bugs or correctness issues** — fix them, commit, push.
- **Style/quality suggestions that align with project conventions** — fix them, commit, push.
- **Subjective or architectural suggestions** — don't act on these; note them for the human.

If you made fixes, run `/verify` to make sure nothing broke, then push.

## Phase 7: Ready for human review

Present to the user:
- PR URL
- Summary of what was implemented
- Code review findings: what was fixed autonomously, what was left for human judgment
- Any items that need human attention before merge

**Stop here.** The user decides when to merge.
