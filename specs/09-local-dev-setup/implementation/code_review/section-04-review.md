# Code Review: section-04-env-examples

## Issues Found

### 1. `DATABASE_URL` missing from `web/.env.example` (confidence: 95) — Auto-fixed

`print_setup_env_vars` outputs `DATABASE_URL` but it was absent from the new `web/.env.example`.
A developer using the file as reference would not know to include it.

**Fix:** Added `DATABASE_URL=` under the Supabase section.

## Checks Passed

- No deprecated `ENCRYPTION_KEY` bare name remains in either file
- No production secrets included (all values are empty placeholders)
- All vars from `print_setup_env_vars` now present in `web/.env.example` (after fix)
