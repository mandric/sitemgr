Now I have all the context needed. Let me produce the section content.

# Section 11: Update Config and Documentation

## Overview

This is the final section. After all prior sections have been implemented (sections 1-10), the codebase has a new security architecture where the service role key is no longer used in any application runtime code. This section updates all configuration files and documentation to reflect that architecture.

**Dependencies:** Sections 06 (instrumentation) and 10 (CI workflow) must be complete before this section. All env var renames and code changes should already be landed.

## Architecture Summary (for context)

The new architecture separates concerns as follows:

| Layer | Auth (login) | Data operations | Supabase key used |
|-------|-------------|-----------------|-------------------|
| Browser | Supabase Auth directly (anon key) | Server components/actions (cookie session + RLS) | Anon key |
| CLI (`smgr`) | Supabase Auth directly (anon key) | Supabase PostgREST (user JWT + RLS) | Anon key |
| Web API -- server actions | Cookie session from browser | Supabase PostgREST (user session + RLS) | Anon key |
| Web API -- WhatsApp webhook | Twilio signature validation | SECURITY DEFINER RPCs + user-scoped queries | Anon key |
| Tests (setup/teardown only) | N/A | `auth.admin.*`, raw SDK | Service role key |
| CI deployment scripts | N/A | Storage bucket creation, migrations | Service role key |

**The service role key does not appear in any production application code path.**

## Verification Checklist

These are the validation criteria for this section. Each should be confirmed manually after making the documentation changes:

```
Verify: docs/ENV_VARS.md documents SUPABASE_SERVICE_ROLE_KEY as test/admin only
Verify: docs/ENV_VARS.md documents webhook service account env vars
Verify: CLAUDE.md Environment Variables section updated
Verify: .env.example files have clear comments separating app vars from test/admin vars
Verify: QUICKSTART.md and DEPLOYMENT.md use SUPABASE_SERVICE_ROLE_KEY (not SUPABASE_SECRET_KEY)
Verify: INTEGRATION_TESTS_SETUP.md uses SUPABASE_SERVICE_ROLE_KEY (not SUPABASE_SECRET_KEY)
Verify: scripts/setup/verify.sh checks SUPABASE_SERVICE_ROLE_KEY (not SUPABASE_SECRET_KEY)
```

## File-by-File Changes

### 1. `/home/user/sitemgr/.env.example` (root)

**Current state:** Has `SUPABASE_SECRET_KEY=` in the "Runtime (Vercel / Edge Functions)" section, implying it is needed by the running app.

**Target state:** Remove `SUPABASE_SECRET_KEY` from the runtime section entirely. Add a new "Test / Admin Only" section at the bottom with `SUPABASE_SERVICE_ROLE_KEY` commented out and clearly annotated. Also add the webhook service account env vars to the runtime section.

Changes to make:
- Delete the line `SUPABASE_SECRET_KEY=` and its comments from the runtime section.
- Add a new section header `# -- Test / Admin only (NOT needed by the running app) --` near the bottom.
- Under that section, add `# SUPABASE_SERVICE_ROLE_KEY=` (commented out) with a note: "Only for test setup, CI deployment scripts, and admin operations."
- In the runtime section, add two new vars for the webhook service account:
  - `WEBHOOK_SERVICE_ACCOUNT_EMAIL=webhook@sitemgr.internal`
  - `WEBHOOK_SERVICE_ACCOUNT_PASSWORD=` with a comment explaining it is the password for the webhook service account user created by the migration.

### 2. `/home/user/sitemgr/web/.env.example`

**Current state:** Has `SUPABASE_SECRET_KEY=` in the Supabase section with a comment "Service role key -- server-side only, never expose to browser".

**Target state:** Remove `SUPABASE_SECRET_KEY` from the main Supabase section. Add a clearly separated test/admin section. Add webhook service account vars.

Changes to make:
- Remove the `SUPABASE_SECRET_KEY=` line and its comment from the Supabase section.
- Add a `# -- Webhook Service Account --` section with `WEBHOOK_SERVICE_ACCOUNT_EMAIL` and `WEBHOOK_SERVICE_ACCOUNT_PASSWORD`.
- Add a `# -- Test / Admin only (NOT for app code) --` section at the bottom with `# SUPABASE_SERVICE_ROLE_KEY=` commented out, annotated as test/admin only.

### 3. `/home/user/sitemgr/docs/ENV_VARS.md`

**Current state:** Lists `SUPABASE_SECRET_KEY` in the "Runtime-Only Secrets" table as a Vercel Prod secret.

**Target state:** Document the new architecture clearly. Move `SUPABASE_SERVICE_ROLE_KEY` out of runtime secrets and into a test/admin section. Add webhook service account vars.

Specific changes:

- **Rename** all occurrences of `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY`.
- **Remove** `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` from the "Runtime-Only Secrets" table -- it is no longer a runtime secret.
- **Add a new section** titled "## Service Role Key (Test/Admin Only)" that explains:
  - The service role key is NOT used by application code at runtime.
  - It is only needed for: test setup (`createTestUser()` in integration tests), CI deployment scripts (storage bucket creation), and manual admin operations.
  - It should NOT be set in Vercel Production (the running app does not read it).
  - In CI, it comes from `supabase status -o json` for local Supabase or from a GitHub environment secret for cloud deployments.
- **Add a new section** titled "## Webhook Service Account" that documents:
  - `WEBHOOK_SERVICE_ACCOUNT_EMAIL` -- the email for the webhook service account user (default: `webhook@sitemgr.internal`).
  - `WEBHOOK_SERVICE_ACCOUNT_PASSWORD` -- the password for that user, set in Vercel Production.
  - These are real Supabase Auth credentials for a narrowly-scoped service account, not the god-mode service role key.
  - The webhook service account is created by a database migration and has specific RLS policies granting it cross-user access.
- **Update the "Application Secrets" table** to include `WEBHOOK_SERVICE_ACCOUNT_EMAIL` and `WEBHOOK_SERVICE_ACCOUNT_PASSWORD`.
- **Add a deprecated entry**: `SUPABASE_SECRET_KEY` -- renamed to `SUPABASE_SERVICE_ROLE_KEY`, and removed from runtime. Do not use.
- **Update the "Last Updated" date** at the top to the current date.

### 4. `/home/user/sitemgr/docs/QUICKSTART.md`

**Current state:** Step 5 (Configure GitHub Actions) lists `SUPABASE_SECRET_KEY` as a repository secret to add.

**Target state:** Rename to `SUPABASE_SERVICE_ROLE_KEY` and clarify its purpose.

Changes to make:
- In Step 5, rename `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY` in the secrets list.
- Update the description from "From Project Settings > API > service_role" to "From Project Settings > API > service_role key (used for CI deployment scripts only, not app runtime)".
- Add `WEBHOOK_SERVICE_ACCOUNT_PASSWORD` to the Application Secrets list with description "Password for webhook service account (see migration)".

### 5. `/home/user/sitemgr/docs/DEPLOYMENT.md`

**Current state:** References `SUPABASE_SECRET_KEY` in the GitHub Secrets table (under "Supabase Secrets") and in the Troubleshooting section ("Storage bucket not created").

**Target state:** Rename all to `SUPABASE_SERVICE_ROLE_KEY` and clarify it is for deployment/admin only.

Changes to make:
- In the "Supabase Secrets" table under "5. Configure GitHub Secrets", rename `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY` and update description to "Service role key (for storage setup and CI deployment -- NOT app runtime)".
- Add `WEBHOOK_SERVICE_ACCOUNT_PASSWORD` to the "Application Secrets" table.
- In Troubleshooting > "Storage bucket not created", change `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY`.
- In "2. Get Supabase Credentials", add a note that the service role key is only needed for deployment scripts.

### 6. `/home/user/sitemgr/INTEGRATION_TESTS_SETUP.md`

**Current state:** Lists `SUPABASE_SECRET_KEY` in the "Required (Auto-configured)" environment variables section.

**Target state:** Rename to `SUPABASE_SERVICE_ROLE_KEY` and add a note that it is for test setup only.

Changes to make:
- Rename `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY` in the environment variables table.
- Add a comment noting it is used for test setup (creating users, admin operations) and not by application code.

### 7. `/home/user/sitemgr/scripts/setup/verify.sh`

**Current state:** Line 43 checks `SUPABASE_SECRET_KEY`.

**Target state:** Check `SUPABASE_SERVICE_ROLE_KEY` instead. This script verifies that the local dev environment is configured correctly, and the service role key is needed for test setup.

Changes to make:
- Line 43: change `check_var "SUPABASE_SECRET_KEY"` to `check_var "SUPABASE_SERVICE_ROLE_KEY"`.

### 8. `/home/user/sitemgr/CLAUDE.md`

**Current state:** The "Environment Variables & Secrets Strategy" section under "Where Secrets Live" mentions Vercel Production having "All runtime secrets for deployed app". It does not explicitly mention the service role key architecture.

**Target state:** Add clarity that `SUPABASE_SERVICE_ROLE_KEY` is NOT a runtime secret and should not be in Vercel Production for the running app. Document the webhook service account pattern.

Changes to make:
- In "Where Secrets Live", add a bullet: "**Vercel Production does NOT include**: `SUPABASE_SERVICE_ROLE_KEY` -- app code never uses it; only test setup and CI deployment scripts need it"
- Add a new subsection "**Supabase Service Role Key (Test/Admin Only):**" that states:
  - Application code (CLI, agent core, health endpoint, webhook handler) never uses the service role key
  - The service role key only appears in: integration test setup (`setup.ts`), CI deployment scripts, `scripts/setup/verify.sh`
  - The WhatsApp webhook uses a dedicated service account (`webhook@sitemgr.internal`) with narrowly-scoped RLS policies instead of the service role key
- Add `WEBHOOK_SERVICE_ACCOUNT_EMAIL` and `WEBHOOK_SERVICE_ACCOUNT_PASSWORD` to any relevant env var lists or notes, indicating they are Vercel Production runtime secrets for the webhook handler.
- Add `SUPABASE_SECRET_KEY` to the "DO NOT USE" deprecated list alongside the encryption key entries, noting it was renamed to `SUPABASE_SERVICE_ROLE_KEY` and removed from runtime.

## Implementation Notes

- All changes in this section are documentation and configuration only -- no TypeScript code changes.
- The `.env.example` files serve as templates for developers. Making the service role key a commented-out entry in a clearly labeled test/admin section prevents developers from assuming it is needed for the running app.
- The `CLAUDE.md` changes are important because they serve as project-wide instructions that guide future development. Any AI or human reading the codebase should immediately understand that the service role key is not for application use.
- The `verify.sh` change is the only executable code change in this section -- a single line rename from `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY`.