I now have all the context needed. Here is the section content.

# Section 7: Consolidate Remaining `SUPABASE_SECRET_KEY` References

## Overview

After sections 01-06 remove the service role key from all application runtime code, the old env var name `SUPABASE_SECRET_KEY` still appears in test setup files, CI workflows, config examples, scripts, and documentation. This section renames every remaining occurrence to `SUPABASE_SERVICE_ROLE_KEY` for consistency with Supabase's canonical naming.

This is a mechanical find-and-replace across multiple file types. No logic changes -- only the env var name changes.

## Dependencies

- **Section 01 (ES256 workaround)**: Updates `scripts/local-dev.sh` output. That section changes how the service role key is emitted (commented out). This section renames the variable name in that same file from `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY`.
- **Section 05 (CLI user client)**: Removes `SUPABASE_SECRET_KEY` from CLI runtime code. This section handles the test files that still pass the old name to CLI subprocesses.

Both dependencies must be completed first. After this section, no file in the repository should contain `SUPABASE_SECRET_KEY` (except spec/research docs describing the migration itself).

## Tests

This section's "tests" are verification steps -- codebase-wide greps that confirm the rename is complete. There are no new Vitest test files.

### Verification: Codebase-wide grep (run after all renames)

```
# Verify: grep for SUPABASE_SECRET_KEY in all .ts, .tsx, .yml, .sh files returns zero matches
#         (except spec files describing the migration itself)
# Verify: grep for SUPABASE_SERVICE_ROLE_KEY appears ONLY in:
#         - web/__tests__/integration/setup.ts (test admin client)
#         - .github/workflows/ci.yml (test setup + deployment)
#         - scripts/setup/verify.sh (optional verification)
#         - scripts/local-dev.sh (commented out, test/admin only)
#         - .env.example files (documented as test/admin only)
#         - docs/ files
```

### Verification: `web/__tests__/integration/setup.ts` reads the correct env var

```
# Test: getAdminClient reads from process.env.SUPABASE_SERVICE_ROLE_KEY (not SUPABASE_SECRET_KEY)
# Test: getSupabaseConfig returns serviceKey from SUPABASE_SERVICE_ROLE_KEY
```

These can be confirmed by reading the file after the rename. Alternatively, a quick unit test could stub the env var and call `getSupabaseConfig()`, but given this is a simple rename, manual inspection suffices.

## Files to Modify

### 1. `web/__tests__/integration/setup.ts`

**Current state (line 11):**
```typescript
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
```

**Change to:**
```typescript
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
```

**Current state (line 24, error message):**
```typescript
"SUPABASE_SECRET_KEY not set. Run `supabase start` and set env vars.",
```

**Change to:**
```typescript
"SUPABASE_SERVICE_ROLE_KEY not set. Run `supabase start` and set env vars.",
```

The local variable name `SUPABASE_SERVICE_KEY` can stay as-is (it is internal to the module and not an env var name). Only the `process.env` reference and error message text change.

### 2. `web/__tests__/integration/smgr-cli.test.ts`

**Current state (line 43, inside `cliEnv()`):**
```typescript
SUPABASE_SECRET_KEY: cfg.serviceKey,
```

**Change to:**
```typescript
SUPABASE_SERVICE_ROLE_KEY: cfg.serviceKey,
```

**Current state (lines 358-359, exit code test):**
```typescript
it("should exit 1 when SUPABASE_SECRET_KEY is missing for stats", async () => {
    const result = await runCli(["stats"], { SUPABASE_SECRET_KEY: "" });
```

**Change to:**
```typescript
it("should exit 1 when SUPABASE_SERVICE_ROLE_KEY is missing for stats", async () => {
    const result = await runCli(["stats"], { SUPABASE_SERVICE_ROLE_KEY: "" });
```

Note: After section 05 switches the CLI to user auth, this test may need further changes (the CLI no longer needs the service role key at all). But for this section, the rename is the deliverable. If section 05 removes this env var from the CLI entirely, this test description and assertion may change to test a different failure mode. Coordinate with section 05 output.

### 3. `web/__tests__/integration/smgr-e2e.test.ts`

**Current state (line 54, inside `cliEnv()`):**
```typescript
SUPABASE_SECRET_KEY: cfg.serviceKey,
```

**Change to:**
```typescript
SUPABASE_SERVICE_ROLE_KEY: cfg.serviceKey,
```

Same coordination note as smgr-cli.test.ts above.

### 4. `scripts/local-dev.sh`

**Current state (line 99):**
```bash
SUPABASE_SECRET_KEY=${supabase_secret_key}
```

**Change to:**
```bash
SUPABASE_SERVICE_ROLE_KEY=${supabase_secret_key}
```

Note: Section 01 may comment this line out entirely (making it `# SUPABASE_SERVICE_ROLE_KEY=...`). If section 01 has already been applied, verify the line exists and uses the new name. If section 01 commented it out, ensure the comment uses the new name.

### 5. `scripts/setup/verify.sh`

**Current state (line 43):**
```bash
check_var "SUPABASE_SECRET_KEY"
```

**Change to:**
```bash
check_var "SUPABASE_SERVICE_ROLE_KEY"
```

### 6. `.env.example` (root)

**Current state (line 45):**
```
SUPABASE_SECRET_KEY=
```

**Change to:**
```
# Service role key — tests and admin scripts only, NOT for app runtime code
SUPABASE_SERVICE_ROLE_KEY=
```

Also update the preceding comment (lines 43-44) if it still says "Supabase Service Role Key" generically. Add clarity that this is test/admin only.

### 7. `web/.env.example`

**Current state (line 7):**
```
SUPABASE_SECRET_KEY=
```

**Change to:**
```
# Service role key — test setup and admin scripts only (not used by app code)
SUPABASE_SERVICE_ROLE_KEY=
```

Update the preceding comment (line 6) from:
```
# Service role key — server-side only, never expose to browser
```
to:
```
# Service role key — test/admin only, not used by running application
```

### 8. `.github/workflows/ci.yml`

Four occurrences to rename:

**Line 90** (extracting from supabase status):
```yaml
# Before:
echo "SUPABASE_SECRET_KEY=$(echo "$STATUS_JSON" | jq -r .SERVICE_ROLE_KEY)" >> $GITHUB_ENV
# After:
echo "SUPABASE_SERVICE_ROLE_KEY=$(echo "$STATUS_JSON" | jq -r .SERVICE_ROLE_KEY)" >> $GITHUB_ENV
```

**Line 101** (validation loop):
```yaml
# Before:
for var in SMGR_API_URL SMGR_API_KEY SUPABASE_SECRET_KEY; do
# After:
for var in SMGR_API_URL SMGR_API_KEY SUPABASE_SERVICE_ROLE_KEY; do
```

**Line 148** (integration test bucket creation):
```yaml
# Before:
-H "Authorization: Bearer ${{ env.SUPABASE_SECRET_KEY }}" \
# After:
-H "Authorization: Bearer ${{ env.SUPABASE_SERVICE_ROLE_KEY }}" \
```

**Line 261** (deployment job bucket creation):
```yaml
# Before:
-H "Authorization: Bearer ${{ secrets.SUPABASE_SECRET_KEY }}" \
# After:
-H "Authorization: Bearer ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}" \
```

Important: The `secrets.SUPABASE_SECRET_KEY` reference on line 261 means the GitHub Production Environment secret must also be renamed to `SUPABASE_SERVICE_ROLE_KEY`. This is a manual step documented below.

### 9. `docs/ENV_VARS.md`

**Line 55:**
```
# Before:
| `SUPABASE_SECRET_KEY` | ✅ | Supabase service role key |
# After:
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key (test/admin only) |
```

### 10. `docs/QUICKSTART.md`

**Line 106:**
```
# Before:
   - `SUPABASE_SECRET_KEY` - From Project Settings > API > service_role
# After:
   - `SUPABASE_SERVICE_ROLE_KEY` - From Project Settings > API > service_role (test/admin only)
```

### 11. `docs/DEPLOYMENT.md`

**Line 116:**
```
# Before:
| `SUPABASE_SECRET_KEY` | Service role key (for storage setup) | `eyJhbGc...` |
# After:
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (for storage setup) | `eyJhbGc...` |
```

**Line 243:**
```
# Before:
- Check that `SUPABASE_SECRET_KEY` is set
# After:
- Check that `SUPABASE_SERVICE_ROLE_KEY` is set
```

### 12. `INTEGRATION_TESTS_SETUP.md`

**Line 156:**
```
# Before:
SUPABASE_SECRET_KEY     # From supabase status
# After:
SUPABASE_SERVICE_ROLE_KEY     # From supabase status
```

## Manual Steps (Not Code Changes)

These are infrastructure steps that must be performed by a person with access:

1. **GitHub Production Environment**: Rename the secret from `SUPABASE_SECRET_KEY` to `SUPABASE_SERVICE_ROLE_KEY`. This is referenced by `${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}` in the deployment job.

2. **Vercel Production**: If `SUPABASE_SECRET_KEY` exists as an env var, rename it to `SUPABASE_SERVICE_ROLE_KEY` (only if it is still needed for deployment scripts; app code no longer reads it).

Document these manual steps in the PR description so the person merging knows to coordinate.

## Verification Procedure

After completing all renames, run these commands from the repository root:

```bash
# Should return ZERO matches in non-spec .ts/.tsx/.yml/.sh files:
grep -r "SUPABASE_SECRET_KEY" --include="*.ts" --include="*.tsx" --include="*.yml" --include="*.sh" --exclude-dir="specs" .

# Should return ZERO matches in .env.example files:
grep -r "SUPABASE_SECRET_KEY" --include="*.example" .

# Should return ZERO matches in docs (non-spec):
grep -r "SUPABASE_SECRET_KEY" docs/

# Confirm SUPABASE_SERVICE_ROLE_KEY appears only in expected locations:
grep -r "SUPABASE_SERVICE_ROLE_KEY" --include="*.ts" --include="*.tsx" .
# Expected: only in web/__tests__/integration/setup.ts
```

If any matches remain outside of `specs/` directories, they need to be renamed. The `specs/` directory contains historical planning docs that describe the migration -- those references are intentional and should not be changed.