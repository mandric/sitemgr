# Code Review: Section 03 - Fix Fixtures

1. **smgr-cli.test.ts still uses raw "photo" string (low).** Inconsistent but plan explicitly allowed it.
2. **Enrichment pending toBe(0) is strict (medium).** More brittle than toBeGreaterThanOrEqual but plan specified this change and comment explains preconditions.
3. **No negative test for video exclusion (low).** pending=0 indirectly confirms it but no explicit assertion.
4. All plan items accounted for, no extraneous changes.
