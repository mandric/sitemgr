# Section 09: CI Workflow Updates

## Overview

Update `.github/workflows/ci.yml` to use the consolidated vitest config. Merge two test commands into one, remove the inline FTS smoke test, and update npm scripts.

## Context

The CI workflow currently runs integration tests in 3 steps:
1. `cd web && npm run test:integration` (rls-policies, rpc-user-isolation, migration-integrity)
2. `cd web && npm run test:media-integration` (media-db, media-pipeline, media-s3)
3. Inline psql FTS smoke test (direct SQL insert + search_events call)

After the refactor, all 4 test suites run under a single `npm run test:integration` command via the `--project integration` vitest config.

**Prerequisites from earlier sections:**
- Section 08: `vitest.config.ts` with projects config, updated npm scripts

## What to Change

### `.github/workflows/ci.yml`

**Replace two test commands with one:**

Find the steps that run:
```yaml
- name: Run DB integration tests
  run: cd web && npm run test:integration

- name: Run media integration tests
  run: cd web && npm run test:media-integration
```

Replace with:
```yaml
- name: Run integration tests
  run: cd web && npm run test:integration
```

**Remove inline FTS smoke test:**

Find and delete the step that does:
```yaml
- name: FTS smoke test
  run: |
    PGURL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    psql "$PGURL" -c "INSERT INTO ..."
    ...
```

This test is now covered by:
- `media-lifecycle.test.ts` Group 1 (upload and search via FTS)
- `tenant-isolation.test.ts` Group 4 (RPC scoping for search_events)

**Keep everything else unchanged:**
- Checkout, node setup, npm ci
- `supabase start` (applies migrations including new schema_info)
- Environment variable extraction from `supabase status -o json`
- Environment variable verification step (guard against null values)
- Media bucket creation step (if it exists)
- `supabase stop` in cleanup

### Verify CI environment variable extraction

The existing CI step extracts vars like:
```yaml
echo "NEXT_PUBLIC_SUPABASE_URL=$(supabase status -o json | jq -r '.API_URL')" >> $GITHUB_ENV
echo "SUPABASE_SECRET_KEY=$(supabase status -o json | jq -r '.SERVICE_ROLE_KEY')" >> $GITHUB_ENV
```

These are still needed — the integration tests read them via `getSupabaseConfig()` in setup.ts. No changes needed to the extraction step.

### Verify env var verification step

The existing step checks for null values:
```yaml
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SECRET_KEY" ] || ...; then
  echo "ERROR: Required env vars are null"
  exit 1
fi
```

Keep this — it's a useful early-fail guard separate from the globalSetup check.

## Tests to Write First

No formal tests — this is CI configuration. Verify via:
- Push to a PR branch and check GitHub Actions output
- Verify: single `npm run test:integration` step runs all 4 suites
- Verify: no FTS smoke test step in the workflow
- Verify: env var extraction and verification steps still work
- Verify: `supabase start`/`stop` lifecycle unchanged

## Files to Create/Modify

| File | Action |
|------|--------|
| `.github/workflows/ci.yml` | MODIFY — merge test commands, remove FTS smoke test |

## Acceptance Criteria

1. Single `npm run test:integration` command in CI (not two separate commands)
2. Inline FTS smoke test removed
3. All other CI steps unchanged (supabase start/stop, env extraction, verification)
4. CI pipeline runs all 4 integration suites successfully
5. No references to `test:media-integration` in the workflow
