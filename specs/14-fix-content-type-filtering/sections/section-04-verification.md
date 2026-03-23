# Section 4: Verification -- Run Tests Locally

## Overview

This section is the final verification step after all implementation changes from Sections 1-3 are complete. It involves running the integration test suite, scanning for leftover MIME-type strings in test fixtures, and pushing to CI. There are no code changes in this section -- it is purely a validation gate.

## Dependencies

- **Section 01 (constants):** Content type label constants must be exported from `web/lib/media/constants.ts`.
- **Section 02 (fix filter):** `getEnrichStatus()` must have the `contentType` parameter and `.eq("content_type", contentType)` filter applied.
- **Section 03 (fix fixtures):** All integration test fixtures must use the label constants (`CONTENT_TYPE_PHOTO`, `CONTENT_TYPE_VIDEO`) instead of MIME-type strings (`"image/jpeg"`, `"video/mp4"`).

All three sections must be fully implemented before this section can be executed.

## Tests

This section has no new test stubs. It is the test execution step itself. The tests being run were written or updated in Sections 2 and 3.

## Step 1: Start Local Supabase

Integration tests connect to a local Supabase instance. It must be running before tests execute.

```bash
cd /home/user/sitemgr
supabase start
```

Wait for the local instance to be healthy before proceeding. If it is already running, this step is a no-op.

## Step 2: Run media-lifecycle Integration Tests

Run the media lifecycle integration test file, which covers the core changes:

```bash
cd /home/user/sitemgr
npx vitest run web/__tests__/integration/media-lifecycle.test.ts
```

**What to look for in the output:**

- The test `"should return correct counts by content type"` passes. This validates that `stats_by_content_type()` returns keys matching the label constants (e.g., `"photo"`) rather than MIME-type keys (e.g., `"image/jpeg"`). This confirms Section 3 fixture changes are correct.
- The test `"should show correct pending and enriched counts"` passes. This validates that `getEnrichStatus()` filters by `content_type = "photo"` (Section 2 fix) and that the expected counts match the updated fixture data (Section 3). After the fix, with 2 photo events and 1 video event seeded, only the 2 photos count toward `total_media`. Both photos are enriched, so `pending` should be `0`.
- The `total_media === enriched + pending` identity holds.

If any test fails, check whether the failure is in the filter logic (Section 2) or the fixture values (Section 3) before debugging further.

## Step 3: Run smgr-cli Integration Tests

Run the CLI integration test file as a regression check:

```bash
cd /home/user/sitemgr
npx vitest run web/__tests__/integration/smgr-cli.test.ts
```

**What to look for:** This file already uses `content_type: "photo"` in its fixtures (not MIME types), so it should pass without changes. If it fails, the failure is unrelated to this spec and should be investigated separately.

## Step 4: Grep for Remaining MIME-Type Strings

Verify that no integration test fixture still uses MIME-type strings as `content_type` values. Run from the project root:

```bash
cd /home/user/sitemgr
grep -rn '"image/jpeg"\|"video/mp4"\|"audio/mpeg"' web/__tests__/integration/ --include='*.ts'
```

**Expected result:** No output (zero matches). If any matches appear, they indicate a fixture that was missed in Section 3 and must be updated to use the appropriate constant (`CONTENT_TYPE_PHOTO`, `CONTENT_TYPE_VIDEO`, `CONTENT_TYPE_AUDIO`).

Note: MIME-type strings may legitimately appear in non-fixture contexts (e.g., in comments explaining the mapping, or in `detectContentType()` unit tests that test the MIME-to-label conversion). The grep is scoped to `web/__tests__/integration/` to focus on integration test fixtures only.

## Step 5: Push and Monitor CI

After local verification passes:

1. Commit all changes from Sections 1-3.
2. Push to the feature branch.
3. Monitor the CI pipeline for green status on all integration tests.

CI runs the same Vitest integration suite against a local Supabase instance provisioned in the workflow. If CI fails but local tests pass, check for environment differences (Supabase version, seed data timing, etc.).

## Summary of Expected Outcomes

| Check | Expected Result |
|-------|----------------|
| `media-lifecycle.test.ts` | All tests pass |
| `smgr-cli.test.ts` | All tests pass |
| MIME-type grep in `web/__tests__/integration/` | Zero matches |
| CI pipeline | Green |

## Files Involved (Read-Only for This Section)

These files are not modified in this section but are the ones being verified:

- `/home/user/sitemgr/web/lib/media/constants.ts` -- label constants (Section 1)
- `/home/user/sitemgr/web/lib/media/db.ts` -- `getEnrichStatus()` filter fix (Section 2)
- `/home/user/sitemgr/web/__tests__/integration/setup.ts` -- `seedUserData()` fixture values (Section 3)
- `/home/user/sitemgr/web/__tests__/integration/media-lifecycle.test.ts` -- updated assertions (Section 3)
- `/home/user/sitemgr/web/__tests__/integration/smgr-cli.test.ts` -- regression check (no changes expected)