# Section 4: Update Scripts, CI, Config Files

## Background

The sitemgr project is renaming from `smgr` to `sitemgr` for all CLI names and environment variables. This section covers infrastructure files outside the source code and tests: shell scripts, CI workflows, Docker configuration, env examples, and Claude settings.

**Critical substring hazard:** The string `smgr` appears inside the word `sitemgr` (e.g., `~/.sitemgr/`, `sitemgr.internal`). Never use an unbounded `sed s/smgr/sitemgr/g` which would produce `sitesitemgr`. Use targeted prefix matching: `SMGR_` to `SITEMGR_`, `'smgr ` to `'sitemgr `, `bin/smgr.ts` to `bin/sitemgr.ts`. After every replacement, verify no `sitesitemgr` exists.

## Dependencies

This section has no dependencies on other sections and can be executed in parallel with sections 1 and 2. Section 5 (docs) depends on this section being complete.

## Tests

This is a rename operation across configuration files. There are no new tests to write. Validation is done via grep checks and the CI pipeline itself.

**Post-implementation verification checks (run from repo root):**

1. Zero remaining `SMGR_` references in infrastructure files:
   ```
   grep -rn "SMGR_" scripts/ .github/ Dockerfile web/.env.example .claude/settings.json
   ```
   Must return zero results.

2. Zero `sitesitemgr` double-replacement errors:
   ```
   grep -rn "sitesitemgr" scripts/ .github/ Dockerfile web/.env.example .claude/settings.json
   ```
   Must return zero results.

3. The `scripts/lib.sh` env var generation block produces `SITEMGR_*` variable names (verify by reading the output of the function or inspecting the file).

4. CI workflow (`ci.yml`) references only `SITEMGR_*` vars.

## Implementation

### File 1: `/home/user/sitemgr/scripts/lib.sh`

**Env var generation block (~lines 226-236).** Rename every `SMGR_` prefix to `SITEMGR_`:

| Old | New |
|-----|-----|
| `SMGR_API_URL` | `SITEMGR_API_URL` |
| `SMGR_API_KEY` | `SITEMGR_API_KEY` |
| `SMGR_WEB_URL` | `SITEMGR_WEB_URL` |
| `SMGR_S3_ENDPOINT` | `SITEMGR_S3_ENDPOINT` |
| `SMGR_S3_BUCKET` | `SITEMGR_S3_BUCKET` |
| `SMGR_S3_REGION` | `SITEMGR_S3_REGION` |
| `SMGR_DEVICE_ID` | `SITEMGR_DEVICE_ID` |
| `SMGR_AUTO_ENRICH` | `SITEMGR_AUTO_ENRICH` |

**Warning message (~line 220).** Change:
```
CLI 'smgr login'
```
to:
```
CLI 'sitemgr login'
```

### File 2: `/home/user/sitemgr/scripts/setup/verify.sh`

Five references to update (lines 26, 27, 29, 41, 42):

- Line 26: `SMGR_API_URL` in variable read becomes `SITEMGR_API_URL`
- Line 27: `SMGR_API_KEY` in variable read becomes `SITEMGR_API_KEY`
- Line 29: Error message string `SMGR_API_URL` becomes `SITEMGR_API_URL`
- Line 41: `check_var "SMGR_API_URL"` becomes `check_var "SITEMGR_API_URL"`
- Line 42: `check_var "SMGR_API_KEY"` becomes `check_var "SITEMGR_API_KEY"`

### File 3: `/home/user/sitemgr/scripts/test-integration.sh`

Two changes:

- Line 3 comment: `smgr integration tests` to `sitemgr integration tests`
- Line 113: exclusion pattern `smgr-e2e.test.ts` to `sitemgr-e2e.test.ts`

### File 4: `/home/user/sitemgr/.github/workflows/ci.yml`

Six references to update:

- Line 97: `SMGR_DEVICE_ID=ci-test` becomes `SITEMGR_DEVICE_ID=ci-test`
- Line 98: `SMGR_AUTO_ENRICH=true` becomes `SITEMGR_AUTO_ENRICH=true`
- Line 99: `SMGR_OLLAMA_URL=http://localhost:11434` becomes `SITEMGR_OLLAMA_URL=http://localhost:11434`
- Line 100: `SMGR_VISION_MODEL=moondream:1.8b` becomes `SITEMGR_VISION_MODEL=moondream:1.8b`
- Line 103: `${{ env.SMGR_API_URL }}` becomes `${{ env.SITEMGR_API_URL }}`
- Line 128: `${{ env.SMGR_API_URL }}` becomes `${{ env.SITEMGR_API_URL }}`

**Note:** The CI workflow does not set `SMGR_API_URL` directly in this file; it is presumably set by an earlier step (e.g., from `scripts/lib.sh`). The `env.SMGR_API_URL` references just read whatever was exported. Both the generation in `lib.sh` (file 1 above) and the consumption here must be renamed together.

### File 5: `/home/user/sitemgr/web/.env.example`

Three changes:

- Line 13: `SMGR_WEB_URL=http://localhost:3000` becomes `SITEMGR_WEB_URL=http://localhost:3000`
- Line 15: Section header comment `# ── smgr CLI ─────` becomes `# ── sitemgr CLI ───` (adjust dashes to maintain alignment if desired, but not strictly required)
- Line 16: `SMGR_DEVICE_ID=local-dev` becomes `SITEMGR_DEVICE_ID=local-dev`

**Leave untouched:** Line 26 (`webhook@sitemgr.internal`) already uses the correct name.

### File 6: `/home/user/sitemgr/Dockerfile`

Three changes:

- Line 16: `ENV SMGR_DEVICE_ID=docker` becomes `ENV SITEMGR_DEVICE_ID=docker`
- Line 17: `ENV SMGR_S3_REGION=us-east-1` becomes `ENV SITEMGR_S3_REGION=us-east-1`
- Line 20: `CMD ["bin/smgr.ts", "watch", "--once"]` becomes `CMD ["bin/sitemgr.ts", "watch", "--once"]`

### File 7: `/home/user/sitemgr/.claude/settings.json`

One change:

- Line 9: `"Bash(npm run smgr*)"` becomes `"Bash(npm run sitemgr*)"`

## Implementation Approach

For each file, use targeted sed replacements with the `SMGR_` prefix pattern and specific known standalone `smgr` contexts. The recommended approach:

1. For env var prefixes: `sed -i 's/SMGR_/SITEMGR_/g'` (safe because `SITEMGR_` does not contain `SMGR_` as a false positive -- `SITEMGR_` has the prefix `SITE` before `MGR`)
2. For the `bin/smgr.ts` path: `sed -i 's|bin/smgr\.ts|bin/sitemgr.ts|g'`
3. For the CLI name in strings: target specific patterns like `'smgr ` and `"smgr "`
4. For `npm run smgr`: `sed -i 's/npm run smgr/npm run sitemgr/g'`

After all replacements, run the verification grep checks listed in the Tests section above to confirm no `SMGR_` references remain and no `sitesitemgr` was introduced.

## Note on `.env.local`

The `.env.local` file used in local development is auto-regenerated by `scripts/lib.sh` via `npm run setup:env`. Once `lib.sh` is updated (file 1), running `npm run setup:env` will produce a `.env.local` with the new `SITEMGR_*` variable names. No manual intervention is needed for local dev environments.