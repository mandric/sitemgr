/**
 * Vitest globalSetup — validates Supabase is running before integration tests,
 * and optionally spawns a Next.js dev server.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

declare global {
  // eslint-disable-next-line no-var
  var __WEB_SERVER__: ChildProcess | undefined;
  // eslint-disable-next-line no-var
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
  // 1. Validate Supabase connectivity
  const url = process.env.SMGR_API_URL ?? "http://127.0.0.1:54321";
  const anonKey = process.env.SMGR_API_KEY ?? "";

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
        `Run: supabase start\n` +
        `Then: npm run test:integration\n\n` +
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

  // Spawn Next.js dev server
  const child = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, PORT: String(port) },
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
