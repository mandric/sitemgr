Now I have all the information needed.

# Section 5: Update Documentation

## Background

This is the final section of the `smgr` to `sitemgr` rename. All source code, tests, scripts, and CI configuration have already been updated by sections 1-4. This section updates the mutable documentation files to reflect the new CLI name and environment variable prefix.

**Dependencies:** Sections 1 and 4 must be completed first. Section 1 renamed the CLI binary and npm script. Section 4 updated scripts and CI config. This section documents the final state.

**Critical constraint:** Files under `specs/` are immutable historical records and must NOT be modified.

**Substring hazard:** The string `smgr` appears inside the word `sitemgr`. Never do an unbounded find-replace. Use targeted replacements: `SMGR_` to `SITEMGR_`, `npm run smgr` to `npm run sitemgr`, `bin/smgr.ts` to `bin/sitemgr.ts`, `smgr CLI` to `sitemgr CLI`, and standalone `smgr` only in known CLI-name contexts.

## Tests

No new tests are needed for documentation changes. The verification is a post-implementation grep check.

**Post-implementation checks:**

Run from `/home/user/sitemgr`:

```bash
grep -rn "SMGR_\|npm run smgr\|bin/smgr" README.md docs/TESTING.md CLAUDE.md
```

This must return zero results.

Additionally, verify no double-replacement corruption:

```bash
grep -rn "sitesitemgr" README.md docs/TESTING.md CLAUDE.md
```

This must also return zero results.

## Implementation

### File 1: `/home/user/sitemgr/README.md`

Four areas need updating (lines referenced from current file content):

1. **Quick start command** (line 18): `npm run smgr stats` to `npm run sitemgr stats`
2. **Project tree** (line 36): `bin/smgr.ts` to `bin/sitemgr.ts` and update the comment if it says "smgr" standalone
3. **CLI usage examples** (lines 76-85): Four commands to update:
   - `npm run smgr stats` to `npm run sitemgr stats`
   - `npm run smgr query -- --search "beach" --format json` to `npm run sitemgr query -- --search "beach" --format json`
   - `npm run smgr watch` to `npm run sitemgr watch`
   - `npm run smgr enrich -- --pending` to `npm run sitemgr enrich -- --pending`

**Approach:** Targeted replacement of `npm run smgr` with `npm run sitemgr` and `bin/smgr.ts` with `bin/sitemgr.ts`. These are safe because they include sufficient context to avoid the substring hazard.

### File 2: `/home/user/sitemgr/docs/TESTING.md`

Three areas need updating:

1. **Env var debug example** (line 215): `$SMGR_S3_ENDPOINT` to `$SITEMGR_S3_ENDPOINT`
2. **Coverage table rows** (lines 284, 293): `smgr CLI (TypeScript)` to `sitemgr CLI (TypeScript)` -- two occurrences

**Approach:** Replace `SMGR_S3_ENDPOINT` with `SITEMGR_S3_ENDPOINT` (prefix match). Replace `smgr CLI` with `sitemgr CLI` (specific enough context to be safe).

### File 3: `/home/user/sitemgr/CLAUDE.md`

Two areas need updating:

1. **Test tiers table** (line 274): `` `smgr` subprocess `` to `` `sitemgr` subprocess ``
2. **Test infrastructure note** (line 300): `smgr-cli.test.ts` to `sitemgr-cli.test.ts` and `smgr-e2e.test.ts` to `sitemgr-e2e.test.ts`

**Approach:** These are standalone `smgr` references in backtick-quoted contexts. Replace the specific strings: `` `smgr` subprocess `` to `` `sitemgr` subprocess ``, `smgr-cli.test.ts` to `sitemgr-cli.test.ts`, `smgr-e2e.test.ts` to `sitemgr-e2e.test.ts`.

### Files NOT to modify

- **`specs/`** -- All files under `specs/` are immutable historical records per project convention. They will still contain `SMGR_` and `smgr` references and that is correct.
- **`design/`** -- Historical design artifacts, do not update.

## Verification Checklist

After all three files are updated:

1. Run `grep -rn "SMGR_\|npm run smgr\|bin/smgr" README.md docs/TESTING.md CLAUDE.md` from `/home/user/sitemgr` -- zero results
2. Run `grep -rn "sitesitemgr" README.md docs/TESTING.md CLAUDE.md` -- zero results
3. Run `grep -rn "\bsmgr\b" README.md docs/TESTING.md CLAUDE.md` -- zero results (no standalone `smgr` references remain)
4. From `/home/user/sitemgr/web`, run `npm run typecheck` and `npm run build` to confirm no build impact (docs changes should not affect these, but verify as a sanity check)