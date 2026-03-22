# Section 02 Code Review Interview

## Auto-fixes Applied

### 1. Added missing integration test in auth-smoke.test.ts
- **Finding**: Plan required adding a health endpoint integration test to auth-smoke.test.ts, but it was missing.
- **Fix**: Added test that fetches `/api/health` and verifies it returns 200 with `status: "ok"`. Skips gracefully if dev server isn't running.

## Let Go

- **`__dirname` fragility**: The source-reading test is defense-in-depth; the behavioral assertion already covers this via mock verification.
- **`vi.stubEnv` ordering**: Not a bug, just a style preference.
