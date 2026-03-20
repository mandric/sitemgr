/**
 * End-to-end integration test for the smgr pipeline.
 *
 * Uploads real images to S3 → discovers them via `smgr watch --once` →
 * enriches with Ollama moondream:1.8b → verifies semantic search.
 *
 * Requires:
 *   - `supabase start` running locally
 *   - Ollama running at localhost:11434 with moondream:1.8b pulled
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAdminClient,
  createTestUser,
  cleanupUserData,
  getSupabaseConfig,
  getS3Config,
} from "./setup";
import {
  createS3Client,
  listS3Objects,
  uploadS3Object,
} from "../../lib/media/s3";

const execFile = promisify(execFileCb);

const CLI_PATH = resolve(__dirname, "../../bin/smgr.ts");
const TSX_PATH = resolve(__dirname, "../../node_modules/.bin/tsx");
const FIXTURES_DIR = resolve(__dirname, "fixtures");

// ── Shared state across sequential tests ─────────────────────

let admin: SupabaseClient;
let userId: string;
let userClient: SupabaseClient;
const eventIds = new Map<string, string>(); // filename → event ID
const uploadedKeys: string[] = [];

// ── CLI helpers (adapted from smgr-cli.test.ts) ──────────────

function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const cfg = getSupabaseConfig();
  return {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: cfg.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.anonKey,
    SUPABASE_SECRET_KEY: cfg.serviceKey,
    SMGR_USER_ID: userId,
    SMGR_DEVICE_ID: "test-e2e",
    NODE_NO_WARNINGS: "1",
    ...extra,
  };
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
  timeout = 30_000,
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFile(TSX_PATH, [CLI_PATH, ...args], {
      env: cliEnv(extraEnv),
      cwd: resolve(__dirname, "../.."),
      timeout,
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

// ── Extra env vars for all e2e CLI calls ─────────────────────

const E2E_ENV = {
  SMGR_S3_BUCKET: "media",
  SMGR_AUTO_ENRICH: "false",
};

// ── Fixture filenames ────────────────────────────────────────

const FIXTURES = ["pineapple.jpg", "dog.jpg", "beach.jpg"] as const;
const S3_PREFIX = `test-e2e-${Date.now()}`;

// ── Tests ────────────────────────────────────────────────────

describe("smgr e2e pipeline", () => {
  beforeAll(async () => {
    // 1. Ollama health check
    const health = await fetch("http://localhost:11434/api/tags").catch(
      () => null,
    );
    if (!health?.ok) {
      throw new Error(
        "Ollama is not running at localhost:11434. " +
          "Start it with: docker-compose up -d ollama ollama-setup",
      );
    }

    // 2. Create test user
    const user = await createTestUser();
    userId = user.userId;
    userClient = user.client;

    // 3. Get admin client
    admin = getAdminClient();

    // 4. Insert model_configs row pointing at local Ollama
    const { error: configErr } = await admin.from("model_configs").insert({
      user_id: userId,
      provider: "ollama",
      base_url: "http://localhost:11434/v1",
      model: "moondream:1.8b",
      is_active: true,
    });
    if (configErr) {
      throw new Error(
        `Failed to insert model_configs: ${configErr.message} (${configErr.code})`,
      );
    }

    // 5. Upload fixture images to S3
    const s3Config = getS3Config();
    const s3 = createS3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
    });

    for (const filename of FIXTURES) {
      const filePath = resolve(FIXTURES_DIR, filename);
      const bytes = readFileSync(filePath);
      const key = `${S3_PREFIX}/${filename}`;
      await uploadS3Object(s3, "media", key, bytes, "image/jpeg");
      uploadedKeys.push(key);
    }

    // 6. Verify uploads are visible
    const objects = await listS3Objects(s3, "media", `${S3_PREFIX}/`);
    const foundKeys = objects.map((o) => o.key);
    for (const key of uploadedKeys) {
      if (!foundKeys.includes(key)) {
        throw new Error(`Upload verification failed: ${key} not found in S3`);
      }
    }
  }, 30_000);

  afterAll(async () => {
    // 1. Delete uploaded S3 objects
    if (uploadedKeys.length > 0) {
      await admin.storage.from("media").remove(uploadedKeys);
    }

    // 2. Clean up model_configs + all user data
    if (userId) {
      await admin.from("model_configs").delete().eq("user_id", userId);
      await cleanupUserData(admin, userId);
    }

    // 3. Sign out and close channels
    if (userClient) {
      await userClient.auth.signOut();
      await userClient.removeAllChannels();
    }
    if (admin) {
      await admin.removeAllChannels();
    }
  }, 30_000);

  // ── Test 1: watch --once discovers uploaded images ────────

  it("watch --once discovers uploaded images", async () => {
    const result = await runCli(
      ["watch", "--once"],
      { ...E2E_ENV, SMGR_S3_BUCKET: "media" },
      60_000,
    );
    expect(result.exitCode).toBe(0);

    // Verify stats show 3 events, all pending enrichment
    const statsResult = await runCli(["stats"], E2E_ENV);
    expect(statsResult.exitCode).toBe(0);
    const stats = JSON.parse(statsResult.stdout);
    expect(stats.total_events).toBe(3);
    expect(stats.pending_enrichment).toBe(3);

    // Query events as JSON and build the eventIds map
    const queryResult = await runCli(
      ["query", "--format", "json"],
      E2E_ENV,
    );
    expect(queryResult.exitCode).toBe(0);
    const parsed = JSON.parse(queryResult.stdout);
    expect(parsed.data).toHaveLength(3);

    for (const event of parsed.data) {
      const remotePath: string = event.remote_path ?? event.s3_key ?? "";
      for (const filename of FIXTURES) {
        if (remotePath.endsWith(filename)) {
          eventIds.set(filename, event.id);
        }
      }
    }

    // Every fixture must have a mapped event ID
    for (const filename of FIXTURES) {
      expect(
        eventIds.has(filename),
        `No event found for fixture ${filename}`,
      ).toBe(true);
    }
  }, 60_000);

  // ── Test 2: enrich --dry-run lists all pending ────────────

  it("enrich --dry-run lists all pending", async () => {
    const result = await runCli(["enrich", "--dry-run"], E2E_ENV);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.pending).toBeGreaterThanOrEqual(3);

    for (const [, eventId] of eventIds) {
      expect(parsed.items).toContain(eventId);
    }
  }, 30_000);

  // ── Test 3: enrich --pending processes all images ─────────

  it("enrich --pending processes all images", async () => {
    const result = await runCli(["enrich", "--pending"], E2E_ENV, 120_000);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.enriched).toBe(3);
    expect(parsed.failed).toBe(0);

    // Post-enrichment sanity check: every event must have a non-empty description
    for (const [filename, eventId] of eventIds) {
      const showResult = await runCli(["show", eventId], E2E_ENV);
      expect(showResult.exitCode).toBe(0);

      const event = JSON.parse(showResult.stdout);
      expect(event.enrichment).toBeDefined();
      expect(
        typeof event.enrichment.description === "string" &&
          event.enrichment.description.length > 0,
        `Model returned empty description for ${filename}. ` +
          "This is a model issue, not a pipeline bug.",
      ).toBe(true);
    }
  }, 120_000);

  // ── Test 4: semantic search finds correct images ──────────

  it("semantic search finds correct images", async () => {
    // Each search term should find its corresponding fixture image
    const searchPairs: Array<[string, string]> = [
      ["pineapple", "pineapple.jpg"],
      ["dog", "dog.jpg"],
      ["beach", "beach.jpg"],
    ];

    for (const [term, filename] of searchPairs) {
      const result = await runCli(
        ["query", "--search", term, "--format", "json"],
        E2E_ENV,
      );
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      const ids = parsed.data.map((e: { id: string }) => e.id);
      expect(
        ids,
        `Search for "${term}" should include event for ${filename}`,
      ).toContain(eventIds.get(filename));
    }
  }, 30_000);

  // ── Test 5: semantic search excludes wrong images ─────────

  it("semantic search excludes wrong images", async () => {
    // Each search term should NOT find the specified unrelated fixture
    const exclusionPairs: Array<[string, string]> = [
      ["car", "pineapple.jpg"],
      ["pineapple", "dog.jpg"],
      ["snow", "beach.jpg"],
    ];

    for (const [term, filename] of exclusionPairs) {
      const result = await runCli(
        ["query", "--search", term, "--format", "json"],
        E2E_ENV,
      );
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      const ids = parsed.data.map((e: { id: string }) => e.id);
      expect(
        ids,
        `Search for "${term}" should NOT include event for ${filename}`,
      ).not.toContain(eventIds.get(filename));
    }
  }, 30_000);

  // ── Test 6: final stats show all enriched ─────────────────

  it("final stats show all enriched", async () => {
    const result = await runCli(["stats"], E2E_ENV);
    expect(result.exitCode).toBe(0);

    const stats = JSON.parse(result.stdout);
    expect(stats.enriched).toBe(3);
    expect(stats.pending_enrichment).toBe(0);
  }, 30_000);
});
