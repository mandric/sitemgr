I now have everything I need to write the section.

# Section 1: Rename CLI Binary and Update npm Script

## Background

The sitemgr project uses `smgr` as the CLI binary name and npm script, but the project itself is named `sitemgr` (repo name, config directory `~/.sitemgr/`). This section renames the CLI binary file and updates all internal references so the CLI is invoked as `sitemgr` everywhere.

This is a pre-launch project, so no backwards compatibility shim is needed.

### Critical: Substring Hazard

The string `smgr` appears inside the existing word `sitemgr` (e.g., `~/.sitemgr/`, `sitemgr.internal`). A naive global replace of `smgr` with `sitemgr` would produce `sitesitemgr`. All replacements must be targeted:

- Replace `SMGR_` with `SITEMGR_` (prefix match for env vars)
- Replace standalone `smgr` only in specific known contexts (CLI name in strings, comments, help text)
- After all replacements, verify zero occurrences of `sitesitemgr`

## Dependencies

None. This section can be implemented first. Section 3 (tests) depends on this section being complete.

## Files to Modify

1. **`/home/user/sitemgr/web/bin/smgr.ts`** -- rename to `/home/user/sitemgr/web/bin/sitemgr.ts` via `git mv`
2. **`/home/user/sitemgr/web/package.json`** -- update npm script entry

## Tests

This is a rename operation. No new tests are needed. The existing test suite validates correctness after Section 3 updates the test files.

### Pre-implementation baseline check

Before starting, confirm the current binary works:

```bash
cd /home/user/sitemgr/web && npm run smgr -- --help
```

This should produce help text containing `smgr login`, `smgr bucket`, etc.

### Post-implementation verification checks

After completing this section, run these checks:

1. **New script works:**
   ```bash
   cd /home/user/sitemgr/web && npm run sitemgr -- --help
   ```
   Output should contain `sitemgr login`, `sitemgr bucket`, `sitemgr watch`, etc.

2. **Old script removed:**
   ```bash
   cd /home/user/sitemgr/web && npm run smgr 2>&1
   ```
   Should fail with npm "missing script" error.

3. **No double-replacement corruption:**
   ```bash
   grep -r "sitesitemgr" /home/user/sitemgr/web/bin/sitemgr.ts
   ```
   Must return zero results.

4. **No remaining SMGR_ env vars in the binary:**
   ```bash
   grep "SMGR_" /home/user/sitemgr/web/bin/sitemgr.ts
   ```
   Must return zero results.

5. **No remaining standalone smgr CLI references:**
   ```bash
   grep -n "'smgr \|\"smgr " /home/user/sitemgr/web/bin/sitemgr.ts
   ```
   Must return zero results (note: `sitemgr` contains `smgr` as a substring, so grep for quoted/delimited standalone occurrences only).

## Implementation Details

### Step 1: Rename the file

Use `git mv` to preserve history:

```bash
cd /home/user/sitemgr/web && git mv bin/smgr.ts bin/sitemgr.ts
```

### Step 2: Update environment variable reads in `web/bin/sitemgr.ts`

Three env var references to rename (prefix match `SMGR_` to `SITEMGR_`):

| Line | Old | New |
|------|-----|-----|
| ~550 | `process.env.SMGR_WATCH_INTERVAL` | `process.env.SITEMGR_WATCH_INTERVAL` |
| ~558 | `process.env.SMGR_DEVICE_ID` | `process.env.SITEMGR_DEVICE_ID` |
| ~773-775 | `SMGR_WEB_URL`, `SMGR_DEVICE_ID`, `SMGR_WATCH_INTERVAL` in help text | `SITEMGR_WEB_URL`, `SITEMGR_DEVICE_ID`, `SITEMGR_WATCH_INTERVAL` |

### Step 3: Update standalone `smgr` references in strings, comments, and help text

There are approximately 41 occurrences of `smgr` in the file. These fall into categories:

**Comment header (lines 1-13):** Update the doc comment block. Change `smgr CLI` to `sitemgr CLI` and all `bin/smgr.ts` usage examples to `bin/sitemgr.ts`.

**Error messages referencing CLI commands:** Update strings like:
- `"Run 'smgr login' first."` to `"Run 'sitemgr login' first."`
- `"Run 'smgr login' to authenticate."` to `"Run 'sitemgr login' to authenticate."`
- `"Use 'smgr bucket add' to add one."` to `"Use 'sitemgr bucket add' to add one."`

**Usage strings in error messages:** Update patterns like:
- `"Usage: smgr bucket remove <bucket-name>"` to `"Usage: sitemgr bucket remove <bucket-name>"`
- `"Usage: smgr bucket test <bucket-name>"` to `"Usage: sitemgr bucket test <bucket-name>"`
- `"Usage: smgr show <event_id>"` to `"Usage: sitemgr show <event_id>"`
- `"Usage: smgr dedup <bucket>"` to `"Usage: sitemgr dedup <bucket>"`
- `"Usage: smgr enrich ..."` to `"Usage: sitemgr enrich ..."`
- `"Usage: smgr watch ..."` to `"Usage: sitemgr watch ..."`
- `"Usage: smgr add ..."` to `"Usage: sitemgr add ..."`

**Inline help block (lines ~128-134):** Update the bucket subcommand help listing.

**Main help text block (lines ~721-744):** This is the densest area with ~20 occurrences. Update every `smgr` to `sitemgr` in this block, including:
- The title line: `smgr — S3-event-driven media indexer` to `sitemgr — ...`
- Every command example: `smgr login`, `smgr logout`, `smgr whoami`, `smgr bucket list`, `smgr query`, `smgr show`, `smgr stats`, `smgr dedup`, `smgr enrich`, `smgr watch`, `smgr add`
- The auth instruction: `Run 'smgr login' to authenticate`

**Recommended approach:** Use a two-pass strategy:
1. First pass: replace `SMGR_` with `SITEMGR_` (safe prefix match, no risk of double-replacement)
2. Second pass: in the same file, replace standalone `smgr` that is NOT part of `sitemgr`. This can be done by matching patterns like `'smgr `, `"smgr `, `"smgr"`, word-boundary `\bsmgr\b` in string contexts, or simply reviewing and replacing each occurrence manually.

After both passes, verify zero occurrences of `sitesitemgr` in the file.

### Step 4: Update `web/package.json`

Change the npm script entry on line 19:

**Before:**
```json
"smgr": "tsx bin/smgr.ts"
```

**After:**
```json
"sitemgr": "tsx bin/sitemgr.ts"
```

### Step 5: Shebang line

The shebang line (`#!/usr/bin/env npx tsx`) on line 1 does not contain `smgr` and needs no change.

## Verification Summary

After completing all steps, run the post-implementation checks listed above. TypeCheck and lint can also be run to catch any issues:

```bash
cd /home/user/sitemgr/web && npm run typecheck && npm run lint
```

Note: Unit and integration tests will fail at this point because test files still reference the old binary path and env var names. That is expected and will be fixed in Section 3.