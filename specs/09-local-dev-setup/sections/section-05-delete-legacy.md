I have enough information to generate the section content.

# Section 5: Delete Legacy Test Files

## Overview

This section removes stale files in `tests/` that reference a Python prototype that no longer exists. The TypeScript rewrite of the CLI made `tests/integration_test.sh`, `tests/seed_test_data.sh`, and `tests/README.md` obsolete. Keeping them creates confusion about which test runner is canonical. `docs/TESTING.md` also needs to be updated to point developers to the correct path.

This section has no dependencies on other sections and can be implemented in parallel.

---

## Background

The `tests/` directory was written when the CLI was a Python prototype (`prototype/smgr.py`). The CLI was later rewritten in TypeScript. The shell-based test runner was never updated and now references commands that do not exist. The authoritative integration test path is `./scripts/test-integration.sh`, which runs the vitest integration project under `web/__tests__/integration/`.

Additionally, `tests/` contains two TypeScript files (`edge_function_bucket_test.ts`, `edge_function_scan_test.ts`) that may or may not be referenced by CI. These require conditional handling.

---

## Tests / Verification Steps (Run Before and After Changes)

Before deleting anything, confirm that none of the files being removed are referenced by any CI workflow:

```bash
# Test: no CI workflows reference the files being deleted
grep -r "integration_test.sh" .github/ && echo "FAIL: still referenced" || echo "PASS"
grep -r "seed_test_data.sh" .github/ && echo "FAIL: still referenced" || echo "PASS"

# Test: edge function test files referenced by CI?
grep -r "edge_function_bucket_test\|edge_function_scan_test" .github/
```

If the `grep` commands for `edge_function_bucket_test` or `edge_function_scan_test` return matches, do NOT delete those files — leave them and note as a separate cleanup item.

After deleting the files, verify the remaining `tests/` directory structure is clean and nothing references the deleted files:

```bash
# Confirm files are gone
[ ! -f tests/integration_test.sh ] && echo "PASS" || echo "FAIL"
[ ! -f tests/seed_test_data.sh ] && echo "PASS" || echo "FAIL"
[ ! -f tests/README.md ] && echo "PASS" || echo "FAIL"

# Confirm docs/TESTING.md no longer points to deleted paths
grep "integration_test.sh" docs/TESTING.md && echo "FAIL: still referenced" || echo "PASS"
grep "seed_test_data.sh" docs/TESTING.md && echo "FAIL: still referenced" || echo "PASS"
grep "python3 prototype" docs/TESTING.md && echo "FAIL: Python prototype still referenced" || echo "PASS"
```

---

## Implementation

### Step 1: Pre-deletion CI check

Run the grep commands above against `.github/workflows/` before making any deletions. As of the current state of the repo, none of the four files (`integration_test.sh`, `seed_test_data.sh`, `edge_function_bucket_test.ts`, `edge_function_scan_test.ts`) are referenced in `.github/workflows/ci.yml`. Confirm this before proceeding.

### Step 2: Delete the legacy files

Delete the following files unconditionally (confirmed safe to remove):

- `/Users/mandric/dev/github.com/mandric/sitemgr/tests/integration_test.sh`
- `/Users/mandric/dev/github.com/mandric/sitemgr/tests/seed_test_data.sh`
- `/Users/mandric/dev/github.com/mandric/sitemgr/tests/README.md`

Delete the following files only if the CI grep check returns no matches (confirmed they are not referenced by CI):

- `/Users/mandric/dev/github.com/mandric/sitemgr/tests/edge_function_bucket_test.ts`
- `/Users/mandric/dev/github.com/mandric/sitemgr/tests/edge_function_scan_test.ts`

If the `tests/` directory becomes empty after deletion, it can be left in place (empty directories are benign) or removed — either is acceptable.

### Step 3: Update `docs/TESTING.md`

`/Users/mandric/dev/github.com/mandric/sitemgr/docs/TESTING.md` currently has extensive references to the legacy setup. The document is heavily Python/prototype-era and needs focused edits — do not rewrite the whole document; make targeted removals and replacements.

**Sections to update:**

**"Local Development" workflow block (around lines 63–79):** Replace the entire "Terminal 2" and "Terminal 3" block. The updated workflow should be:

```
# Terminal 1: Keep Supabase running
supabase start

# Terminal 2: Run integration tests
./scripts/test-integration.sh --skip-ollama
```

Remove the `python3 prototype/smgr.py watch` and `python3 prototype/bot.py --stdio` references.

**"Reset" block (around lines 81–85):** Replace:
```bash
supabase db reset         # Reset database to migrations
./tests/seed_test_data.sh # Re-populate with test data
```
With:
```bash
supabase db reset         # Wipes and replays all migrations; .env.local is unaffected
```
The `seed_test_data.sh` line is removed. No replacement is needed — integration tests manage their own data.

**"Integration Test Suite" section (around lines 119–165):** The `tests/integration_test.sh` table and "Running Tests" commands all reference the deleted file. Replace the "Running Tests" subsection with:

```
### Running Tests

**Integration tests (requires Supabase running):**
```bash
./scripts/test-integration.sh --skip-ollama
```

**With Ollama enrichment (optional):**
```bash
./scripts/test-integration.sh
```

**Unit tests only (no Supabase required):**
```bash
cd web && npm test
```
```

Remove the references to running individual `python3 prototype/smgr.py` commands.

**"Test Data Management" section (around lines 237–256):** Remove the `tests/seed_test_data.sh` references and the section describing what `seed_test_data.sh` does. Integration tests manage their own isolated test data per run — no manual seeding is needed.

**"Debugging Failed Tests" > "Run test commands manually" block (around lines 288–293):** Remove the `python3 prototype/smgr.py` commands. Replace with:
```bash
# Check environment
./scripts/setup/verify.sh

# Check Supabase logs
supabase logs
```

**Coverage metrics table (around lines 354–361):** Remove the `smgr.py CLI` and `bot.py` rows — those components no longer exist as Python. Leave the table or remove it entirely; it is not accurate and the new implementation is TypeScript. If kept, update component names to reflect the current TypeScript codebase (`smgr CLI (TypeScript)`, `Edge Function / API routes`).

**Note:** Do not feel obligated to salvage every section of `docs/TESTING.md`. If entire sections refer only to Python prototype workflows (e.g., "Deployment Testing" with `develop` branch Supabase cloud auto-deploy), they can be removed if they describe infrastructure that no longer exists. The key requirement is: after the update, no path in `docs/TESTING.md` should reference `tests/integration_test.sh`, `tests/seed_test_data.sh`, `prototype/smgr.py`, or `prototype/bot.py` as a test runner or tool the developer should run.

The canonical integration test path after this change is:
- `./scripts/test-integration.sh` — runs vitest integration project (sources `.env.local` automatically)

---

## Files to Delete

| File | Action |
|---|---|
| `tests/integration_test.sh` | Delete unconditionally |
| `tests/seed_test_data.sh` | Delete unconditionally |
| `tests/README.md` | Delete unconditionally |
| `tests/edge_function_bucket_test.ts` | Delete if not referenced by `.github/workflows/` |
| `tests/edge_function_scan_test.ts` | Delete if not referenced by `.github/workflows/` |

## Files to Modify

| File | Change |
|---|---|
| `docs/TESTING.md` | Remove all references to `tests/integration_test.sh`, `tests/seed_test_data.sh`, `python3 prototype/smgr.py`, `python3 prototype/bot.py`; update canonical test runner to `./scripts/test-integration.sh` |