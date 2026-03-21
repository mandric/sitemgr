I now have all the information needed to generate the section content.

# Section 03: Fix `scripts/setup.sh`

## Overview

This section adds strict mode and a batch prerequisite check to `scripts/setup.sh`. Currently the script has only `set -e` (not strict mode), checks prerequisites one at a time stopping at the first failure, and does not check for `supabase`, `docker`, or `jq` at all. The goal is to give developers a clear picture of everything that is missing before any side effects run.

This section has no dependencies on other sections and can be implemented in parallel with sections 01, 04, 05, 06, and 09.

---

## File to Modify

`/Users/mandric/dev/github.com/mandric/sitemgr/scripts/setup.sh`

---

## Tests (Manual Verification)

Shell scripts have no unit test framework. Verification is manual, using the sequences below. Run these after implementing the changes.

```bash
# Test: all missing tools are reported at once, not one at a time
# Simulate a PATH without supabase, docker, and jq to confirm all three appear in output
PATH_WITHOUT_TOOLS=$(echo "$PATH" | tr ':' '\n' | grep -v "supabase\|docker\|jq" | tr '\n' ':')
PATH=$PATH_WITHOUT_TOOLS ./scripts/setup.sh 2>&1 | grep -E "supabase|docker|jq"
# Expected: all three tool names appear in the error output before the script exits

# Test: missing supabase produces actionable error with install hint
PATH_WITHOUT_SUPABASE=$(echo "$PATH" | tr ':' '\n' | grep -v "supabase" | tr '\n' ':')
PATH=$PATH_WITHOUT_SUPABASE ./scripts/setup.sh 2>&1 | grep "brew install supabase"

# Test: missing jq produces actionable error with install hint
PATH_WITHOUT_JQ=$(echo "$PATH" | tr ':' '\n' | grep -v "/jq" | tr '\n' ':')
PATH=$PATH_WITHOUT_JQ ./scripts/setup.sh 2>&1 | grep "brew install jq"

# Test: node version check rejects older versions
# (temporarily stub a low-version node or test the logic manually)
# Confirm that node <20 produces a version error, not a command-not-found error

# Test: script exits non-zero when any prereq is missing
PATH_WITHOUT_SUPABASE=$(echo "$PATH" | tr ':' '\n' | grep -v "supabase" | tr '\n' ':')
PATH=$PATH_WITHOUT_SUPABASE ./scripts/setup.sh; echo "exit: $?"
# Expected: exit code is non-zero

# Test: script succeeds (exit 0) when all prereqs present and web deps install
./scripts/setup.sh; echo "exit: $?"
```

---

## Implementation

### What to Change in `scripts/setup.sh`

**1. Replace `set -e` with full strict mode at the top of the file:**

```bash
set -euo pipefail
IFS=$'\n\t'
```

**2. Add a `check_prerequisites` function** that collects all missing tools into an array, then reports them all before exiting. This replaces the current pattern of checking and exiting on each tool one at a time.

The function must:
- Collect every missing/failing tool into an accumulator (e.g. a `missing` array)
- Print all missing tools to stderr before exiting
- Exit non-zero only after the full sweep is done

Tools to check, with their error messages and install hints:

| Tool | Check | Error hint |
|---|---|---|
| `supabase` | `command -v supabase` | `brew install supabase/tap/supabase` |
| `docker` | `command -v docker` | `https://docs.docker.com/get-docker/` |
| `node` | `command -v node` + version ≥ 20 | `https://nodejs.org/` (with found-version detail) |
| `npm` | `command -v npm` | (no special hint needed) |
| `jq` | `command -v jq` | `brew install jq` |

Node version check: extract the major version from `node -v` and compare to 20. If node is present but too old, add to missing with the found version in the message (e.g. `node 20+ required (found v18.x.x)`).

**3. Call `check_prerequisites` before any side effects** (before `cd web && npm install`).

**4. Keep everything else:** the banner, `npm install`, the "Next steps" output. The only structural change is adding strict mode + the prerequisite sweep.

---

## Resulting Script Structure (Prose Outline)

```
#!/bin/bash
# ... header comment ...

set -euo pipefail
IFS=$'\n\t'

# ... banner ...

check_prerequisites() {
  # declare local missing array
  # for each tool: check, append to missing with hint on failure
  # node: check presence AND major version >= 20
  # if missing is non-empty: print all to stderr, return 1
}

check_prerequisites

echo "Found Node.js $(node -v)"
echo "Found npm $(npm -v)"

# Install web dependencies
cd web && npm install && cd ..

# ... completion banner and next steps ...
```

The function should not `exit` directly — it should return a non-zero status and let `set -e` propagate the failure. This keeps the function testable in isolation.

---

## Acceptance Criteria

- `set -euo pipefail` and `IFS=$'\n\t'` are present at the top
- A missing `supabase` does not prevent the script from also reporting missing `jq` or `docker`
- Each missing tool message includes an actionable install instruction
- Error messages go to stderr (`>&2`)
- The script exits non-zero when any prerequisite is missing
- The script exits zero when all prerequisites are satisfied and `npm install` succeeds
- No `supabase status`, curl, or bucket creation logic is added (those belong in `local-dev.sh`)