Now I have all the context needed. Let me produce the section content.

# Section 2: Update Library Code (env var reads)

## Overview

This section updates three library source files that read `SMGR_*` environment variables or use the `smgr` CLI name in user-facing messages. These are small, targeted replacements -- each file has only 2-3 occurrences.

**Dependencies:** None. This section can be implemented in parallel with section-01 (CLI binary) and section-04 (scripts/CI/config). However, section-03 (tests) depends on this section being complete before tests will pass.

**Substring hazard reminder:** The string `smgr` appears inside the existing word `sitemgr` (e.g., `~/.sitemgr/`). Never use unbounded `smgr` to `sitemgr` replacement. Only replace `SMGR_` prefix matches and standalone `smgr` in specific string contexts. Verify no `sitesitemgr` appears after any replacement.

## Verification (No New Tests)

This is a rename operation. No new tests are needed. Existing unit and integration tests for `cli-auth` and `s3` will validate correctness after section-03 updates the test files to use the new env var names.

**Post-implementation checks to run:**

```bash
# Must return zero results
grep -rn "SMGR_" /home/user/sitemgr/web/lib/

# Must return zero results
grep -rn "'smgr " /home/user/sitemgr/web/lib/

# Must return zero results (no double-replacement)
grep -rn "sitesitemgr" /home/user/sitemgr/web/lib/ /home/user/sitemgr/web/instrumentation.ts
```

## File 1: `/home/user/sitemgr/web/lib/auth/cli-auth.ts`

This file has 3 occurrences to change:

1. **Line 79 (JSDoc comment):** `SMGR_WEB_URL` in the docstring for `resolveApiConfig()` -- change to `SITEMGR_WEB_URL`.

2. **Line 81 (`process.env` read):** `process.env.SMGR_WEB_URL` -- change to `process.env.SITEMGR_WEB_URL`.

3. **Line 82 (error message):** `"SMGR_WEB_URL is required"` -- change to `"SITEMGR_WEB_URL is required"`.

4. **Line 119 (error message):** `"Please run 'smgr login' again."` -- change to `"Please run 'sitemgr login' again."`.

5. **Line 139 (error message):** `"Please run 'smgr login' again."` -- change to `"Please run 'sitemgr login' again."`.

**What NOT to change:** The config directory `~/.sitemgr/` on line 5 and line 15 is already correct. Do not touch those lines.

## File 2: `/home/user/sitemgr/web/lib/media/s3.ts`

This file has 2 occurrences to change, both in the `createS3Client` function:

1. **Line 36:** `process.env.SMGR_S3_ENDPOINT` -- change to `process.env.SITEMGR_S3_ENDPOINT`.

2. **Line 37:** `process.env.SMGR_S3_REGION` -- change to `process.env.SITEMGR_S3_REGION`.

No other lines in this file reference `smgr` or `SMGR_`.

## File 3: `/home/user/sitemgr/web/instrumentation.ts`

This file has 2 occurrences to change, both console error prefixes:

1. **Line 29:** `"[smgr] WARNING: Missing environment variables: ..."` -- change prefix to `"[sitemgr] WARNING: ..."`.

2. **Line 32:** `"[smgr] Some features will not work."` -- change prefix to `"[sitemgr] Some features will not work."`.

## Implementation Approach

For each file, perform targeted find-and-replace:

- Replace `SMGR_WEB_URL` with `SITEMGR_WEB_URL` (env var name in code and strings)
- Replace `SMGR_S3_ENDPOINT` with `SITEMGR_S3_ENDPOINT`
- Replace `SMGR_S3_REGION` with `SITEMGR_S3_REGION`
- Replace `'smgr login'` with `'sitemgr login'` (user-facing error messages)
- Replace `[smgr]` with `[sitemgr]` (console log prefix)

After all replacements, run the post-implementation grep checks above to confirm zero remaining `SMGR_` references in `web/lib/` and zero `sitesitemgr` corruptions.