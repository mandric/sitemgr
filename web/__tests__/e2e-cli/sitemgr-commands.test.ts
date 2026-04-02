/**
 * Integration tests for sitemgr CLI commands.
 *
 * Spawns `tsx bin/sitemgr.ts <command>` as a child process, seeds real data in
 * local Supabase, and asserts on stdout / stderr / exit codes.
 *
 * Requires `supabase start` to be running locally.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAdminClient,
  createTestUser,
  seedUserData,
  cleanupUserData,
  type SeedResult,
} from "../integration/setup";
import { insertEvent, insertEnrichment } from "../../lib/media/db";

const execFile = promisify(execFileCb);

const CLI_PATH = resolve(__dirname, "../../bin/sitemgr.ts");
const TSX_PATH = resolve(__dirname, "../../node_modules/.bin/tsx");

let admin: SupabaseClient;
let userId: string;
let userClient: SupabaseClient;
let seed: SeedResult;
let tempHome: string;

/** Base env vars for all CLI invocations. */
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const port = process.env.WEB_PORT ?? "3000";
  return {
    ...process.env,
    HOME: tempHome,
    SITEMGR_WEB_URL: `http://localhost:${port}`,
    SITEMGR_DEVICE_ID: "test-cli",
    // Prevent Node/tsx from dropping into interactive mode
    NODE_NO_WARNINGS: "1",
    ...extra,
  };
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run the sitemgr CLI with the given arguments. Resolves even on non-zero exit. */
async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFile(TSX_PATH, [CLI_PATH, ...args], {
      env: cliEnv(extraEnv),
      cwd: resolve(__dirname, "../.."),
      timeout: 30_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.code ?? 1,
    };
  }
}

beforeAll(async () => {
  admin = getAdminClient();

  const user = await createTestUser();
  userId = user.userId;
  userClient = user.client;

  // Extract session tokens and write credentials file for CLI
  const { data: sessionData } = await userClient.auth.getSession();
  const session = sessionData.session!;

  tempHome = mkdtempSync(resolve(tmpdir(), "sitemgr-cli-test-"));
  const credsDir = resolve(tempHome, ".sitemgr");
  mkdirSync(credsDir, { mode: 0o700, recursive: true });
  writeFileSync(
    resolve(credsDir, "credentials.json"),
    JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      user_id: userId,
      email: session.user.email,
      expires_at: session.expires_at,
    }),
    { mode: 0o600 },
  );

  // Seed data: 3 events with enrichments, watched keys, etc.
  seed = await seedUserData(admin, userId, {
    eventCount: 3,
    withEnrichments: true,
    withWatchedKeys: true,
    withBucketConfig: false,
    withConversation: false,
  });
}, 30_000);

afterAll(async () => {
  await cleanupUserData(admin, userId);
  await userClient.auth.signOut();
  await Promise.all([
    admin.removeAllChannels(),
    userClient.removeAllChannels(),
  ]);
  // Clean up temp home directory
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

// ── Help / usage ──────────────────────────────────────────────

describe("help and usage", () => {
  it("should print usage and exit 0 when invoked with no command", async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sitemgr — S3-event-driven media indexer");
    expect(result.stdout).toContain("sitemgr query");
    expect(result.stdout).toContain("sitemgr stats");
  });

  it("should print usage and exit 1 for unknown command", async () => {
    const result = await runCli(["bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("sitemgr — S3-event-driven media indexer");
  });
});

// ── stats ─────────────────────────────────────────────────────

describe("sitemgr stats", () => {
  it("should output valid JSON with expected fields", async () => {
    const result = await runCli(["stats"]);
    expect(result.exitCode).toBe(0);

    const stats = JSON.parse(result.stdout);
    expect(stats).toHaveProperty("total_events");
    expect(stats).toHaveProperty("by_content_type");
    expect(stats).toHaveProperty("by_event_type");
    expect(stats).toHaveProperty("enriched");
    expect(stats).toHaveProperty("pending_enrichment");
    expect(stats).toHaveProperty("watched_s3_keys");
    expect(stats.total_events).toBeGreaterThanOrEqual(3);
    expect(stats.watched_s3_keys).toBeGreaterThanOrEqual(3);
  });

  it("should fail with exit 1 when not logged in", async () => {
    const emptyHome = mkdtempSync(resolve(tmpdir(), "sitemgr-no-creds-"));
    const result = await runCli(["stats"], { HOME: emptyHome });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Not logged in");
  });
});

// ── query ─────────────────────────────────────────────────────

describe("sitemgr query", () => {
  it("should output table format by default", async () => {
    const result = await runCli(["query"]);
    expect(result.exitCode).toBe(0);
    // Table header
    expect(result.stdout).toContain("ID");
    expect(result.stdout).toContain("Date");
    expect(result.stdout).toContain("Type");
    expect(result.stdout).toContain("Showing");
  });

  it("should output JSON when --format json is used", async () => {
    const result = await runCli(["query", "--format", "json"]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("data");
    expect(parsed).toHaveProperty("count");
    expect(parsed.count).toBeGreaterThanOrEqual(3);
  });

  it("should respect --limit flag", async () => {
    const result = await runCli(["query", "--format", "json", "--limit", "1"]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.data).toHaveLength(1);
  });

  it("should filter by --device", async () => {
    const result = await runCli(["query", "--format", "json", "--device", `device-${userId.slice(0, 8)}`]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.count).toBeGreaterThanOrEqual(3);
    for (const evt of parsed.data) {
      expect(evt.device_id).toBe(`device-${userId.slice(0, 8)}`);
    }
  });

  it("should return empty results for non-matching device", async () => {
    const result = await runCli(["query", "--format", "json", "--device", "nonexistent-device"]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.count).toBe(0);
    expect(parsed.data).toHaveLength(0);
  });
});

// ── query --search (full-text search) ─────────────────────────

describe("sitemgr query --search", () => {
  const ftsEventId = "cli-fts-test-evt";

  beforeAll(async () => {
    // Insert an event + enrichment with a unique keyword for FTS
    const { error: evtErr } = await insertEvent(admin, {
      id: ftsEventId,
      device_id: "test-cli",
      type: "create",
      content_type: "photo",
      content_hash: `fts-hash-${Date.now()}`,
      local_path: null,
      remote_path: null,
      metadata: null,
      parent_id: null,
      user_id: userId,
    });
    if (evtErr) throw evtErr;

    const { error: enrErr } = await insertEnrichment(
      admin,
      ftsEventId,
      {
        description: "a majestic flamingo standing in shallow water",
        objects: ["flamingo", "water"],
        context: "wildlife photography",
        suggested_tags: ["bird", "flamingo", "nature"],
      },
      userId,
    );
    if (enrErr) throw enrErr;
  });

  it("should find event by enrichment description keyword", async () => {
    const result = await runCli(["query", "--search", "flamingo", "--format", "json"]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.count).toBeGreaterThanOrEqual(1);
    const found = parsed.data.find((e: { id: string }) => e.id === ftsEventId);
    expect(found).toBeDefined();
  });

  it("should return empty for non-matching search", async () => {
    const result = await runCli(["query", "--search", "xyznonexistent99", "--format", "json"]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.count).toBe(0);
  });
});

// ── show ──────────────────────────────────────────────────────

describe("sitemgr show", () => {
  it("should display event details as JSON", async () => {
    const eventId = seed.eventIds[0];
    const result = await runCli(["show", eventId]);
    expect(result.exitCode).toBe(0);

    const event = JSON.parse(result.stdout);
    expect(event.id).toBe(eventId);
    expect(event.user_id).toBe(userId);
    expect(event).toHaveProperty("device_id");
    expect(event).toHaveProperty("type");
    expect(event).toHaveProperty("timestamp");
  });

  it("should include enrichment data when present", async () => {
    const eventId = seed.eventIds[0];
    const result = await runCli(["show", eventId]);
    expect(result.exitCode).toBe(0);

    const event = JSON.parse(result.stdout);
    expect(event).toHaveProperty("enrichment");
    expect(event.enrichment).toHaveProperty("description");
    expect(event.enrichment).toHaveProperty("objects");
    expect(event.enrichment).toHaveProperty("tags");
  });

  it("should fail with exit 1 when no event ID is given", async () => {
    const result = await runCli(["show"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage");
  });

  it("should return null data for nonexistent event ID", async () => {
    const result = await runCli(["show", "nonexistent-id-12345"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.data).toBeNull();
  });
});

// ── enrich --status ───────────────────────────────────────────

describe("sitemgr enrich --status", () => {
  it("should output JSON enrichment status", async () => {
    const result = await runCli(["enrich", "--status"]);
    expect(result.exitCode).toBe(0);

    const status = JSON.parse(result.stdout);
    expect(status).toHaveProperty("total_media");
    expect(status).toHaveProperty("enriched");
    expect(status).toHaveProperty("pending");
    expect(typeof status.total_media).toBe("number");
    expect(typeof status.enriched).toBe("number");
    expect(typeof status.pending).toBe("number");
  });
});

// ── enrich --dry-run ──────────────────────────────────────────

describe("sitemgr enrich --dry-run", () => {
  let unenrichedEventId: string;

  beforeAll(async () => {
    // Insert a photo event without enrichment
    unenrichedEventId = `cli-dryrun-${Date.now()}`;
    const { error } = await insertEvent(admin, {
      id: unenrichedEventId,
      device_id: "test-cli",
      type: "create",
      content_type: "photo",
      content_hash: `dryrun-hash-${Date.now()}`,
      local_path: null,
      remote_path: null,
      metadata: null,
      parent_id: null,
      user_id: userId,
    });
    if (error) throw error;
  });

  it("should fail without bucket name", async () => {
    const result = await runCli(["enrich", "--dry-run"]);
    // Now requires a bucket name as first positional arg
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage");
  });
});

// ── enrich error cases ────────────────────────────────────────

describe("sitemgr enrich error cases", () => {
  it("should fail with exit 1 when no subcommand flag is given", async () => {
    const result = await runCli(["enrich"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage");
  });
});

// ── exit codes ────────────────────────────────────────────────

describe("exit codes", () => {
  it("should exit non-zero when not logged in (no credentials file)", async () => {
    // Use a fresh temp HOME with no credentials
    const emptyHome = mkdtempSync(resolve(tmpdir(), "sitemgr-no-creds-"));
    try {
      const result = await runCli(["stats"], { HOME: emptyHome });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Not logged in");
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
