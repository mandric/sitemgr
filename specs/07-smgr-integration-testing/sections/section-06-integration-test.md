# Section 6: Integration Test — smgr-e2e.test.ts

## Goal

Create an end-to-end integration test that exercises the full smgr pipeline: upload images to S3, discover them via `smgr watch --once`, enrich with a real Ollama vision model, and verify semantic search returns correct results.

This is the main deliverable of the integration testing split. All prior sections (DB migration, enrichment wiring, CLI startup, Docker Compose, fixture images) exist to support this test.

## Prerequisites

Before implementing this section:

1. **Sections 1–5 must be complete.** The `model_configs` table must exist, `enrichImage` must accept a model config, the CLI must load config at startup, Docker Compose must define the Ollama service, and fixture images must be in place.
2. **Ollama must be running** with the `moondream:1.8b` model pulled. Start it with `docker-compose up -d ollama ollama-setup`.
3. **Supabase must be running locally** (`supabase start`).

## File to Create

```
web/__tests__/integration/smgr-e2e.test.ts
```

## Full Implementation

```typescript
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
```

## How the Test Works

### Setup Phase (beforeAll)

The test creates an isolated environment for the pipeline run:

1. **Ollama health check** — Fails fast with a clear error message if Ollama is not reachable, rather than timing out during enrichment.
2. **Test user creation** — Uses `createTestUser()` from `setup.ts` to create a fresh auth user and authenticated Supabase client.
3. **Model config insertion** — Inserts a `model_configs` row pointing at the local Ollama instance (`http://localhost:11434/v1`, model `moondream:1.8b`). This is what causes the CLI to use Ollama instead of the Anthropic API.
4. **Fixture upload** — Reads the three fixture JPEGs (created in Section 5) from disk and uploads them to the `media` S3 bucket under a timestamped prefix (`test-e2e-<timestamp>/`). The timestamp prevents collisions between parallel test runs.
5. **Upload verification** — Calls `listS3Objects` to confirm all three files are visible in S3 before proceeding.

### Sequential Test Flow

The six `it` blocks must run in order because each depends on state from the previous one:

| Test | What it does | Key assertion |
|------|-------------|---------------|
| 1. watch --once | Discovers the 3 uploaded files, creates events in the DB | `stats.total_events === 3`, all 3 fixtures mapped to event IDs |
| 2. enrich --dry-run | Lists pending enrichments without calling the model | All 3 event IDs appear in dry-run output |
| 3. enrich --pending | Sends each image to Ollama for description | `enriched === 3`, `failed === 0`, every description is non-empty |
| 4. search (positive) | Searches for "pineapple", "dog", "beach" | Each term finds the correct event |
| 5. search (negative) | Searches for "car", "pineapple" (for dog), "snow" | Each term excludes the wrong event |
| 6. final stats | Confirms all events are enriched | `enriched === 3`, `pending_enrichment === 0` |

### Cleanup Phase (afterAll)

Runs regardless of test pass/fail:

1. Deletes uploaded S3 objects from the `media` bucket.
2. Deletes the `model_configs` row for the test user.
3. Calls `cleanupUserData` to remove events, enrichments, watched_keys, and the auth user.
4. Signs out the user client and closes all Supabase realtime channels to prevent dangling handles.

## Key Design Decisions

### Why copy `runCli` and `cliEnv` instead of importing?

These helpers reference module-scoped variables (`userId`) that differ between test files. The CLI test uses seeded data with a different user. Sharing them would require refactoring both files to accept userId as a parameter, which is unnecessary complexity for two test files.

### Why `SMGR_AUTO_ENRICH: "false"` during watch?

The test separates watch (discovery) from enrich (AI processing) into distinct steps so each can be asserted independently. If auto-enrich were enabled, watch would trigger enrichment inline, making it impossible to verify the dry-run step or measure enrichment results separately.

### Why subject-specific search terms (not abstract ones)?

The positive searches use "pineapple", "dog", "beach" — the exact subjects in the photos. The negative searches use "car", "snow" — terms that genuinely cannot appear in correct descriptions of the fixture images. This avoids flaky tests caused by models producing unexpected but valid descriptions.

### Why a timeout of 120s for enrich --pending?

Ollama running moondream:1.8b on CPU (common in CI) can take 10–30 seconds per image. With 3 images plus overhead, 120 seconds provides comfortable margin.

### Why `E2E_ENV` as a constant?

Every CLI call in this test needs `SMGR_S3_BUCKET` and `SMGR_AUTO_ENRICH`. Defining them once as `E2E_ENV` avoids repetition and ensures consistency.

## Imports from Existing Code

| Import | Source | Purpose |
|--------|--------|---------|
| `getAdminClient` | `./setup` | Service-role Supabase client for DB operations |
| `createTestUser` | `./setup` | Creates auth user + authenticated client |
| `cleanupUserData` | `./setup` | Deletes all user data from all tables |
| `getSupabaseConfig` | `./setup` | URL and keys for CLI env vars |
| `getS3Config` | `./setup` | Endpoint and credentials for S3 operations |
| `createS3Client` | `../../lib/media/s3` | Creates an S3 client instance |
| `listS3Objects` | `../../lib/media/s3` | Lists objects in an S3 bucket (used for upload verification) |
| `uploadS3Object` | `../../lib/media/s3` | Uploads fixture images to S3 |

## Acceptance Criteria

- [ ] File `web/__tests__/integration/smgr-e2e.test.ts` exists and matches the implementation above.
- [ ] Test passes when run with Supabase and Ollama both running locally:
  ```bash
  npx vitest run web/__tests__/integration/smgr-e2e.test.ts --timeout 300000
  ```
- [ ] All 3 fixture images are discovered by `watch --once`.
- [ ] All 3 images are enriched with non-empty descriptions by Ollama.
- [ ] Semantic search for "pineapple" returns the pineapple event.
- [ ] Semantic search for "dog" returns the dog event.
- [ ] Semantic search for "beach" returns the beach event.
- [ ] Negative search assertions pass (no false positives).
- [ ] Cleanup removes all test data (S3 objects, DB rows, auth user).

## Files Referenced (read-only)

| File | Why |
|------|-----|
| `web/__tests__/integration/setup.ts` | `createTestUser`, `getAdminClient`, `cleanupUserData`, `getSupabaseConfig`, `getS3Config` |
| `web/__tests__/integration/smgr-cli.test.ts` | `runCli` and `cliEnv` patterns (copied and adapted) |
| `web/lib/media/s3.ts` | `createS3Client`, `listS3Objects`, `uploadS3Object` |
| `web/__tests__/integration/fixtures/` | `pineapple.jpg`, `dog.jpg`, `beach.jpg` (created in Section 5) |
