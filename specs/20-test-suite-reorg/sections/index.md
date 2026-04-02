<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: npm test
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-api-route-integration-tests
section-02-delete-mock-heavy-tests
section-03-reclassify-cli-tests
section-04-verification-cleanup
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-api-route-integration-tests | - | section-02 | Yes |
| section-02-delete-mock-heavy-tests | section-01 | section-04 | No |
| section-03-reclassify-cli-tests | - | section-04 | Yes |
| section-04-verification-cleanup | section-02, section-03 | - | No |

## Execution Order

1. section-01-api-route-integration-tests, section-03-reclassify-cli-tests (parallel, no dependencies between them)
2. section-02-delete-mock-heavy-tests (after section-01 — need integration coverage before deleting mocks)
3. section-04-verification-cleanup (after all others)

## Section Summaries

### section-01-api-route-integration-tests
Write new fetch()-based integration tests for API routes: buckets CRUD, events, stats, enrichments, health. Add `createTestUserWithToken()` helper to setup.ts. Tests use Bearer tokens against the running Next.js dev server.

### section-02-delete-mock-heavy-tests
Delete ~15 mock-heavy unit test files that are now covered by integration tests. Verify encryption-rotation coverage before deleting encryption-lifecycle. Split device-approve-form.test.ts (keep pure logic, delete mock-fetch). Delete agent-test-setup.ts helper.

### section-03-reclassify-cli-tests
Create `__tests__/e2e-cli/` directory. Add e2e-cli vitest project to vitest.config.ts. Add `__tests__/e2e-cli/**` to unit project exclusions. Move + merge sitemgr-cli.test.ts and sitemgr-e2e.test.ts into e2e-cli/. Add `npm run test:e2e:cli` script to package.json. Delete old files from integration/.

### section-04-verification-cleanup
Run all four test tiers + typecheck + lint + build. Delete any orphaned mock utilities. Fix any remaining failures. Ensure test:all picks up all vitest projects.
