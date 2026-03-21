# Code Review Interview: section-04-env-examples

## Auto-fixes applied (no user input needed)

### Fix 1: Add missing DATABASE_URL to web/.env.example
`print_setup_env_vars` outputs `DATABASE_URL` but it was absent from `web/.env.example`.
Added `DATABASE_URL=` under the Supabase section so the file documents all vars
the script produces.
