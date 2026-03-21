# Section 08: Vitest Configuration Consolidation

## Overview

Replace the three separate vitest config files with a single `vitest.config.ts` using Vitest 4.x `projects` feature. This enables running unit and integration tests from a single config with `--project` flag for selective execution.

## Context

The project currently has three vitest configs:
- `web/vitest.config.ts` — unit tests (default 5s timeout, excludes integration files)
- `web/vitest.integration.config.ts` — DB/security tests (30s timeout, includes rls-policies, rpc-user-isolation, migration-integrity)
- `web/vitest.media-integration.config.ts` — media tests (60s timeout, includes media-*.test.ts)

The installed Vitest version is `^4.0.18`. The `projects` feature (introduced in 3.2) enables defining multiple test configurations in a single file.

**Prerequisites from earlier sections:**
- Sections 04-07: All 4 new test suites exist in `web/__tests__/integration/`
- Section 02: `globalSetup.ts` exists

## What to Build

### Rewrite: `web/vitest.config.ts`

Replace the current unit-only config with a `projects`-based config defining two projects:

**Project "unit":**
- `include`: All test files except integration and e2e
- `exclude`: `__tests__/integration/**`, `e2e/**`, `node_modules/**`
  - Note: The old exclusions for `rls-policies.test.ts`, `rpc-user-isolation.test.ts`, `migration-integrity.test.ts`, `rls-audit.test.ts` are no longer needed since those files will be deleted in section-10
  - However, until section-10 runs, these files still exist — so either exclude them explicitly or wait until section-10 deletes them. Safer to include explicit exclusions that can be removed later.
- `testTimeout`: default (5000ms)
- `environment`: 'node'
- `globals`: true
- Path alias: `@` → `process.cwd()`

**Project "integration":**
- `include`: `__tests__/integration/**/*.test.ts`
- `testTimeout`: 60000 (60s — unified for all integration suites including S3)
- `hookTimeout`: 30000 (30s for beforeAll/afterAll)
- `environment`: 'node'
- `globals`: true
- `globalSetup`: `__tests__/integration/globalSetup.ts`
- `fileParallelism`: false (tests share the Supabase instance, must run sequentially)
- `sequence`: Configure to run `schema-contract.test.ts` first. Use Vitest's `sequence.sequencer` or `sequence.files` option to prioritize files starting with "schema-" before others. Check Vitest 4.x docs for exact syntax.
- Path alias: `@` → `process.cwd()`

**Important:** Verify the `projects` configuration syntax works with Vitest 4.x. The config structure:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,  // inherits root config
        test: {
          name: 'unit',
          include: [...],
          exclude: [...],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['__tests__/integration/**/*.test.ts'],
          testTimeout: 60000,
          hookTimeout: 30000,
          globalSetup: ['__tests__/integration/globalSetup.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
```

If `extends` or `projects` syntax doesn't work as documented, fall back to Vitest workspace files or separate project configs. Test locally before committing.

### Update: `web/package.json` scripts

```json
{
  "test": "vitest run --project unit",
  "test:integration": "vitest run --project integration",
  "test:all": "vitest run",
  "test:watch": "vitest --project unit"
}
```

Remove the old `test:media-integration` script.

### Files to Delete (deferred to section-10)

- `web/vitest.integration.config.ts`
- `web/vitest.media-integration.config.ts`

These are not deleted in this section — section-10 handles cleanup. The new config supersedes them via the `--project` flag.

## Tests to Write First

Manual verification:
- Verify: `vitest run --project unit` runs only unit tests (no integration files)
- Verify: `vitest run --project integration` runs all 4 integration suites
- Verify: `vitest run` runs both projects
- Verify: schema-contract runs first in the integration project
- Verify: `npm test` still works (unit tests only)
- Verify: `npm run test:integration` works (integration tests only)

## Files to Create/Modify

| File | Action |
|------|--------|
| `web/vitest.config.ts` | REWRITE |
| `web/package.json` | MODIFY — update test scripts |

## Acceptance Criteria

1. Single `vitest.config.ts` with two named projects
2. `--project unit` runs only unit tests
3. `--project integration` runs all 4 integration suites with 60s timeout
4. `globalSetup` registered for integration project only
5. `fileParallelism: false` for integration project
6. Schema-contract tests run first in the integration suite
7. npm scripts updated: `test`, `test:integration`, `test:all`, `test:watch`
8. `test:media-integration` script removed
