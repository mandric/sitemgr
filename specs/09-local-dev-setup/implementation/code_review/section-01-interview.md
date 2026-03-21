# Code Review Interview: section-01-local-dev-sh

## Auto-fixes applied (no user input needed)

### Fix 1: Operator precedence + `set -e` on validation block
Wrapped each validation check in `if` guards so the expression never evaluates to a bare
exit-1 under `set -e`:
```bash
if [ -z "$api_url" ] || [ "$api_url" = "null" ]; then missing+=("API_URL"); fi
```

### Fix 2: Validate before printing
Moved all validation before the `cat <<EOF` heredoc so no partial output is emitted
to stdout (and thus no corrupted `.env.local`) when fields are missing.

### Fix 3: Propagate `supabase status` failures + add `jq` check
Removed `|| true` so `supabase status -o json` failures cause a clear error message
and exit. Added `jq` presence check at the top of `print_setup_env_vars` with an
actionable install hint.
