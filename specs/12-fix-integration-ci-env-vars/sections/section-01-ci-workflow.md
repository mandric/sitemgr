Now I have all the context needed. Let me produce the section content.

# Section 1: CI Workflow — Add NEXT_PUBLIC Env Vars

## Background

The service-role-key-audit refactor changed the health endpoint (`web/app/api/health/route.ts`) from using `getAdminClient` with `SUPABASE_SERVICE_ROLE_KEY` to `getUserClient` with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. The integration test job in CI was not updated to provide these new env vars. As a result, the dev server spawned by `globalSetup.ts` starts but the health endpoint returns 503 because the `NEXT_PUBLIC_*` vars are undefined, causing `waitForReady()` to time out after 60 seconds.

The CI workflow has two parallel naming conventions for the same Supabase connection details:
- `SMGR_API_URL` / `SMGR_API_KEY` — used by CLI tools and test infrastructure
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — used by the Next.js app (health endpoint, webhook handler)

Both point to the same local Supabase instance. The integration test job already extracts `SMGR_API_URL` and `SMGR_API_KEY` from `supabase status -o json` but never sets the `NEXT_PUBLIC_*` equivalents.

## Dependencies

None. This section is fully independent and can be implemented in isolation.

## File to Modify

`/home/user/sitemgr/.github/workflows/ci.yml`

## Tests

There are no automated test files to create for this section. Validation is done by grepping the YAML and by CI pipeline execution. The following assertions should hold after changes are applied:

```bash
# Test: "Configure environment for smgr" step sets NEXT_PUBLIC_SUPABASE_URL from SMGR_API_URL
# Test: "Configure environment for smgr" step sets NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY from SMGR_API_KEY
# Test: NEXT_PUBLIC_* lines appear before SMGR_S3_* lines in the step
# Test: "Verify integration test env vars" step checks NEXT_PUBLIC_SUPABASE_URL
# Test: "Verify integration test env vars" step checks NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
# Test: Verification step fails fast if NEXT_PUBLIC_SUPABASE_URL is empty
# Test: Verification step fails fast if NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is empty
```

After making the changes, verify locally with:

```bash
grep -n 'NEXT_PUBLIC_SUPABASE_URL' /home/user/sitemgr/.github/workflows/ci.yml
grep -n 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY' /home/user/sitemgr/.github/workflows/ci.yml
```

Both should appear in the "Configure environment for smgr" step AND in the "Verify integration test env vars" step.

## Implementation

### Change 1: Add env vars to "Configure environment for smgr" step

The step is at line 113 of `ci.yml`. Add two new lines at the **top** of the `run` block, before the existing `SMGR_S3_ENDPOINT` line. The new lines should be:

```yaml
echo "NEXT_PUBLIC_SUPABASE_URL=${{ env.SMGR_API_URL }}" >> $GITHUB_ENV
echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${{ env.SMGR_API_KEY }}" >> $GITHUB_ENV
```

These use `${{ env.SMGR_API_URL }}` and `${{ env.SMGR_API_KEY }}` which were set in the earlier "Extract Supabase connection details" step (line 84-96). Do NOT use the E2E job's variable names (`SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY`) — those are only available in the E2E job.

The resulting step should look like:

```yaml
      - name: Configure environment for smgr
        run: |
          echo "NEXT_PUBLIC_SUPABASE_URL=${{ env.SMGR_API_URL }}" >> $GITHUB_ENV
          echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${{ env.SMGR_API_KEY }}" >> $GITHUB_ENV
          echo "SMGR_S3_ENDPOINT=${{ env.S3_ENDPOINT_URL }}" >> $GITHUB_ENV
          echo "SMGR_S3_BUCKET=media" >> $GITHUB_ENV
          echo "SMGR_S3_REGION=local" >> $GITHUB_ENV
          echo "SMGR_DEVICE_ID=ci-test" >> $GITHUB_ENV
          echo "SMGR_AUTO_ENRICH=true" >> $GITHUB_ENV
          echo "SMGR_OLLAMA_URL=http://localhost:11434" >> $GITHUB_ENV
          echo "SMGR_VISION_MODEL=moondream:1.8b" >> $GITHUB_ENV
          echo "S3_ENDPOINT_URL=${{ env.S3_ENDPOINT_URL }}" >> $GITHUB_ENV
          echo "WEBHOOK_SERVICE_ACCOUNT_EMAIL=webhook@sitemgr.internal" >> $GITHUB_ENV
          echo "WEBHOOK_SERVICE_ACCOUNT_PASSWORD=unused-password-webhook-uses-service-token" >> $GITHUB_ENV
```

### Change 2: Add NEXT_PUBLIC_* to the verification step

The "Verify integration test env vars" step is at line 98. The `for` loop currently checks `SMGR_API_URL SMGR_API_KEY SUPABASE_SERVICE_ROLE_KEY`. Add the two new var names to this list.

Change line 101 from:

```bash
          for var in SMGR_API_URL SMGR_API_KEY SUPABASE_SERVICE_ROLE_KEY; do
```

to:

```bash
          for var in SMGR_API_URL SMGR_API_KEY SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; do
```

**Important ordering note:** The verification step runs AFTER the "Configure environment for smgr" step in the workflow. However, looking at the current YAML, the verification step (line 98) actually runs BEFORE the "Configure environment for smgr" step (line 113). The `NEXT_PUBLIC_*` vars are set in the configure step, so verifying them in the earlier step would fail.

There are two correct approaches:
1. Move the verification step to after the configure step, OR
2. Add the `NEXT_PUBLIC_*` vars to the "Extract Supabase connection details" step instead (line 84-96), so they're available for the existing verification step

The simpler fix: add the `NEXT_PUBLIC_*` echo lines to the "Extract Supabase connection details" step (lines 84-96) instead of (or in addition to) the "Configure environment" step. This way, the existing verification step at line 98 can check them.

Alternatively, keep the `NEXT_PUBLIC_*` lines in the "Configure environment" step and move the verification check for these two vars to a position after that step. The cleanest approach is to add them to the extract step since these values come directly from `supabase status` output, just like `SMGR_API_URL` and `SMGR_API_KEY`.

**Recommended approach:** Add the two `NEXT_PUBLIC_*` lines to the "Extract Supabase connection details" step (after the `SMGR_API_KEY` line, around line 89), and add them to the existing verification `for` loop. This keeps all Supabase-derived env vars in one place and lets the verification step catch them.

The extract step should have these two new lines after line 89:

```bash
          echo "NEXT_PUBLIC_SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)" >> $GITHUB_ENV
          echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$(echo "$STATUS_JSON" | jq -r .ANON_KEY)" >> $GITHUB_ENV
```

This sets them from the same `STATUS_JSON` source, keeping them consistent with the `SMGR_*` values. You do NOT also need to add them to the "Configure environment" step since they'll already be in `$GITHUB_ENV`.

## Validation

Push the changes to the branch. The CI integration test job should:
1. Pass the env var verification step (no "missing env var" error)
2. Start the dev server successfully (no 60-second timeout)
3. Run integration tests to completion