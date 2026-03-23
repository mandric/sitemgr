<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: npx vitest run
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-constants
section-02-fix-filter
section-03-fix-fixtures
section-04-verification
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-constants | - | section-02, section-03 | Yes |
| section-02-fix-filter | section-01 | section-04 | Yes |
| section-03-fix-fixtures | section-01 | section-04 | Yes |
| section-04-verification | section-02, section-03 | - | No |

## Execution Order

1. section-01-constants (no dependencies)
2. section-02-fix-filter, section-03-fix-fixtures (parallel after section-01)
3. section-04-verification (after section-02 AND section-03)

## Section Summaries

### section-01-constants
Export named content type label constants (`CONTENT_TYPE_PHOTO`, etc.) from `web/lib/media/constants.ts`. Update `CONTENT_TYPE_MAP` to use these constants. Update existing raw string references in `db.ts` (`contentTypeCounts["photo"]` and `.eq("content_type", "photo")` in `getPendingEnrichments()`).

### section-02-fix-filter
Add optional `contentType` parameter to `getEnrichStatus()` with `CONTENT_TYPE_PHOTO` default. Apply `.eq("content_type", contentType)` filter to events query. Add `Math.max(0, ...)` guard to pending calculation.

### section-03-fix-fixtures
Update integration test fixtures to use content type constants instead of MIME type strings. Fix `seedUserData()` in `setup.ts`, fixture values and assertions in `media-lifecycle.test.ts`, and enrichment count expectations.

### section-04-verification
Run integration tests locally (`media-lifecycle.test.ts`, `smgr-cli.test.ts`). Grep for remaining MIME-type strings. Push and monitor CI.
