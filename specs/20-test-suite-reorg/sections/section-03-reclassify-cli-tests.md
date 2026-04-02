Now I have all the context needed. Let me generate the section content.

# Section 3: Reclassify CLI Tests as E2E

## Overview

This section creates a new `e2e-cli` test tier for CLI subprocess tests that are currently misclassified as integration tests. These tests spawn `tsx bin/sitemgr.ts` and test through the user-facing CLI binary -- they are E2E tests by definition (per CLAUDE.md's testing philosophy). The work involves creating the directory structure, adding a vitest project, moving and merging test files, and updating npm scripts.

This section has no dependencies on other sections and can be executed in parallel with section-01.

## Tests First

The tests ARE the deliverable being moved. After the move, the following verifications confirm correctness:

### Vitest config verification

```
# Verify: e2e-cli project picks up __tests__/e2e-cli/**/*.test.ts
# Verify: unit project excludes __tests__/e2e-cli/**
# Verify: npm run test:e2e:cli runs the e2e-cli project
# Verify: npm run test runs only unit tests (no e2e-cli)
# Verify: npm run test:integration runs only integration tests
```

### `sitemgr-commands.test.ts` (merged from sitemgr-cli.test.ts)

```
# Test: no command -> exit 0 with usage
# Test: unknown command -> exit 1
# Test: stats -> valid JSON output
# Test: query -> table format output
# Test: query --format json -> JSON output
# Test: query --limit -> respects limit
# Test: show [id] -> event details
# Test: exit code non-zero when not logged in
```

### `sitemgr-pipeline.test.ts` (from sitemgr-e2e.test.ts)

```
# Test: watch --once discovers uploaded images
# Test: enrich --dry-run lists pending
# Test: enrich --pending processes images (requires Ollama)
# Test: FTS search returns results from enrichment descriptions
# Test: final stats show all enriched
```

## Implementation

### Step 1: Create the e2e-cli directory

Create the directory `/home/user/sitemgr/web/__tests__/e2e-cli/`.

### Step 2: Add e2e-cli vitest project to vitest.config.ts

File to modify: `/home/user/sitemgr/web/vitest.config.ts`

Add a third project entry to the `projects` array. The current config has two projects: `unit` and `integration`. Add `e2e-cli` as a third:

```typescript
{
  extends: true,
  test: {
    name: "e2e-cli",
    globals: true,
    environment: "node",
    include: ["__tests__/e2e-cli/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 60000,
    globalSetup: ["__tests__/integration/globalSetup.ts"],
    fileParallelism: false,
  },
}
```

Key details:
- **Reuses the same `globalSetup.ts`** as integration tests -- both need Supabase running and optionally the Next.js dev server. No new infrastructure needed.
- **`testTimeout: 120000`** -- CLI tests are slower than direct function calls (subprocess spawn overhead). The pipeline test overrides individual timeouts up to 300s.
- **`fileParallelism: false`** -- CLI tests share state (temp credential files, seeded data) and must run sequentially.

In the same change, add `"__tests__/e2e-cli/**"` to the unit project's `exclude` array. The current unit project excludes `e2e/**`, `node_modules/**`, and `__tests__/integration/**`. Add the new exclusion so the unit runner does not pick up e2e-cli tests:

```typescript
exclude: [
  "e2e/**",
  "node_modules/**",
  "__tests__/integration/**",
  "__tests__/e2e-cli/**",
],
```

### Step 3: Add npm script to package.json

File to modify: `/home/user/sitemgr/web/package.json`

Add the following script:

```json
"test:e2e:cli": "vitest run --project e2e-cli"
```

The existing `test:all` script (`vitest run`) already runs all vitest projects, so adding the e2e-cli project to vitest.config.ts means `test:all` automatically includes it. No change needed to `test:all`.

### Step 4: Move and rename sitemgr-cli.test.ts

Source: `/home/user/sitemgr/web/__tests__/integration/sitemgr-cli.test.ts`
Destination: `/home/user/sitemgr/web/__tests__/e2e-cli/sitemgr-commands.test.ts`

Changes to make during the move:

1. **Update the import path for `setup`** -- change `from "./setup"` to `from "../integration/setup"` since the file moves up one level and into a sibling directory.

2. **Update the import path for `db`** -- change `from "../../lib/media/db"` to the correct relative path from the new location. Since `e2e-cli/` is at the same depth as `integration/`, the path stays `../../lib/media/db`.

3. **Keep all existing tests.** The plan mentions simplifying stats/query/show tests that just verify API response shapes, but only if section-01's API route integration tests are already green. Since section-03 is parallelizable with section-01 (no dependency), keep all tests as-is during the move. Simplification can happen in section-04 if both sections are complete.

4. **Do not change test logic.** This is a pure reclassification -- same tests, new location, new tier name.

### Step 5: Move and rename sitemgr-e2e.test.ts

Source: `/home/user/sitemgr/web/__tests__/integration/sitemgr-e2e.test.ts`
Destination: `/home/user/sitemgr/web/__tests__/e2e-cli/sitemgr-pipeline.test.ts`

Changes to make during the move:

1. **Update the import path for `setup`** -- change `from "./setup"` to `from "../integration/setup"`.

2. **Update the import path for `s3`** -- the path `../../lib/media/s3` remains the same relative depth from the new location.

3. **Keep all existing tests and the Ollama health check.** The pipeline test has a `beforeAll` that checks Ollama at `localhost:11434` and throws a clear error if it is unavailable.

4. **Keep all existing timeouts.** The pipeline test uses up to 300,000ms for enrichment -- these are correct for CPU-bound Ollama processing.

### Step 6: Delete old files from integration

After the new files are in place and passing, delete the originals:

- Delete `/home/user/sitemgr/web/__tests__/integration/sitemgr-cli.test.ts`
- Delete `/home/user/sitemgr/web/__tests__/integration/sitemgr-e2e.test.ts`

### Step 7: Verify sitemgr-cli-auth.test.ts stays put

The file `/home/user/sitemgr/web/__tests__/sitemgr-cli-auth.test.ts` is NOT moved. It performs static analysis of source code (not CLI subprocess testing) and correctly belongs in the unit tier. Confirm it is not in the integration directory and is not affected by this change.

### What NOT to move

- `/home/user/sitemgr/web/__tests__/unit/sitemgr-login-command.test.ts` -- stays as unit test (tests pure logic)
- `/home/user/sitemgr/web/__tests__/sitemgr-cli-auth.test.ts` -- stays as unit test (static analysis)

## Verification Checklist

After all steps are complete, run these commands from `/home/user/sitemgr/web`:

1. `npm run test` -- unit tests pass, does NOT include e2e-cli tests
2. `npm run test:integration` -- integration tests pass, no longer includes CLI subprocess tests
3. `npm run test:e2e:cli` -- new tier runs the moved CLI tests successfully
4. `npm run typecheck` -- no type errors from import path changes
5. `npm run test:all` -- runs all three vitest projects (unit + integration + e2e-cli)

## Files Modified/Created Summary

| File | Action |
|------|--------|
| `/home/user/sitemgr/web/__tests__/e2e-cli/sitemgr-commands.test.ts` | Create (moved from integration) |
| `/home/user/sitemgr/web/__tests__/e2e-cli/sitemgr-pipeline.test.ts` | Create (moved from integration) |
| `/home/user/sitemgr/web/vitest.config.ts` | Modify (add e2e-cli project, add unit exclusion) |
| `/home/user/sitemgr/web/package.json` | Modify (add test:e2e:cli script) |
| `/home/user/sitemgr/web/__tests__/integration/sitemgr-cli.test.ts` | Delete |
| `/home/user/sitemgr/web/__tests__/integration/sitemgr-e2e.test.ts` | Delete |