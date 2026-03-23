# Code Review: Section 02 - Fix Filter

1. **Tests use magic string literals instead of constants (low-medium).** Plan says to import CONTENT_TYPE_PHOTO/VIDEO in tests and assert against constants. Tests assert against bare "photo"/"video" strings.

2. **Shared mutable state in Math.max test (low).** Uses callCount to distinguish events vs enrichments query. Fragile if query order changes.

3. **No assertion that content_type filter applies only to events query (medium).** Both queries use same mock chain, so test can't verify filter is on events specifically.

4. **Plan mentions phone-migration-app test update but diff omits it (low).** Plan hedges with "should" so not a hard requirement.

Production code changes look correct and match the plan precisely.
