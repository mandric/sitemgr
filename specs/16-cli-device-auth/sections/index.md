<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: cd web && npm run typecheck && npm run lint && npm run test && npm run test:integration && npm run build
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-db-migration
section-02-server-helpers
section-03-api-initiate
section-04-api-poll
section-05-api-approve
section-06-web-ui
section-07-cli-refactor
section-08-integration-tests
section-09-cleanup
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-db-migration | - | 03, 04, 05, 08 | Yes |
| section-02-server-helpers | - | 03, 04, 05, 07 | Yes |
| section-03-api-initiate | 01, 02 | 06, 07, 08 | No |
| section-04-api-poll | 01, 02 | 07, 08 | Yes (with 03) |
| section-05-api-approve | 01, 02 | 06, 08 | Yes (with 03, 04) |
| section-06-web-ui | 05 | 08 | No |
| section-07-cli-refactor | 02, 03, 04 | 08 | Yes (with 06) |
| section-08-integration-tests | 01-07 | 09 | No |
| section-09-cleanup | 08 | - | No |

## Execution Order

1. **Batch 1:** section-01-db-migration, section-02-server-helpers (parallel — no dependencies)
2. **Batch 2:** section-03-api-initiate, section-04-api-poll, section-05-api-approve (parallel after batch 1)
3. **Batch 3:** section-06-web-ui, section-07-cli-refactor (parallel after batch 2)
4. **Batch 4:** section-08-integration-tests (after all above)
5. **Batch 5:** section-09-cleanup (final)

## Section Summaries

### section-01-db-migration
Create the `device_codes` table, indexes, RLS policies, and the `get_device_code_status()` RPC function. Migration file in `supabase/migrations/`.

### section-02-server-helpers
Utility functions for device code generation (64-char hex), user code generation (XXXX-XXXX format, safe charset), and the admin client helper for `generateLink()`. Located in `web/lib/auth/device-codes.ts`. Unit tests for code generation.

### section-03-api-initiate
`POST /api/auth/device` route — generates device code + user code, inserts into DB, returns verification URL. Includes expired-row cleanup. Unit tests.

### section-04-api-poll
`POST /api/auth/device/token` route — looks up device code via RPC function, returns status. On approved, returns token_hash + email then nulls token_hash (one-time retrieval). Unit tests.

### section-05-api-approve
`POST /api/auth/device/approve` route — authenticated endpoint. Validates user_code, calls `admin.generateLink()` via service role key, updates row. Unit tests.

### section-06-web-ui
`/auth/device` page — device code approval form. Pre-fills code from URL query param. Shows approve button, success/error states. Matches existing auth page design.

### section-07-cli-refactor
Replace `login()` in `cli-auth.ts` — remove prompt helpers, add device code flow (initiate, open browser, poll, verifyOtp, save credentials). Update `smgr.ts` command and usage text. Unit tests with mocked HTTP.

### section-08-integration-tests
Full end-to-end device auth flow against real local Supabase. Tests: complete happy path, expired code, invalid code, unauthenticated approve.

### section-09-cleanup
Update CLAUDE.md with service role key exception documentation. Remove any dead code. Final verification that all existing tests still pass.
