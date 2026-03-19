#!/usr/bin/env npx tsx
/**
 * smgr CLI — TypeScript port of the Python prototype.
 * Talks to Supabase Postgres (not SQLite).
 *
 * Usage:
 *   npx tsx bin/smgr.ts query --search "beach" --format json
 *   npx tsx bin/smgr.ts stats
 *   npx tsx bin/smgr.ts show <event_id>
 *   npx tsx bin/smgr.ts enrich --pending
 *   npx tsx bin/smgr.ts watch --once
 */

import { parseArgs } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import {
  queryEvents,
  showEvent,
  getStats,
  getEnrichStatus,
  getPendingEnrichments,
  insertEvent,
  insertEnrichment,
  upsertWatchedKey,
  getWatchedKeys,
  findEventByHash,
} from "../lib/media/db";
import {
  sha256Bytes,
  newEventId,
  detectContentType,
  isMediaKey,
  s3Metadata,
  getMimeType,
} from "../lib/media/utils";
import { createS3Client, listS3Objects, downloadS3Object, uploadS3Object } from "../lib/media/s3";
import { enrichImage } from "../lib/media/enrichment";

// ── Helpers ──────────────────────────────────────────────────

/** Get the user_id from SMGR_USER_ID env var (required for write operations after migration). */
function requireUserId(): string {
  const userId = process.env.SMGR_USER_ID;
  if (!userId) die("Set SMGR_USER_ID environment variable (user UUID for tenant-scoped operations)");
  return userId;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function printJson(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

// ── Commands ─────────────────────────────────────────────────

async function cmdQuery(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      search: { type: "string" },
      type: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      device: { type: "string" },
      limit: { type: "string", default: "20" },
      offset: { type: "string", default: "0" },
      format: { type: "string", default: "table" },
    },
  });

  const userId = requireUserId();
  const result = await queryEvents({
    userId,
    search: values.search,
    type: values.type,
    since: values.since,
    until: values.until,
    device: values.device,
    limit: parseInt(values.limit!, 10),
    offset: parseInt(values.offset!, 10),
  });

  if (values.format === "json") {
    printJson(result);
  } else {
    const events = result.events as Record<string, unknown>[];
    console.log();
    console.log(
      "ID".padEnd(28) +
        "Date".padEnd(22) +
        "Type".padEnd(8) +
        "Path/Key"
    );
    console.log("─".repeat(100));

    for (const evt of events) {
      const ts = String(evt.timestamp ?? "").slice(0, 19).replace("T", " ");
      const meta = (evt.metadata as Record<string, unknown>) ?? {};
      const path =
        (evt.local_path as string) ??
        (evt.remote_path as string) ??
        (meta.s3_key as string) ??
        "";
      const display = path.length > 40 ? "..." + path.slice(-37) : path;
      console.log(
        String(evt.id).padEnd(28) +
          ts.padEnd(22) +
          String(evt.content_type ?? "").padEnd(8) +
          display
      );
    }
    console.log(`\nShowing ${events.length} of ${result.total} events`);
  }
}

async function cmdShow(args: string[]) {
  const eventId = args[0];
  if (!eventId) die("Usage: smgr show <event_id>");

  const userId = requireUserId();
  const event = await showEvent(eventId, userId);
  if (!event) die(`Event not found: ${eventId}`);

  printJson(event);
}

async function cmdStats() {
  const stats = await getStats(requireUserId());
  printJson(stats);
}

async function cmdEnrich(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      pending: { type: "boolean", default: false },
      status: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const userId = requireUserId();

  if (values.status) {
    const status = await getEnrichStatus(userId);
    printJson(status);
    return;
  }

  const eventId = positionals[0];

  if (eventId) {
    // Enrich a specific event
    const event = await showEvent(eventId, userId);
    if (!event) die(`Event not found: ${eventId}`);

    const meta = (event.metadata as Record<string, unknown>) ?? {};
    const remotePath = event.remote_path as string | null;
    const s3Key = (meta.s3_key as string) ?? null;

    if (!remotePath && !s3Key) die("Event has no S3 path to download from");

    const bucket = process.env.SMGR_S3_BUCKET;
    if (!bucket) die("Set SMGR_S3_BUCKET to download images for enrichment");

    const key = s3Key ?? remotePath!.replace(`s3://${bucket}/`, "");
    const s3 = createS3Client();
    const imageBytes = await downloadS3Object(s3, bucket, key);
    const mime = (meta.mime_type as string) ?? getMimeType(key);

    console.log(`Enriching event ${eventId}...`);
    const result = await enrichImage(imageBytes, mime);
    await insertEnrichment(eventId, result, userId);
    console.log("Done.");
    return;
  }

  if (values.pending) {
    const pending = await getPendingEnrichments(userId);
    if (pending.length === 0) {
      console.log("No pending enrichments.");
      return;
    }

    console.log(`Found ${pending.length} items pending enrichment.`);
    const bucket = process.env.SMGR_S3_BUCKET;
    if (!bucket) die("Set SMGR_S3_BUCKET to download images for enrichment");

    const s3 = createS3Client();
    let done = 0;
    let failed = 0;

    for (let i = 0; i < pending.length; i++) {
      const event = pending[i];
      const meta = (event.metadata as Record<string, unknown>) ?? {};
      const s3Key =
        (meta.s3_key as string) ??
        (event.remote_path
          ? String(event.remote_path).replace(`s3://${bucket}/`, "")
          : null);

      if (!s3Key) {
        console.log(`[${i + 1}/${pending.length}] ${event.id} — no S3 key, skipping`);
        continue;
      }

      console.log(`[${i + 1}/${pending.length}] Enriching ${event.id}...`);
      try {
        const imageBytes = await downloadS3Object(s3, bucket, s3Key);
        const mime = (meta.mime_type as string) ?? getMimeType(s3Key);
        const result = await enrichImage(imageBytes, mime);
        await insertEnrichment(event.id, result, userId);
        done++;
        console.log("  Done.");
      } catch (err) {
        failed++;
        console.error(`  Failed: ${err}`);
      }
    }
    console.log(`\nEnriched ${done}, failed ${failed}, total ${pending.length}`);
    return;
  }

  die("Specify --pending, --status, or an event ID.");
}

async function cmdWatch(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      once: { type: "boolean", default: false },
    },
  });

  const bucket = process.env.SMGR_S3_BUCKET;
  if (!bucket) die("Set SMGR_S3_BUCKET environment variable");

  const userId = requireUserId();
  const prefix = process.env.SMGR_S3_PREFIX ?? "";
  const interval = parseInt(process.env.SMGR_WATCH_INTERVAL ?? "30", 10);
  const autoEnrich = (process.env.SMGR_AUTO_ENRICH ?? "true").toLowerCase() !== "false";
  const deviceId = process.env.SMGR_DEVICE_ID ?? "default";

  const s3 = createS3Client();

  console.log(`Watching s3://${bucket}/${prefix}`);
  console.log(`Poll interval: ${interval}s | Auto-enrich: ${autoEnrich}`);

  let running = true;
  const shutdown = () => {
    running = false;
    console.log("\nShutting down...");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
      const objects = await listS3Objects(s3, bucket, prefix);
      const mediaObjects = objects.filter((o) => isMediaKey(o.key));
      const seenKeys = await getWatchedKeys(userId);
      const newObjects = mediaObjects.filter((o) => !seenKeys.has(o.key));

      if (newObjects.length > 0) {
        const now = new Date().toLocaleTimeString();
        console.log(`[${now}] Found ${newObjects.length} new objects`);

        for (const obj of newObjects) {
          console.log(`  Processing: ${obj.key}`);
          try {
            const imageBytes = await downloadS3Object(s3, bucket, obj.key);
            const contentHash = sha256Bytes(imageBytes);

            const existingId = await findEventByHash(contentHash, userId);
            if (existingId) {
              await upsertWatchedKey(obj.key, existingId, obj.etag, obj.size, userId);
              console.log(`    Already indexed (hash match)`);
              continue;
            }

            const eventId = newEventId();
            const contentType = detectContentType(obj.key);
            const meta = s3Metadata(obj.key, obj.size, obj.etag);
            const remotePath = `s3://${bucket}/${obj.key}`;

            await insertEvent({
              id: eventId,
              device_id: deviceId,
              type: "create",
              content_type: contentType,
              content_hash: contentHash,
              local_path: null,
              remote_path: remotePath,
              metadata: meta,
              parent_id: null,
              user_id: userId,
            });
            await upsertWatchedKey(obj.key, eventId, obj.etag, obj.size, userId);
            console.log(`    Created event ${eventId}`);

            if (autoEnrich && contentType === "photo") {
              const mime = getMimeType(obj.key);
              if (mime.startsWith("image/")) {
                console.log("    Enriching...");
                try {
                  const result = await enrichImage(imageBytes, mime);
                  await insertEnrichment(eventId, result, userId);
                  console.log("    Enriched.");
                } catch (err) {
                  console.error(`    Enrichment failed: ${err}`);
                }
              }
            }
          } catch (err) {
            console.error(`    Error: ${err}`);
            await upsertWatchedKey(obj.key, null, obj.etag, obj.size, userId);
          }
        }
      }
    } catch (err) {
      console.error(`Poll error: ${err}`);
    }

    if (values.once) break;

    // Sleep in 1s increments for graceful shutdown
    for (let i = 0; i < interval && running; i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function cmdAdd(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      prefix: { type: "string", default: "" },
      enrich: { type: "boolean", default: true },
    },
    allowPositionals: true,
  });

  const filePath = positionals[0];
  if (!filePath) die("Usage: smgr add <file> [--prefix path/] [--no-enrich]");

  const bucket = process.env.SMGR_S3_BUCKET;
  if (!bucket) die("Set SMGR_S3_BUCKET environment variable");

  const userId = requireUserId();
  const deviceId = process.env.SMGR_DEVICE_ID ?? "default";

  const absPath = resolve(filePath);
  const stat = statSync(absPath);
  if (!stat.isFile()) die(`Not a file: ${absPath}`);

  const fileBytes = readFileSync(absPath);
  const contentHash = sha256Bytes(Buffer.from(fileBytes));
  const fileName = basename(absPath);
  const contentType = detectContentType(fileName);
  const mimeType = getMimeType(fileName);

  // Check for duplicates
  const existing = await findEventByHash(contentHash, userId);
  if (existing) {
    console.log(`File already indexed (event ${existing}), skipping.`);
    return;
  }

  // Upload to S3
  const s3Key = values.prefix ? `${values.prefix}${fileName}` : fileName;
  const s3 = createS3Client();

  console.log(`Uploading ${fileName} to s3://${bucket}/${s3Key}...`);
  await uploadS3Object(s3, bucket, s3Key, Buffer.from(fileBytes), mimeType);

  // Create event
  const eventId = newEventId();
  const remotePath = `s3://${bucket}/${s3Key}`;
  const meta = {
    mime_type: mimeType,
    size_bytes: stat.size,
    source: "cli-add",
    s3_key: s3Key,
    original_path: absPath,
  };

  await insertEvent({
    id: eventId,
    device_id: deviceId,
    type: "create",
    content_type: contentType,
    content_hash: contentHash,
    local_path: absPath,
    remote_path: remotePath,
    metadata: meta,
    parent_id: null,
    user_id: userId,
  });

  // Track as watched key
  await upsertWatchedKey(s3Key, eventId, "", stat.size, userId);

  console.log(`Created event ${eventId}`);

  // Optionally enrich
  if (values.enrich && contentType === "photo" && mimeType.startsWith("image/")) {
    console.log("Enriching...");
    try {
      const result = await enrichImage(Buffer.from(fileBytes), mimeType);
      await insertEnrichment(eventId, result, userId);
      console.log("Enriched.");
    } catch (err) {
      console.error(`Enrichment failed: ${err}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);

const commands: Record<string, (args: string[]) => Promise<void>> = {
  query: cmdQuery,
  show: cmdShow,
  stats: () => cmdStats(),
  enrich: cmdEnrich,
  watch: cmdWatch,
  add: cmdAdd,
};

if (!command || !(command in commands)) {
  console.log(`smgr — S3-event-driven media indexer

Usage:
  smgr query [--search Q] [--type TYPE] [--format json] [--limit N]
  smgr show <event_id>
  smgr stats
  smgr enrich [--pending] [--status] [<event_id>]
  smgr watch [--once]
  smgr add <file> [--prefix path/] [--no-enrich]

Environment:
  NEXT_PUBLIC_SUPABASE_URL     Supabase project URL
  SUPABASE_SECRET_KEY    Supabase service role key
  SMGR_S3_BUCKET               S3 bucket name
  SMGR_S3_ENDPOINT             Custom S3 endpoint (for Supabase Storage)
  SMGR_S3_REGION               AWS region (default: us-east-1)
  ANTHROPIC_API_KEY            For enrichment
  SMGR_USER_ID                 User UUID for tenant-scoped operations
  SMGR_DEVICE_ID               Device identifier (default: default)
  SMGR_WATCH_INTERVAL          Poll interval in seconds (default: 30)
  SMGR_AUTO_ENRICH             Auto-enrich on watch (default: true)`);
  process.exit(command ? 1 : 0);
}

commands[command](rest).catch((err) => {
  console.error(`Error: ${err.message ?? err}`);
  process.exit(1);
});
