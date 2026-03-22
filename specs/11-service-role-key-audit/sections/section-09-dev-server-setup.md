Now I have all the context needed. Let me write the section.

# Section 9: Add Next.js Dev Server to `globalSetup.ts`

## Goal

Integration tests that hit HTTP endpoints (such as `GET /api/health` in `auth-smoke.test.ts`) require a running Next.js dev server. Currently, the developer must manually start `npm run dev` before running integration tests. This section adds automatic dev server lifecycle management to `web/__tests__/integration/globalSetup.ts` so integration tests are self-contained.

## Dependencies

- **Section 02 (health endpoint)** must be complete first. The health endpoint at `/api/health` is the readiness probe target. After section 02, it uses `getUserClient()` with the anon key, meaning it works without `SUPABASE_SERVICE_ROLE_KEY` in the environment.

## Background

The current `globalSetup.ts` at `/home/user/sitemgr/web/__tests__/integration/globalSetup.ts` only validates that Supabase is reachable (fetches `${url}/rest/v1/` with the anon key). It exports a single `setup()` function and no teardown. The vitest config at `/home/user/sitemgr/web/vitest.config.ts` references it under the `integration` project:

```typescript
globalSetup: ["__tests__/integration/globalSetup.ts"],
```

Vitest `globalSetup` modules can export both a `setup()` function and a `teardown()` function (or return a teardown function from `setup()`). The teardown runs after all test files complete.

The integration test suite runs with `fileParallelism: false` and a `testTimeout` of 60000ms and `hookTimeout` of 30000ms.

The Next.js dev server is started via `npm run dev` (which runs `next dev`) and by default listens on port 3000. The `/api/health` endpoint (after section 02) returns `200` with `{ status: "ok" }` when the database is reachable, or `503` when it is not.

## Tests

This section modifies test infrastructure, not application code. The `globalSetup.ts` file itself is not unit-tested. Verification is behavioral: running `npm run test:integration` without a manually-started dev server should succeed because `globalSetup` starts one automatically.

From the TDD plan, the verification criteria are:

```
# Test: globalSetup spawns dev server when port 3000 is not in use
# Test: globalSetup skips spawning when dev server already running on port 3000
# Test: globalSetup polls /api/health until 200 (timeout 60s)
# Test: globalSetup stores child process on globalThis.__WEB_SERVER__
# Test: teardown kills the spawned process (only if we spawned it)
# Test: auth-smoke tests can hit /api/health after globalSetup runs
```

These are verified by running the integration suite in both scenarios (dev server pre-started, and not pre-started) and confirming all tests pass. No separate test file is created for globalSetup itself.

### Integration verification test (extend existing)

In `/home/user/sitemgr/web/__tests__/integration/auth-smoke.test.ts`, add a test case that confirms the dev server is reachable:

```
# Test: GET /api/health returns 200 without service role key in environment
```

This test does a plain `fetch("http://localhost:3000/api/health")` and asserts a 200 response with `status: "ok"` in the JSON body. It exercises the full chain: globalSetup started the server, the health endpoint uses the anon key (section 02), and the response confirms DB connectivity.

## Implementation

### File to modify: `/home/user/sitemgr/web/__tests__/integration/globalSetup.ts`

The existing `setup()` function validates Supabase connectivity. Extend it with the following behavior after the Supabase check succeeds:

**1. Port detection.** Check whether the configured port (default 3000, overridable via `WEB_PORT` env var) is already in use. Use Node.js `net.createServer()` to attempt binding to the port. If binding fails with `EADDRINUSE`, another process (likely a manually-started dev server) is already listening -- skip spawning and set a flag so teardown knows not to kill it.

**2. Spawn the dev server.** If the port is free, use `child_process.spawn` to run `npm run dev` with the `PORT` environment variable set. Spawn with `{ cwd: process.cwd(), stdio: "pipe", detached: false }`. The `stdio: "pipe"` setting prevents dev server output from polluting test output. Inherit the current `process.env` so the dev server picks up `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and other required vars.

**3. Poll for readiness.** After spawning, poll `http://localhost:${port}/api/health` in a loop. Use `fetch` with a short per-request timeout (2 seconds). Retry every 1 second. Total timeout: 60 seconds. If the health endpoint returns HTTP 200, the server is ready. If the timeout expires, kill the spawned process and throw an error with a clear message.

**4. Store the process reference.** Save the `ChildProcess` on `globalThis.__WEB_SERVER__` so the teardown function can access it. Also store a boolean `globalThis.__WEB_SERVER_SPAWNED__` to distinguish "we spawned it" from "it was already running."

**5. Export a teardown function.** Add a named export `teardown()` (or return the teardown from `setup()`). In teardown, check `globalThis.__WEB_SERVER_SPAWNED__`. If true, kill the process stored on `globalThis.__WEB_SERVER__` using `process.kill()`. Use the child's PID directly. Give it a SIGTERM and a short grace period, then SIGKILL if it has not exited.

### Key design decisions

- **Port detection via `net.createServer`** is more reliable than shelling out to `lsof` or `ss`, which may not be available on all platforms.
- **`stdio: "pipe"`** keeps test output clean. If debugging is needed, the developer can start the dev server manually (which globalSetup detects and skips).
- **60-second timeout** matches the existing `testTimeout` in the vitest config and accounts for Next.js cold compilation time.
- **No `detached: true`** -- the child process is tied to the test runner's lifetime. If vitest crashes, the OS cleans up the child.
- **Health endpoint as readiness probe** -- this is the standard pattern and the endpoint is already implemented (section 02). It confirms both "Next.js is serving requests" and "the database is reachable."

### Type declaration for globalThis

Declare the custom properties on `globalThis` to satisfy TypeScript:

```typescript
declare global {
  // eslint-disable-next-line no-var
  var __WEB_SERVER__: import("child_process").ChildProcess | undefined;
  // eslint-disable-next-line no-var
  var __WEB_SERVER_SPAWNED__: boolean;
}
```

Place this at the top of `globalSetup.ts`.

### Function signatures (stubs)

```typescript
/**
 * Check if a TCP port is already in use.
 * Returns true if something is listening on the port.
 */
async function isPortInUse(port: number): Promise<boolean>

/**
 * Poll a URL until it returns HTTP 200 or the timeout expires.
 * Throws if the timeout is reached.
 */
async function waitForReady(url: string, timeoutMs: number): Promise<void>

/**
 * Vitest globalSetup entry point.
 * 1. Validates Supabase connectivity (existing behavior).
 * 2. Spawns Next.js dev server if port is free.
 * 3. Polls /api/health until ready.
 */
export async function setup(): Promise<void>

/**
 * Vitest globalSetup teardown.
 * Kills the dev server if we spawned it.
 */
export async function teardown(): Promise<void>
```

### File to modify: `/home/user/sitemgr/web/__tests__/integration/auth-smoke.test.ts`

Add a new `describe` block (or a test within the existing `anon key` describe block) that fetches the health endpoint over HTTP:

```typescript
describe("health endpoint", () => {
  it("returns 200 via HTTP (dev server running)", async () => {
    // globalSetup ensures the dev server is running
    const port = process.env.WEB_PORT ?? "3000";
    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
```

### Vitest config

No changes needed to `/home/user/sitemgr/web/vitest.config.ts`. The existing `globalSetup` reference already points to the file being modified. Vitest automatically discovers both `setup` and `teardown` named exports.

## Verification steps

1. Stop any running dev server on port 3000.
2. Run `cd /home/user/sitemgr/web && npm run test:integration`.
3. Confirm the test output shows the dev server starting (no manual intervention).
4. Confirm `auth-smoke.test.ts` health endpoint test passes.
5. Start `npm run dev` manually in another terminal.
6. Run `npm run test:integration` again.
7. Confirm globalSetup detects the existing server and skips spawning.
8. Confirm all tests still pass.
9. After tests complete, confirm the manually-started dev server is still running (teardown did not kill it).