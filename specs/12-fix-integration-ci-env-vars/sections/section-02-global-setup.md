Now I have all the context needed. Here is the section content:

# Section 2: globalSetup.ts — Defensive Env Var Mapping

## Background

The integration test global setup file at `/home/user/sitemgr/web/__tests__/integration/globalSetup.ts` spawns a Next.js dev server before tests run. The dev server needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` environment variables to serve a healthy `/api/health` endpoint.

Currently (line 95), the spawn call passes `{ ...process.env, PORT: String(port) }` as the child process environment. If `NEXT_PUBLIC_*` vars are not in `process.env`, the dev server starts but its health endpoint returns 503, causing `waitForReady()` to time out after 60 seconds.

The codebase uses two parallel naming conventions for the same Supabase connection details:
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Used by the Next.js app (health endpoint, webhook handler)
- `SMGR_API_URL` / `SMGR_API_KEY` — Used by CLI tools and test infrastructure; same values, different names

This section adds a defensive fallback: if `NEXT_PUBLIC_*` vars are not set, fall back to `SMGR_*` vars when constructing the spawn environment. This prevents confusing timeouts if someone runs integration tests locally without `.env.local` or if CI configuration is missing.

## Dependencies

- **Section 1 (CI Workflow)** fixes the root cause by adding `NEXT_PUBLIC_*` vars to CI. This section is a complementary defense-in-depth measure. Neither depends on the other.

## File to Modify

`/home/user/sitemgr/web/__tests__/integration/globalSetup.ts`

## Tests

The TDD plan recommends **option 2: inline verification via CI** rather than extracting and unit-testing the env construction logic separately. The rationale is that this is a simple change and the integration test run itself serves as the test — if the dev server starts and health returns 200, the env vars were correctly provided.

The following behavioral expectations describe what the change must satisfy. They are validated by the integration test suite passing (dev server starts, health endpoint responds 200):

```typescript
// Behavioral expectations (validated by integration test run, not a separate test file):
//
// - spawn env includes NEXT_PUBLIC_SUPABASE_URL when it's already in process.env
// - spawn env falls back NEXT_PUBLIC_SUPABASE_URL to SMGR_API_URL when NEXT_PUBLIC is not set
// - spawn env falls back NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to SMGR_API_KEY when NEXT_PUBLIC is not set
// - spawn env preserves NEXT_PUBLIC value when BOTH NEXT_PUBLIC and SMGR are set (NEXT_PUBLIC wins)
// - spawn env includes PORT set to the configured port
// - spawn env spreads existing process.env vars
```

No new test file is created for this section.

## Implementation

Modify the `setup()` function in `globalSetup.ts`, specifically the spawn call around lines 92-97. Instead of passing `{ ...process.env, PORT: String(port) }` directly, construct the env object beforehand with fallback logic.

### Current code (lines 92-97)

```typescript
  const child = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, PORT: String(port) },
    detached: false,
  });
```

### Changed code

Before the `spawn()` call, construct the env object:

```typescript
  // Defensive fallback: map SMGR_* → NEXT_PUBLIC_* if NEXT_PUBLIC_* are not set.
  // This equivalence is only valid for local Supabase instances where both sets
  // of vars point to the same http://127.0.0.1:54321 endpoint. Integration tests
  // always run against local Supabase, so this is safe.
  const spawnEnv = {
    ...process.env,
    PORT: String(port),
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SMGR_API_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SMGR_API_KEY,
  };

  const child = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: spawnEnv,
    detached: false,
  });
```

### Key behaviors of the nullish coalescing (`??`) approach

1. If `NEXT_PUBLIC_SUPABASE_URL` is already set in `process.env`, it is preserved (the `...process.env` spread sets it, then the explicit property overwrites it with the same value via `??`).
2. If `NEXT_PUBLIC_SUPABASE_URL` is `undefined` but `SMGR_API_URL` is set, the fallback kicks in.
3. If both `NEXT_PUBLIC_*` and `SMGR_*` are set, `NEXT_PUBLIC_*` wins (it is not `undefined`, so `??` does not evaluate the right side).
4. If neither is set, the property value is `undefined`, which is harmless — the key is simply omitted from the child process environment, and the dev server will fail at the health endpoint with the existing 60s timeout error.

### Interaction with `.env.local`

When `npm run dev` starts, Next.js automatically loads `.env.local` if it exists. In local development, `scripts/local-dev.sh` creates this file with `NEXT_PUBLIC_*` vars already set, making the globalSetup fallback redundant. In CI, there is no `.env.local` for the integration job (only the E2E job creates one), so the `$GITHUB_ENV` vars (from Section 1) and this fallback are both needed.

### No additional error handling needed

If neither `NEXT_PUBLIC_*` nor `SMGR_*` vars are available, the dev server will still fail at the health endpoint. The existing 60-second timeout in `waitForReady()` and its error message handle this case adequately.

## Validation

Push to the branch and verify the CI integration test job passes. The dev server should start, the health endpoint should return 200, and tests should run to completion. No local validation is required — CI is the validation environment.