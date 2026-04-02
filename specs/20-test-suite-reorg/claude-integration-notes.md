# Integration Notes: Opus Review Feedback

## Integrating

1. **WEB_PORT convention** — Fix apiFetch to use `WEB_PORT` instead of `WEB_BASE_URL`. Correct.
2. **Session null guard** — Add assertion in `createTestUserWithToken`. Good catch.
3. **sitemgr-cli-auth.test.ts location** — Correct, it's at top-level `__tests__/`, not integration/. It's static analysis → keep as unit test, don't move to e2e-cli.
4. **Unit exclusion ordering** — Move e2e-cli exclusion to Section 3 config work. Correct.
5. **device-approve-form.test.ts specificity** — Will be explicit: keep `parseCodeFromUrl` tests, delete `approveDevice` mock-fetch tests.
6. **supabase-client.test.ts contradiction** — Delete it. It mocks `@supabase/supabase-js` createClient — that's mock wiring, not pure logic.
7. **Test data cleanup strategy** — Mandate unique user per test file + afterAll cleanup. Already the pattern in setup.ts.
8. **Bucket test endpoint config** — Specify using `getS3Config()` values for test bucket config. Test expects 200 success with local Supabase S3.
9. **CI integration** — `test:all` runs `vitest run` which picks up all projects including e2e-cli. Confirm in plan.
10. **Execution order precision** — Run new test files individually in Step 2 before full suite.
11. **encryption-lifecycle.test.ts** — Verify encryption-rotation.test.ts covers rotation before deleting. Will check during implementation.

## NOT Integrating

1. **Event seeding strategy (#3)** — Admin inserts are the established pattern in this codebase (see `seedUserData`). Integration tests that test event routes should test the routes with known data, not create data through routes they're also testing. Admin seeding is correct here.
2. **`__tests__/unit/` consolidation (#14)** — Out of scope for this spec. The directory structure works as-is. Unit vitest project already picks up both locations.
3. **test:e2e naming confusion (#11)** — The naming is clear enough: `test:e2e` = Playwright web, `test:e2e:cli` = Vitest CLI. Both are documented in CLAUDE.md. No change needed.
