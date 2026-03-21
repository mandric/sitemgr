# Section 8: Cleanup and Documentation

## Overview

This is the final section. All functional changes are complete in Sections 1-7. This section performs project-wide verification that the decoupling is complete, updates documentation to reflect the new architecture, and runs the full test suite one last time.

The key invariants to verify:
- `db.ts` has no dependency on `cli-auth.ts`
- The barrel export `lib/media/index.ts` is gone and nothing imports from `@/lib/media`
- The CLI has no `db.ts` imports
- `SMGR_API_KEY` is not referenced anywhere in runtime code
- `resolveApiConfig` is not referenced anywhere outside test/doc files
- All tests pass

## Dependencies

- **section-06-rewrite-cli** must be complete (CLI is fully migrated to HTTP).
- **section-07-update-server-consumers** must be complete (agent core and actions are parameterized).

## What This Section Blocks

- Nothing. This is the final section.

## Files Involved

| File | Action |
|------|--------|
| `/home/user/sitemgr/docs/ENV_VARS.md` | Modify |
| `/home/user/sitemgr/web/lib/media/index.ts` | Verify deleted (done in Section 1) |
| `/home/user/sitemgr/web/__tests__/cleanup-verification.test.ts` | Create |

## Changes

### 1. Update `docs/ENV_VARS.md`

Add or update the following sections in the env vars documentation.

**Update the CLI section** (or create one if it does not exist):

Document `SMGR_API_URL` with its new meaning:

| Variable | Required | Where Set | Purpose |
|----------|----------|-----------|---------|
| `SMGR_API_URL` | For CLI | Shell / `.env.local` | Base URL of the sitemgr web app. Local dev: `http://localhost:3000`. Production: `https://sitemgr.vercel.app`. The CLI sends all API requests to this URL. |

Document removed variables:

| Variable | Status | Notes |
|----------|--------|-------|
| `SMGR_API_KEY` | **Removed** | Was the Supabase anon key for CLI. No longer needed -- CLI authenticates via JWT from `/api/auth/login`. |
| `SUPABASE_SECRET_KEY` (CLI usage) | **Removed from CLI** | Service role key is now only used server-side by the web app (Vercel env). CLI never needs it. |

**Add a note about CLI authentication flow:**

> **CLI Authentication:** The CLI (`smgr`) authenticates via email/password login against the web API (`POST /api/auth/login`). This returns a JWT access token and refresh token, stored locally in `~/.sitemgr/credentials.json`. The access token is sent as `Authorization: Bearer <token>` on all subsequent requests. Token refresh is handled automatically by the API client when a 401 is received. The CLI no longer connects to Supabase directly.

### 2. Verify barrel export is deleted

Confirm that `/home/user/sitemgr/web/lib/media/index.ts` does not exist. This was deleted in Section 1 but should be verified here as a final check.

### 3. Create verification test file

Create a test file that encodes the architectural invariants as automated checks. These tests read source files and grep for patterns that should no longer exist. They serve as regression guards.

## TDD Test Stubs

### `__tests__/cleanup-verification.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const WEB_ROOT = resolve(__dirname, "..");

describe("architectural invariants", () => {
  it("barrel export lib/media/index.ts does not exist", () => {
    const barrelPath = resolve(WEB_ROOT, "lib/media/index.ts");
    expect(existsSync(barrelPath)).toBe(false);
  });

  it("no files import from '@/lib/media' (bare path without /db)", () => {
    // Use grep across the web/ directory for imports from @/lib/media
    // that are not @/lib/media/db, @/lib/media/s3, @/lib/media/utils, etc.
    // Pattern: from "@/lib/media" or from '../lib/media' (exact, no subpath)
    const result = execSync(
      `grep -rn "from ['\"]@/lib/media['\"]" ${WEB_ROOT} --include="*.ts" --include="*.tsx" || true`,
      { encoding: "utf-8" },
    );
    expect(result.trim()).toBe("");
  });

  it("db.ts does not import from cli-auth", () => {
    const dbSource = readFileSync(resolve(WEB_ROOT, "lib/media/db.ts"), "utf-8");
    expect(dbSource).not.toContain("cli-auth");
  });

  it("no files in lib/media/ import from cli-auth", () => {
    const result = execSync(
      `grep -rn "cli-auth" ${resolve(WEB_ROOT, "lib/media/")} --include="*.ts" || true`,
      { encoding: "utf-8" },
    );
    expect(result.trim()).toBe("");
  });

  it("smgr.ts does not import from lib/media/db", () => {
    const smgrSource = readFileSync(resolve(WEB_ROOT, "bin/smgr.ts"), "utf-8");
    expect(smgrSource).not.toContain("lib/media/db");
  });

  it("cli-auth.ts does not import from @supabase/supabase-js", () => {
    const cliAuthSource = readFileSync(resolve(WEB_ROOT, "lib/auth/cli-auth.ts"), "utf-8");
    expect(cliAuthSource).not.toContain("@supabase/supabase-js");
  });

  it("resolveApiConfig is not referenced outside test and doc files", () => {
    // Exclude __tests__/, *.test.ts, *.spec.ts, docs/, *.md
    const result = execSync(
      `grep -rn "resolveApiConfig" ${WEB_ROOT} --include="*.ts" --include="*.tsx" --exclude-dir="__tests__" --exclude="*.test.ts" --exclude="*.spec.ts" || true`,
      { encoding: "utf-8" },
    );
    expect(result.trim()).toBe("");
  });

  it("SMGR_API_KEY is not referenced in runtime code", () => {
    // Exclude test files, docs, and markdown
    const result = execSync(
      `grep -rn "SMGR_API_KEY" ${WEB_ROOT} --include="*.ts" --include="*.tsx" --exclude-dir="__tests__" --exclude="*.test.ts" --exclude="*.spec.ts" || true`,
      { encoding: "utf-8" },
    );
    expect(result.trim()).toBe("");
  });

  it("no zero-argument getAdminClient() calls remain in server consumers", () => {
    // Check agent core and server actions for getAdminClient()
    // The pattern getAdminClient() with no arguments should not appear
    const coreSource = readFileSync(resolve(WEB_ROOT, "lib/agent/core.ts"), "utf-8");
    const actionsSource = readFileSync(resolve(WEB_ROOT, "components/agent/actions.ts"), "utf-8");

    // Match getAdminClient() but not getAdminClient({ ... })
    // Simple check: getAdminClient() immediately followed by ; or line end
    const zeroArgPattern = /getAdminClient\(\s*\)/;
    expect(coreSource).not.toMatch(zeroArgPattern);
    expect(actionsSource).not.toMatch(zeroArgPattern);
  });
});
```

## Verification Steps

Run these from `/home/user/sitemgr/web`:

```bash
# 1. Run the architectural invariant tests
npx vitest run __tests__/cleanup-verification.test.ts

# 2. Run the full test suite
npm test

# 3. Type-check the entire project
npx tsc --noEmit

# 4. Manual grep checks (belt and suspenders)

# No cli-auth imports in lib/media/
grep -rn "cli-auth" lib/media/
# Expected: no output

# No bare @/lib/media imports (should all be @/lib/media/db, @/lib/media/s3, etc.)
grep -rn "from ['\"]@/lib/media['\"]" --include="*.ts" --include="*.tsx" .
# Expected: no output

# No SMGR_API_KEY in runtime code
grep -rn "SMGR_API_KEY" --include="*.ts" --include="*.tsx" . | grep -v __tests__ | grep -v ".test." | grep -v ".spec."
# Expected: no output

# No resolveApiConfig in runtime code
grep -rn "resolveApiConfig" --include="*.ts" --include="*.tsx" . | grep -v __tests__ | grep -v ".test." | grep -v ".spec."
# Expected: no output

# Barrel export is gone
test ! -f lib/media/index.ts && echo "PASS: barrel deleted" || echo "FAIL: barrel still exists"

# 5. Verify docs/ENV_VARS.md has been updated
grep -n "SMGR_API_URL" ../docs/ENV_VARS.md
# Expected: at least one line documenting the new meaning

grep -n "SMGR_API_KEY" ../docs/ENV_VARS.md
# Expected: a line marking it as removed/deprecated
```

## Completion Criteria

1. `docs/ENV_VARS.md` documents `SMGR_API_URL` (web app URL), marks `SMGR_API_KEY` as removed, describes CLI JWT auth flow
2. `lib/media/index.ts` does not exist
3. All architectural invariant tests in `cleanup-verification.test.ts` pass
4. The full test suite passes
5. `npx tsc --noEmit` succeeds with no type errors
6. No manual grep checks find violations of the decoupling invariants
