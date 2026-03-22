Now I have all the context needed. Let me write the section.

# Section 10: Update CI Workflow

## Overview

This section updates `.github/workflows/ci.yml` to rename all `SUPABASE_SECRET_KEY` references to `SUPABASE_SERVICE_ROLE_KEY` and add webhook service account environment variables where needed. The CI workflow is the last piece that uses the old env var name. After this section, no code or configuration references `SUPABASE_SECRET_KEY`.

## Dependencies

This section depends on:
- **Section 04 (webhook-service-account):** The webhook service account migration must exist so CI can create the account during `supabase start`.
- **Section 07 (env-var-rename):** Test files and setup code must already reference `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`.
- **Section 08 (test-app-layer):** Integration tests must be refactored to use app-layer functions.
- **Section 09 (dev-server-setup):** `globalSetup.ts` must handle dev server spawning for integration tests.

## File to Modify

**`/home/user/sitemgr/.github/workflows/ci.yml`**

## Verification Criteria

These are validation checks to run after implementation -- there are no separate test files for CI workflow changes. The CI pipeline run itself is the test.

```
# Verify: ci.yml integration test job uses SUPABASE_SERVICE_ROLE_KEY (not SUPABASE_SECRET_KEY)
# Verify: ci.yml deployment job uses SUPABASE_SERVICE_ROLE_KEY for bucket creation
# Verify: ci.yml does NOT set SUPABASE_SECRET_KEY anywhere
# Verify: ci.yml integration tests pass in CI after all changes
```

After applying the changes, run this grep to confirm no stale references remain:

```bash
grep -n "SUPABASE_SECRET_KEY" /home/user/sitemgr/.github/workflows/ci.yml
```

This should return zero matches.

## Changes Required

### 1. Integration Tests Job -- Extract Supabase Connection Details Step (line ~90)

In the `Extract Supabase connection details` step, rename the environment variable from `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY`:

```yaml
echo "SUPABASE_SERVICE_ROLE_KEY=$(echo "$STATUS_JSON" | jq -r .SERVICE_ROLE_KEY)" >> $GITHUB_ENV
```

The current line reads:
```yaml
echo "SUPABASE_SECRET_KEY=$(echo "$STATUS_JSON" | jq -r .SERVICE_ROLE_KEY)" >> $GITHUB_ENV
```

### 2. Integration Tests Job -- Verify Env Vars Step (line ~101)

In the `Verify integration test env vars` step, update the `for` loop to check `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`:

```yaml
for var in SMGR_API_URL SMGR_API_KEY SUPABASE_SERVICE_ROLE_KEY; do
```

The current line reads:
```yaml
for var in SMGR_API_URL SMGR_API_KEY SUPABASE_SECRET_KEY; do
```

### 3. Integration Tests Job -- Create Storage Bucket Step (line ~148)

In the `Create storage bucket` step, update the `Authorization` header to use the renamed variable:

```yaml
-H "Authorization: Bearer ${{ env.SUPABASE_SERVICE_ROLE_KEY }}" \
```

The current line reads:
```yaml
-H "Authorization: Bearer ${{ env.SUPABASE_SECRET_KEY }}" \
```

This is an admin operation (creating a storage bucket) -- the service role key is the correct credential here. Only the name changes to match the canonical Supabase naming convention.

### 4. Deploy Job -- Create Storage Bucket Step (line ~261)

In the deploy job's `Create storage bucket` step, update the secret reference from `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY`:

```yaml
-H "Authorization: Bearer ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}" \
```

The current line reads:
```yaml
-H "Authorization: Bearer ${{ secrets.SUPABASE_SECRET_KEY }}" \
```

This requires a corresponding rename of the secret in the GitHub Production environment (see Manual Steps below).

### 5. Add Webhook Service Account Environment Variables (if webhook integration tests exist)

If the webhook service account integration tests from Section 04 require credentials at CI runtime, add these env vars to the integration test job's `Configure environment for smgr` step:

```yaml
echo "WEBHOOK_SERVICE_ACCOUNT_EMAIL=webhook@sitemgr.internal" >> $GITHUB_ENV
echo "WEBHOOK_SERVICE_ACCOUNT_PASSWORD=<value-from-migration>" >> $GITHUB_ENV
```

However, the webhook service account is created by a Supabase migration that runs during `supabase start`. In the local CI environment, the password is set by the migration itself (a deterministic value for local dev). Check the migration from Section 04 to determine the exact password value used for local dev. If the migration uses a hardcoded password for local environments, use that same value here. If it generates a random password, the integration tests will need to read it from `supabase status` or a similar mechanism.

## Manual Steps (Not Automatable in CI File)

These steps must be performed by a human with access to the GitHub and Vercel dashboards. Document them in the PR description.

### GitHub Production Environment

1. Navigate to the repository Settings > Environments > Production > Environment secrets.
2. Rename `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY` (delete old, create new with same value).
3. This secret is only used by the deploy job for storage bucket creation -- it is NOT used by the application at runtime.

### Vercel Production

1. Remove the `SUPABASE_SECRET_KEY` environment variable (application code no longer reads it).
2. Add `WEBHOOK_SERVICE_ACCOUNT_EMAIL` set to `webhook@sitemgr.internal`.
3. Add `WEBHOOK_SERVICE_ACCOUNT_PASSWORD` set to the generated password for the production webhook service account.
4. These are the credentials the WhatsApp webhook handler uses to authenticate as the webhook service account.

## Summary of All Line Changes

| Line (approx) | Current Value | New Value |
|---|---|---|
| 90 | `SUPABASE_SECRET_KEY=$(... .SERVICE_ROLE_KEY)` | `SUPABASE_SERVICE_ROLE_KEY=$(... .SERVICE_ROLE_KEY)` |
| 101 | `for var in ... SUPABASE_SECRET_KEY;` | `for var in ... SUPABASE_SERVICE_ROLE_KEY;` |
| 148 | `Bearer ${{ env.SUPABASE_SECRET_KEY }}` | `Bearer ${{ env.SUPABASE_SERVICE_ROLE_KEY }}` |
| 261 | `Bearer ${{ secrets.SUPABASE_SECRET_KEY }}` | `Bearer ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}` |

All four changes are mechanical renames. No logic changes, no new steps (beyond the optional webhook env vars), no removed steps.