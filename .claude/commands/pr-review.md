# Review PR

Review the specified PR (or most recent open PR) thoroughly and leave actionable feedback.

## Arguments
$ARGUMENTS - PR number or URL (optional, defaults to most recent open PR)

## Steps

1. **Get the PR:**
   ```bash
   gh pr view $ARGUMENTS --json title,body,files,additions,deletions,baseRefName,headRefName
   gh pr diff $ARGUMENTS
   ```

2. **Check out and test the branch:**
   ```bash
   gh pr checkout $ARGUMENTS
   cd web && npm run typecheck && npm run lint && npm run test
   ```

3. **Review for:**
   - Correctness — does the code do what the PR says?
   - Tests — are new behaviors tested? Are tests meaningful?
   - CLAUDE.md compliance — `{ data, error }` shapes preserved? No reshaped data?
   - Security — no secrets in code, no injection vectors, proper RLS
   - Simplicity — no over-engineering, no unnecessary abstractions

4. **Leave a review** with `gh pr review` — approve, request changes, or comment.

5. **Return to the original branch** when done.
