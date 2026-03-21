<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: cd web && npm run test:integration
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-e2e-timeout
section-02-dangling-handles
section-03-stats-guards
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-e2e-timeout | - | - | Yes |
| section-02-dangling-handles | - | - | Yes |
| section-03-stats-guards | - | - | Yes |

## Execution Order

1. section-01-e2e-timeout, section-02-dangling-handles, section-03-stats-guards (all parallel — no dependencies between them)

## Section Summaries

### section-01-e2e-timeout
Add explicit 60s timeout to `test.beforeAll()` in `web/e2e/agent.spec.ts` via options-object syntax. Fixes E2E CI failure caused by Mailpit email confirmation retry loop exceeding Playwright's default 30s hook timeout.

### section-02-dangling-handles
Add Supabase client cleanup (`removeAllChannels()` + `auth.signOut()` for authenticated clients) to afterAll in all 4 integration test files. Store previously-unstored Bob/userB clients. Hoist media-storage admin to module level. Add afterAll to schema-contract. Fixes "something prevents the main process from exiting" warning.

### section-03-stats-guards
Remove `if (data && data.length > 0)` silent-pass guards from `stats_by_content_type` and `stats_by_event_type` tests in `tenant-isolation.test.ts`. Add explicit `data!.length > 0` assertions to match the pattern already applied to `search_events`.
