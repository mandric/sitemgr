# Code Review Interview: section-03-setup-sh

## Auto-fixes applied (no user input needed)

### Fix 1: Guard node_major arithmetic with regex check
Added `[[ "$node_major" =~ ^[0-9]+$ ]]` before `[ "$node_major" -lt 20 ]` to prevent
an opaque `integer expression expected` crash under `set -euo pipefail` when node -v
outputs an unexpected format. Non-numeric output now appends a clean diagnostic message
to the `missing` array consistent with all other prereq failures.
