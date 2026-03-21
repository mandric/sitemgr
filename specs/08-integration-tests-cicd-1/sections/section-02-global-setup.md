# Section 02: Global Setup and Environment Validation

## Overview

Create a Vitest `globalSetup` file that validates Supabase is running before any integration test executes. This replaces the `describe.skipIf(!canRun)` pattern that allowed 22+ tests to silently skip in CI.

## Context

Current integration tests use this pattern:
```typescript
const canRun = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);
describe.skipIf(!canRun)("Suite Name", () => { ... });
```

This means running `npm run test:integration` without Supabase reports "22 skipped" with a green build — indistinguishable from success. The globalSetup pattern fails the entire suite immediately with a clear error message instead.

## What to Build

### File: `web/__tests__/integration/globalSetup.ts`

The file exports a default async `setup` function (Vitest globalSetup convention).

**Setup function behavior:**

1. Read `NEXT_PUBLIC_SUPABASE_URL` from `process.env` (default: `http://127.0.0.1:54321`)
2. Perform a `fetch()` health check against the Supabase REST API URL (e.g., `${url}/rest/v1/` with the anon key as `apikey` header)
3. Use a 5-second timeout via `AbortController`
4. If the fetch succeeds (any 2xx or 3xx response), Supabase is running — return silently
5. If the fetch fails (network error, timeout, or non-success status), throw an error with this message:
   ```
   Integration tests require a running Supabase instance.

   Run: supabase start
   Then: npm run test:integration

   Expected Supabase at: ${url}
   Error: ${error.message}
   ```

**Design decisions:**
- Use raw `fetch()`, not the Supabase JS client — globalSetup runs in a separate context and shouldn't depend on the client library
- No `provide()`/`inject()` mechanism — tests continue using `getSupabaseConfig()` from `setup.ts` to access connection details
- No teardown function needed — Supabase lifecycle is managed externally (`supabase start`/`stop`)

### Registration

The globalSetup is registered in the vitest config (section-08), not in this file. For now, the file just needs to export the correct function signature.

```typescript
export default async function setup(): Promise<void> { ... }
```

## Tests to Write First

These are manual verification steps, not formal test files:

- Verify: With Supabase running, integration tests execute normally (globalSetup passes silently)
- Verify: With Supabase stopped, running `vitest run --project integration` fails immediately with the descriptive error message (not "22 skipped")
- Verify: With `NEXT_PUBLIC_SUPABASE_URL` set to an invalid URL, globalSetup fails with the URL in the error message

## Files to Create/Modify

| File | Action |
|------|--------|
| `web/__tests__/integration/globalSetup.ts` | CREATE |

## Acceptance Criteria

1. File exports a default async `setup` function
2. When Supabase is running, function returns without error
3. When Supabase is not running, function throws with clear instructions
4. Error message includes the expected URL and the actual error
5. No dependency on `@supabase/supabase-js` — uses raw `fetch()`
6. 5-second timeout prevents hanging
