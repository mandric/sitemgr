# Code Review Interview: Section 02 - Fix Filter

## Triage

| Finding | Decision | Rationale |
|---------|----------|-----------|
| 1. Magic strings in tests | Auto-fix | Used local constants matching values from constants.ts (static import not supported in this test file's module resolution) |
| 2. Shared mutable callCount | Let go | Standard pattern in existing tests, refactoring mock infra out of scope |
| 3. No events-specific assertion | Let go | Would require mock infra redesign; production code is correct |
| 4. Phone-migration-app test | Let go | Plan says "should", existing mock chain handles extra .eq() without breaking |

## Auto-fixes Applied

- Added `CONTENT_TYPE_PHOTO` and `CONTENT_TYPE_VIDEO` local constants to test file (mirrors values from `@/lib/media/constants`)
- Updated assertions to use constants instead of bare strings
- Verified all 29 tests pass
