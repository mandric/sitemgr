/**
 * CLI authentication — wraps Supabase Auth for email/password login.
 *
 * Stores credentials in ~/.sitemgr/credentials.json.
 * The CLI uses the anon key (safe to embed) + user JWT for all operations,
 * so the service role key (SUPABASE_SECRET_KEY) is never needed on user machines.
 */

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

// ── Config dir ──────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".sitemgr");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");

export interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email: string;
  expires_at: number; // unix epoch seconds
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

// ── Prompt helpers ──────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);

    let password = "";
    const onData = (ch: Buffer) => {
      const c = ch.toString("utf-8");
      if (c === "\n" || c === "\r") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        process.stderr.write("\n");
        resolve(password);
      } else if (c === "\u0003") {
        // Ctrl-C
        process.exit(130);
      } else if (c === "\u007f" || c === "\b") {
        password = password.slice(0, -1);
      } else {
        password += c;
      }
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}

// ── Supabase URL + anon key ─────────────────────────────────────

function getSupabaseConfig(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.replace(/\s+/g, "");
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");
  if (!anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required");
  return { url, anonKey };
}

// ── Login ───────────────────────────────────────────────────────

export async function login(): Promise<StoredCredentials> {
  const { url, anonKey } = getSupabaseConfig();
  const supabase = createSupabaseClient(url, anonKey);

  const email = await prompt("Email: ");
  const password = await promptPassword("Password: ");

  if (!email || !password) {
    throw new Error("Email and password are required");
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;

  const session = data.session;
  if (!session) throw new Error("No session returned from login");

  const creds: StoredCredentials = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    user_id: session.user.id,
    email: session.user.email ?? email,
    expires_at: session.expires_at ?? 0,
  };

  saveCredentials(creds);
  return creds;
}

// ── Refresh (called automatically) ──────────────────────────────

export async function refreshSession(): Promise<StoredCredentials | null> {
  const creds = loadCredentials();
  if (!creds) return null;

  // If token expires in more than 60 seconds, no refresh needed
  const now = Math.floor(Date.now() / 1000);
  if (creds.expires_at > now + 60) return creds;

  const { url, anonKey } = getSupabaseConfig();
  const supabase = createSupabaseClient(url, anonKey);

  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: creds.refresh_token,
  });

  if (error || !data.session) {
    // Refresh failed — credentials are stale
    clearCredentials();
    return null;
  }

  const updated: StoredCredentials = {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user_id: data.session.user.id,
    email: data.session.user.email ?? creds.email,
    expires_at: data.session.expires_at ?? 0,
  };

  saveCredentials(updated);
  return updated;
}

// ── Whoami ──────────────────────────────────────────────────────

export function whoami(): StoredCredentials | null {
  return loadCredentials();
}
