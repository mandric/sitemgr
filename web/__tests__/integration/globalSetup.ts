/**
 * Vitest globalSetup — validates Supabase is running before integration tests,
 * and optionally spawns a Next.js dev server.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

declare global {
  var __WEB_SERVER__: ChildProcess | undefined;
  var __WEB_SERVER_SPAWNED__: boolean;
}

/** Check if a TCP port is already in use. */
async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

/** Poll a URL until it returns HTTP 200 or the timeout expires. */
async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(t);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Dev server did not become ready at ${url} within ${timeoutMs}ms`);
}

export async function setup(): Promise<void> {
  // 1. Validate required environment variables
  const required: Record<string, string | undefined> = {
    SITEMGR_API_URL: process.env.SITEMGR_API_URL,
    SITEMGR_API_KEY: process.env.SITEMGR_API_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables for integration tests:\n` +
        missing.map((k) => `  - ${k}`).join("\n") +
        `\n\nTo fix, generate .env.local and source it:\n` +
        `  npm run setup:env\n` +
        `  source ../.env.local   # or use npm run test:integration:full\n`,
    );
  }

  // 2. Validate Supabase connectivity
  const url = process.env.SITEMGR_API_URL!;
  const anonKey = process.env.SITEMGR_API_KEY!;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: anonKey },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Integration tests require a running Supabase instance.\n\n` +
        `Quick setup:\n` +
        `  npm run setup:supabase   # start local Supabase\n` +
        `  npm run setup:env        # generate .env.local\n` +
        `  npm run test:integration:full  # or use the all-in-one script\n\n` +
        `Expected Supabase at: ${url}\n` +
        `Error: ${message}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  // 2. Start dev server if not already running
  const port = Number(process.env.WEB_PORT ?? "3000");
  const portInUse = await isPortInUse(port);

  globalThis.__WEB_SERVER_SPAWNED__ = false;

  if (portInUse) {
    // Dev server already running — skip spawning
    return;
  }

  // Defensive fallback: map SITEMGR_* → NEXT_PUBLIC_* if NEXT_PUBLIC_* are not set.
  // This equivalence is only valid for local Supabase instances where both sets
  // of vars point to the same http://127.0.0.1:54321 endpoint. Integration tests
  // always run against local Supabase, so this is safe.
  const spawnEnv = {
    ...process.env,
    PORT: String(port),
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SITEMGR_API_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.SITEMGR_API_KEY,
  };

  // Spawn Next.js dev server
  const child = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: spawnEnv,
    detached: false,
  });

  globalThis.__WEB_SERVER__ = child;
  globalThis.__WEB_SERVER_SPAWNED__ = true;

  // Wait for readiness via health endpoint
  try {
    await waitForReady(`http://localhost:${port}/api/health`, 60_000);
  } catch (err) {
    child.kill("SIGTERM");
    throw err;
  }
}

export async function teardown(): Promise<void> {
  if (!globalThis.__WEB_SERVER_SPAWNED__ || !globalThis.__WEB_SERVER__) {
    return;
  }

  const child = globalThis.__WEB_SERVER__;
  child.kill("SIGTERM");

  // Give it a grace period, then force kill
  await new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);

    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
  });
}
