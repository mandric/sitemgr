# Section 6: Remove Service Role Key from Instrumentation

## Overview

This section removes `SUPABASE_SECRET_KEY` from the required environment variables list in `web/instrumentation.ts` and updates a stale comment in `web/lib/auth/cli-auth.ts` that references the old env var name.

After the other sections in this spec remove the service role key from all application runtime code (health endpoint, agent core, CLI, webhook handler), no production app code reads `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`. The instrumentation startup check should stop requiring it.

## Dependencies

- No dependencies on other sections. This section is in Batch 1 (parallelizable).
- Blocked by: nothing.
- Blocks: section-11-config-docs (documentation updates reference the final instrumentation state).

## Files to Modify

1. **`/home/user/sitemgr/web/instrumentation.ts`** -- Remove `SUPABASE_SECRET_KEY` from the `required` array.
2. **`/home/user/sitemgr/web/lib/auth/cli-auth.ts`** -- Update the comment on line 6 that says `SUPABASE_SECRET_KEY` to say `SUPABASE_SERVICE_ROLE_KEY`.

## Files to Create

1. **`/home/user/sitemgr/web/__tests__/instrumentation.test.ts`** -- New unit test file.

## Tests (Write First)

Create `/home/user/sitemgr/web/__tests__/instrumentation.test.ts` as a Vitest unit test file. The tests dynamically import the `register` function from `web/instrumentation.ts` and verify its behavior by stubbing `process.env.NEXT_RUNTIME` and the relevant env vars, then capturing `console.error` output.

### Test stubs

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("instrumentation register()", () => {
  /**
   * Stub NEXT_RUNTIME to "nodejs" so the register() function
   * actually runs its validation logic.
   */

  it("required vars include NEXT_PUBLIC_SUPABASE_URL", async () => {
    // Stub NEXT_RUNTIME="nodejs", omit NEXT_PUBLIC_SUPABASE_URL,
    // provide all other required vars. Capture console.error.
    // Assert console.error output mentions NEXT_PUBLIC_SUPABASE_URL.
  });

  it("required vars include NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", async () => {
    // Same pattern: omit NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    // assert it appears in the warning.
  });

  it("required vars do NOT include SUPABASE_SECRET_KEY", async () => {
    // Provide NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.
    // Do NOT provide SUPABASE_SECRET_KEY.
    // Provide all webhook vars so they don't appear in output.
    // Assert console.error is NOT called (or its output does not
    // mention SUPABASE_SECRET_KEY).
  });

  it("required vars do NOT include SUPABASE_SERVICE_ROLE_KEY", async () => {
    // Same as above but for SUPABASE_SERVICE_ROLE_KEY.
    // Assert the warning output does not mention it.
  });

  it("warns when required vars are missing", async () => {
    // Stub NEXT_RUNTIME="nodejs", omit all env vars.
    // Assert console.error was called with a message containing
    // "Missing environment variables".
  });
});
```

### Testing approach

- Use `vi.stubEnv()` to set `NEXT_RUNTIME` to `"nodejs"` and control which env vars are present.
- Use `vi.spyOn(console, "error")` to capture warning output.
- Use dynamic `import()` with `vi.resetModules()` between tests so each test gets a fresh module execution of `register()`.
- The key assertion for the "do NOT include" tests: when all legitimate required vars AND all webhook vars are provided, omitting only `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) should produce zero warnings. This proves neither is in the required list.

## Implementation Details

### 1. Update `web/instrumentation.ts`

The current `required` array on line 9-13 is:

```typescript
const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
];
```

Remove the `"SUPABASE_SECRET_KEY"` entry. The final array should be:

```typescript
const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  // SUPABASE_SERVICE_ROLE_KEY removed — not used by application code
];
```

No other changes to the file. The `webhookVars` array and the warning logic remain exactly as-is.

### 2. Update comment in `web/lib/auth/cli-auth.ts`

Line 6 currently reads:

```
 * so the service role key (SUPABASE_SECRET_KEY) is never needed on user machines.
```

Change to:

```
 * so the service role key (SUPABASE_SERVICE_ROLE_KEY) is never needed on user machines.
```

This is a comment-only change. No logic changes in this file.

## Verification

After implementation, confirm:

1. `npm test` passes with the new instrumentation test file.
2. `grep -r "SUPABASE_SECRET_KEY" web/instrumentation.ts` returns zero matches.
3. `grep -r "SUPABASE_SECRET_KEY" web/lib/auth/cli-auth.ts` returns zero matches.
4. Starting the Next.js dev server with only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` set (plus webhook vars) produces no "Missing environment variables" warning for any service role key variant.