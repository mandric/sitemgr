# Code Review: section-03-setup-sh

## Issues Found

### 1. Non-numeric `node_major` causes opaque arithmetic error (confidence: 82) — Auto-fixed

`[ "$node_major" -lt 20 ]` crashes with `integer expression expected` under `set -euo pipefail`
if `node -v | sed ... | cut ...` returns an empty or non-numeric string. This produces a cryptic
error instead of a clean diagnostic in the `missing` array.

**Fix:** Added `[[ "$node_major" =~ ^[0-9]+$ ]]` guard before the arithmetic comparison.
Non-numeric output now appends a descriptive message to `missing[]` like the other prereq failures.
