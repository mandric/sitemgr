<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: npm run test
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-cli-binary
section-02-lib-code
section-03-tests
section-04-scripts-ci-config
section-05-docs
END_MANIFEST -->

# Implementation Sections Index

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable |
|---------|------------|--------|----------------|
| section-01-cli-binary | - | section-03 | Yes |
| section-02-lib-code | - | section-03 | Yes |
| section-03-tests | section-01, section-02 | - | No |
| section-04-scripts-ci-config | - | section-05 | Yes |
| section-05-docs | section-01, section-04 | - | No |

## Execution Order

1. section-01-cli-binary, section-02-lib-code, section-04-scripts-ci-config (parallel — no dependencies between them)
2. section-03-tests (after 01 and 02 — tests reference the binary and lib code)
3. section-05-docs (after 01 and 04 — documents the final state)

## Section Summaries

### section-01-cli-binary
Rename `web/bin/smgr.ts` → `web/bin/sitemgr.ts`, update all internal string references (help text, error messages, env var reads), and update the npm script in `package.json`.

### section-02-lib-code
Update `web/lib/auth/cli-auth.ts`, `web/lib/media/s3.ts`, and `web/instrumentation.ts` to use `SITEMGR_*` env vars and `sitemgr` CLI name in messages.

### section-03-tests
Rename 4 test files (`smgr-*` → `sitemgr-*`), update all test files that reference `SMGR_*` env vars or spawn `bin/smgr.ts`, including non-renamed files like `cli-auth-device-flow.test.ts` and `device-auth.test.ts`. Run all tests to verify.

### section-04-scripts-ci-config
Update `scripts/lib.sh`, `scripts/setup/verify.sh`, `scripts/test-integration.sh`, `.github/workflows/ci.yml`, `web/.env.example`, `Dockerfile`, and `.claude/settings.json` to use `SITEMGR_*` vars.

### section-05-docs
Update `README.md`, `docs/TESTING.md`, and `CLAUDE.md` to reference `sitemgr` CLI and `SITEMGR_*` env vars. Skip immutable `specs/` files.
