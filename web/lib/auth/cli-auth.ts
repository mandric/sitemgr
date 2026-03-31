/**
 * CLI authentication — device code authorization flow.
 *
 * Stores credentials in ~/.sitemgr/credentials.json.
 * The CLI talks only to the web API (Next.js routes) using Bearer tokens.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { exec } from "node:child_process";

// ── Config dir ──────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".sitemgr");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");

export interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email: string;
  expires_at: number; // unix epoch seconds
  device_name?: string;
}

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
}

export function loadCredentials(): StoredCredentials | null {
  try {
    const raw = readFileSync(CREDENTIALS_FILE, "utf-8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

function saveCredentials(creds: StoredCredentials) {
  ensureConfigDir();
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function clearCredentials() {
  try {
    unlinkSync(CREDENTIALS_FILE);
  } catch {
    // Already gone — fine
  }
}

// ── Browser helper ──────────────────────────────────────────────

export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "${url}"`
        : `xdg-open "${url}"`;

  exec(command, (err) => {
    if (err) {
      process.stderr.write(
        `Could not open browser. Visit this URL manually:\n  ${url}\n`,
      );
    }
  });
}

// ── API config resolution ───────────────────────────────────────

/**
 * Resolves the web API URL for the CLI.
 * SMGR_WEB_URL — Next.js web app URL (e.g. http://localhost:3000)
 */
export function resolveApiConfig(): { webUrl: string } {
  const webUrl = process.env.SMGR_WEB_URL?.trim();
  if (!webUrl) throw new Error("SMGR_WEB_URL is required (e.g. http://localhost:3000)");
  return { webUrl };
}

// ── Login (device code flow) ────────────────────────────────────

export async function login(deviceName?: string): Promise<StoredCredentials> {
  const { webUrl } = resolveApiConfig();
  const device_name = deviceName ?? hostname();

  // 1. Initiate device code flow
  const initiateRes = await fetch(`${webUrl}/api/auth/device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_name }),
  });

  if (!initiateRes.ok) {
    const body = await initiateRes.json().catch(() => ({}));
    const msg = typeof body.error === "string" ? body.error : body.error?.message ?? initiateRes.statusText;
    throw new Error(`Failed to initiate device code flow: ${msg}`);
  }

  const { device_code, user_code, verification_url, expires_at, interval } =
    await initiateRes.json();

  // 2. Open browser and print instructions
  openBrowser(verification_url);
  process.stderr.write(`Opening browser... Enter this code if prompted: ${user_code}\n`);
  process.stderr.write("Waiting for browser approval. Press Ctrl+C to cancel.\n");

  // 3. Poll for approval
  const expiresAtMs = new Date(expires_at).getTime();
  const pollInterval = (interval ?? 5) * 1000;

  while (true) {
    if (Date.now() > expiresAtMs) {
      throw new Error("Device code expired. Please run 'smgr login' again.");
    }

    await new Promise((r) => setTimeout(r, pollInterval));

    const pollRes = await fetch(`${webUrl}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code }),
    });

    if (!pollRes.ok) {
      throw new Error("Poll request failed");
    }

    const pollData = await pollRes.json();

    if (pollData.status === "pending") continue;

    if (pollData.status === "expired") {
      throw new Error("Device code expired. Please run 'smgr login' again.");
    }

    if (pollData.status === "denied") {
      throw new Error("Device authorization denied.");
    }

    if (pollData.status === "approved" && pollData.access_token) {
      // 4. Session returned directly from poll endpoint (verifyOtp done server-side)
      const creds: StoredCredentials = {
        access_token: pollData.access_token,
        refresh_token: pollData.refresh_token,
        user_id: pollData.user_id,
        email: pollData.email,
        expires_at: pollData.expires_at ?? 0,
        device_name: device_name,
      };

      saveCredentials(creds);
      return creds;
    }

    // consumed or other terminal status
    if (pollData.status !== "pending") {
      throw new Error(`Unexpected status: ${pollData.status}`);
    }
  }
}

// ── Refresh (called automatically) ──────────────────────────────

export async function refreshSession(): Promise<StoredCredentials | null> {
  const creds = loadCredentials();
  if (!creds) return null;

  // If token expires in more than 60 seconds, no refresh needed
  const now = Math.floor(Date.now() / 1000);
  if (creds.expires_at > now + 60) return creds;

  let webUrl: string;
  try {
    ({ webUrl } = resolveApiConfig());
  } catch {
    // Can't refresh without web URL
    clearCredentials();
    return null;
  }

  const res = await fetch(`${webUrl}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: creds.refresh_token }),
  });

  if (!res.ok) {
    // Refresh failed — credentials are stale
    clearCredentials();
    return null;
  }

  const session = await res.json();

  const updated: StoredCredentials = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    user_id: session.user_id,
    email: session.email ?? creds.email,
    expires_at: session.expires_at ?? 0,
    device_name: creds.device_name,
  };

  saveCredentials(updated);
  return updated;
}

// ── Whoami ──────────────────────────────────────────────────────

export function whoami(): StoredCredentials | null {
  return loadCredentials();
}
