Now I have all the context I need. Let me generate the section content.

# Section 09: Cleanup

## Overview

This is the final section of the CLI Device Code Auth implementation. It covers three tasks:

1. Update `CLAUDE.md` to document the service role key exception for the device approve endpoint
2. Remove dead code (prompt helpers) from `cli-auth.ts`
3. Final verification that all existing tests still pass

**Dependencies:** All previous sections (01 through 08) must be complete before this section.

## Tests

There are no new test files for this section. The entire test obligation is to verify that all existing tests continue to pass after the cleanup changes. Run the full verification suite:

```bash
cd /home/user/sitemgr/web && npm run typecheck && npm run lint && npm run test && npm run test:integration && npm run build
```

If any test references the removed `prompt()` or `promptPassword()` functions, those test references must be updated or removed. Check for usages before deleting.

## Task 1: Update CLAUDE.md Service Role Key Documentation

**File:** `/home/user/sitemgr/CLAUDE.md`

The device code approve endpoint (`POST /api/auth/device/approve`) introduced by section 05 uses `SUPABASE_SERVICE_ROLE_KEY` for `admin.generateLink()`. This is a narrow exception to the established policy that "application code never uses the service role key."

### Changes to the "Supabase Service Role Key (Test/Admin Only)" subsection

The current text at lines 30-34 of CLAUDE.md reads:

```
**Supabase Service Role Key (Test/Admin Only):**
- Application code (CLI, agent core, health endpoint, webhook handler) **never** uses the service role key
- The service role key only appears in: `.env.local` (for integration tests), integration test setup (`setup.ts`), CI deployment scripts, `scripts/setup/verify.sh`
```

Update these lines to:

- Change the heading from `(Test/Admin Only)` to `(Test/Admin + Device Auth Exception)`
- Add a bullet documenting the exception: `/api/auth/device/approve` uses the service role key solely for `admin.generateLink()` to generate a magic link token hash during device code approval. This endpoint is itself authenticated (user must be logged in via cookie session). This is the only application endpoint with this exception.
- Add a note that evaluating alternative approaches (service account, edge function) is deferred to a future spec.

### Changes to the "Where Secrets Live" subsection

The current text at line 37 reads:

```
- **Vercel Production**: All runtime secrets for deployed app (does NOT include `SUPABASE_SERVICE_ROLE_KEY` — app code never uses it)
```

Update this line to note the exception: `SUPABASE_SERVICE_ROLE_KEY` is now included in Vercel Production runtime secrets, used only by the `/api/auth/device/approve` endpoint for `admin.generateLink()`.

Also update line 38 to reflect that `SUPABASE_SERVICE_ROLE_KEY` is in both GitHub Production Environment (for deployment) and Vercel Production (for the approve endpoint at runtime).

## Task 2: Remove Dead Code from cli-auth.ts

**File:** `/home/user/sitemgr/web/lib/auth/cli-auth.ts`

Section 07 replaced the `login()` function with the device code flow. The old prompt helpers are no longer called anywhere.

### Functions to remove

- `prompt(question: string): Promise<string>` (currently around line 58) -- reads terminal input via `readline`
- `promptPassword(question: string): Promise<string>` (currently around line 68) -- reads terminal input with hidden characters

### Pre-removal verification

Before deleting, search the entire codebase for any remaining references to these functions:

```bash
grep -r "prompt\b\|promptPassword" --include="*.ts" --include="*.tsx" /home/user/sitemgr/web/
```

If any file other than the definition site references `prompt` or `promptPassword` from `cli-auth.ts`, update those call sites first. Based on the plan, section 07 already removed all callers (the old `login()` function that used them was replaced), but verify before deleting.

### Imports to clean up

After removing the functions, check whether any imports they depended on are now unused:
- `readline` -- if `prompt` and `promptPassword` were the only consumers of `readline`, remove the import
- Any other Node.js built-in imports that were only used by these functions

### What to keep unchanged

These functions and types remain as-is (they are still used by the device code flow and other CLI commands):

- `StoredCredentials` interface (with the `device_name?` field added in section 07)
- `loadCredentials()`
- `saveCredentials()`
- `clearCredentials()`
- `refreshSession()`
- `resolveApiConfig()`
- `whoami()`
- `login()` (the new device code version from section 07)
- `openBrowser()` (added in section 07)

## Task 3: Remove Dead Code from smgr.ts

**File:** `/home/user/sitemgr/web/bin/smgr.ts`

Section 07 updated `cmdLogin()` to remove email/password arguments. Verify the usage text no longer mentions `[email] [password]`. If it still does, update it to show just `smgr login` with no arguments.

Check for any other references to the old login signature pattern and remove them.

## Task 4: Final Verification

Run the complete verification checklist:

```bash
cd /home/user/sitemgr/web && npm run typecheck && npm run lint && npm run test && npm run test:integration && npm run build
```

All five commands must pass. If any fail due to the cleanup changes (e.g., a test was importing `prompt` from `cli-auth.ts`), fix the issue before considering this section complete.

### What to look for

- **TypeScript errors:** Removed functions referenced elsewhere will cause `typecheck` failures
- **Lint errors:** Unused imports left behind after removing functions
- **Test failures:** Any test that imported or mocked the removed `prompt`/`promptPassword` functions
- **Build failures:** Ensure the Next.js build still succeeds with the CLAUDE.md and code changes

## File Summary

| File | Action |
|------|--------|
| `/home/user/sitemgr/CLAUDE.md` | Modify -- update service role key documentation to reflect device auth exception |
| `/home/user/sitemgr/web/lib/auth/cli-auth.ts` | Modify -- remove `prompt()` and `promptPassword()` functions and their unused imports |
| `/home/user/sitemgr/web/bin/smgr.ts` | Verify -- ensure usage text says `smgr login` (no email/password args) |