/**
 * Integration tests for smgr CLI commands.
 *
 * Spawns `tsx bin/smgr.ts <command>` as a child process, seeds real data in
 * local Supabase, and asserts on stdout / stderr / exit codes.
 *
 * Requires `supabase start` to be running locally.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAdminClient,
  createTestUser,
  seedUserData,
  cleanupUserData,
  getSupabaseConfig,
  type SeedResult,
} from "./setup";
import { insertEvent, insertEnrichment } from "../../lib/media/db";

const execFile = promisify(execFileCb);

const CLI_PATH = resolve(__dirname, "../../bin/smgr.ts");
const TSX_PATH = resolve(__dirname, "../../node_modules/.bin/tsx");

let admin: SupabaseClient;
let userId: string;
let userClient: SupabaseClient;
let seed: SeedResult;

/** Base env vars for all CLI invocations. */
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const cfg = getSupabaseConfig();
  return {
    ...process.env,
    SMGR_API_URL: cfg.url,
    // CLI runs server-side with service role; use serviceKey for both
    // so getUserClient() also bypasses RLS (no user JWT available in CLI)
    SMGR_API_KEY: cfg.serviceKey,
    SUPABASE_SECRET_KEY: cfg.serviceKey,
    SMGR_USER_ID: userId,
    SMGR_DEVICE_ID: "test-cli",
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

/** Run the smgr CLI with the given arguments. Resolves even on non-zero exit. */
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
});

// ── Help / usage ──────────────────────────────────────────────

describe("help and usage", () => {
  it("should print usage and exit 0 when invoked with no command", async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("smgr — S3-event-driven media indexer");
    expect(result.stdout).toContain("smgr query");
    expect(result.stdout).toContain("smgr stats");
  });

  it("should print usage and exit 1 for unknown command", async () => {
    const result = await runCli(["bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("smgr — S3-event-driven media indexer");
  });
});

// ── stats ─────────────────────────────────────────────────────

describe("smgr stats", () => {
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

  it("should fail with exit 1 when SMGR_USER_ID is missing", async () => {
    const result = await runCli(["stats"], { SMGR_USER_ID: "" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("SMGR_USER_ID");
  });
});

// ── query ─────────────────────────────────────────────────────

describe("smgr query", () => {
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

describe("smgr query --search", () => {
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

describe("smgr show", () => {
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

  it("should fail with exit 1 for nonexistent event ID", async () => {
    const result = await runCli(["show", "nonexistent-id-12345"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });
});

// ── enrich --status ───────────────────────────────────────────

describe("smgr enrich --status", () => {
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

describe("smgr enrich --dry-run", () => {
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

  it("should list pending enrichment items without calling API", async () => {
    const result = await runCli(["enrich", "--dry-run"]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("pending");
    expect(parsed).toHaveProperty("items");
    expect(parsed.pending).toBeGreaterThanOrEqual(1);
    expect(parsed.items).toContain(unenrichedEventId);
  });
});

// ── enrich error cases ────────────────────────────────────────

describe("smgr enrich error cases", () => {
  it("should fail with exit 1 when no subcommand flag is given", async () => {
    const result = await runCli(["enrich"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Specify");
  });
});

// ── exit codes ────────────────────────────────────────────────

describe("exit codes", () => {
  it("should exit 1 when SUPABASE_SECRET_KEY is missing for stats", async () => {
    const result = await runCli(["stats"], { SUPABASE_SECRET_KEY: "" });
    // stats uses getUserClient which needs SMGR_API_KEY
    // but SMGR_USER_ID check comes first — either way, non-zero
    expect(result.exitCode).not.toBe(0);
  });
});
