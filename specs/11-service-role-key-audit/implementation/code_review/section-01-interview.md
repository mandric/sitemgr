# Section 01 Code Review Interview

## Auto-fixes Applied

### 1. Distinguish curl connection failure from auth rejection
- **Finding**: When GoTrue is unreachable, curl returns status `000`, which produces a misleading "key rejected" error.
- **Fix**: Added explicit check for `000` status with a "Could not reach GoTrue" message before the existing HTTP status check.

### 2. Move beforeAll inside describe block
- **Finding**: `beforeAll` and `let output` were at module scope outside `describe`.
- **Fix**: Moved both inside the `describe("print_setup_env_vars")` block for proper scoping.

## Let Go

- **Capability probe test tautology**: The test documents intent per the plan, even though it's technically redundant.
- **No negative test for probe failure**: Can't easily test without mocking Supabase; not worth the complexity.
- **`__dirname` usage**: Current setup uses CommonJS-compatible transforms; no migration planned.
