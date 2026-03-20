#!/usr/bin/env npx tsx
/**
 * smgr CLI — TypeScript port of the Python prototype.
 * Talks to Supabase Postgres (not SQLite).
 *
 * Usage:
 *   npx tsx bin/smgr.ts query --search "beach" --format json
 *   npx tsx bin/smgr.ts stats
 *   npx tsx bin/smgr.ts show <event_id>
 *   npx tsx bin/smgr.ts enrich --pending --concurrency 3
 *   npx tsx bin/smgr.ts watch --once --interval 60 --max-errors 5
 */

import { parseArgs } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import pLimit from "p-limit";
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
import type { ModelConfig } from "../lib/media/enrichment";
import { getModelConfig } from "../lib/media/db";
import { createLogger, LogComponent } from "../lib/logger";
import { runWithRequestId } from "../lib/request-context";
import { S3ErrorType } from "../lib/media/s3-errors";

const logger = createLogger(LogComponent.CLI);

// ── Exit codes and error handling ───────────────────────────────

const EXIT = {
  SUCCESS:  0,
  USER:     1,
  SERVICE:  2,
  INTERNAL: 3,
} as const;
type ExitCode = typeof EXIT[keyof typeof EXIT];

let verboseMode = false;
let modelConfig: ModelConfig | undefined;

function cliError(message: string, code: ExitCode = EXIT.USER, detail?: string): never {
  console.error(`Error: ${message}`);
  if (verboseMode && detail) {
    console.error(`Detail: ${detail}`);
  }
  process.exit(code);
}

function exitCodeForS3Error(err: unknown): ExitCode {
  const t = (err as Record<string, unknown>)?.s3ErrorType as S3ErrorType | undefined;
  if (t === S3ErrorType.AccessDenied) return EXIT.USER;
  if (t === S3ErrorType.NotFound) return EXIT.USER;
  if (t === S3ErrorType.NetworkError) return EXIT.SERVICE;
  if (t === S3ErrorType.ServerError) return EXIT.SERVICE;
  if (t === S3ErrorType.Timeout) return EXIT.SERVICE;
  return EXIT.INTERNAL;
}

// ── Helpers ──────────────────────────────────────────────────

function requireUserId(): string {
  const userId = process.env.SMGR_USER_ID;
  if (!userId) {
    cliError(
      "Set SMGR_USER_ID environment variable (user UUID for tenant-scoped operations)",
      EXIT.USER,
    );
  }
  return userId;
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
      verbose: { type: "boolean", default: false },
    },
  });

  if (values.verbose) verboseMode = true;
  const userId = requireUserId();
  const { data, count, error } = await queryEvents({
    userId,
    search: values.search,
    type: values.type,
    since: values.since,
    until: values.until,
    device: values.device,
    limit: parseInt(values.limit!, 10),
    offset: parseInt(values.offset!, 10),
  });
  if (error) cliError(`Query failed: ${(error as Error).message ?? error}`, EXIT.SERVICE);

  if (values.format === "json") {
    printJson({ data, count });
  } else {
    const events = (data ?? []) as Record<string, unknown>[];
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
    console.log(`\nShowing ${events.length} of ${count ?? 0} events`);
  }
}

async function cmdShow(args: string[]) {
  const eventId = args[0];
  if (!eventId) cliError("Usage: smgr show <event_id>");

  const userId = requireUserId();
  const { data: event, error } = await showEvent(eventId, userId);
  if (error) cliError(`Show failed: ${(error as Error).message ?? error}`, EXIT.SERVICE);
  if (!event) cliError(`Event not found: ${eventId}`);

  printJson(event);
}

async function cmdStats() {
  const { data: stats, error } = await getStats(requireUserId());
  if (error) cliError(`Stats failed: ${(error as Error).message ?? error}`, EXIT.SERVICE);
  printJson(stats);
}

async function cmdEnrich(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      pending: { type: "boolean", default: false },
      status: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      concurrency: { type: "string", default: "3" },
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.verbose) verboseMode = true;
  const concurrency = Math.max(1, parseInt(values.concurrency ?? "3", 10));
  const dryRun = values["dry-run"] ?? false;

  const userId = requireUserId();

  if (values.status) {
    const { data: status, error } = await getEnrichStatus(userId);
    if (error) cliError(`Enrich status failed: ${(error as Error).message ?? error}`, EXIT.SERVICE);
    printJson(status);
    return;
  }

  if (dryRun) {
    const { data: pending, error } = await getPendingEnrichments(userId);
    if (error) cliError(`Pending enrichments failed: ${(error as Error).message ?? error}`, EXIT.SERVICE);
    console.log(JSON.stringify({ pending: (pending ?? []).length, items: (pending ?? []).map((e) => e.id) }, null, 2));
    return;
  }

  const eventId = positionals[0];

  if (eventId) {
    // Enrich a specific event
    const { data: event, error: showErr } = await showEvent(eventId, userId);
    if (showErr) cliError(`Show failed: ${(showErr as Error).message ?? showErr}`, EXIT.SERVICE);
    if (!event) cliError(`Event not found: ${eventId}`);

    const meta = (event.metadata as Record<string, unknown>) ?? {};
    const remotePath = event.remote_path as string | null;
    const s3Key = (meta.s3_key as string) ?? null;

    if (!remotePath && !s3Key) cliError("Event has no S3 path to download from");

    const bucket = process.env.SMGR_S3_BUCKET;
    if (!bucket) cliError("Set SMGR_S3_BUCKET to download images for enrichment");

    const key = s3Key ?? remotePath!.replace(`s3://${bucket}/`, "");
    const s3 = createS3Client();

    try {
      const imageBytes = await downloadS3Object(s3, bucket, key);
      const mime = (meta.mime_type as string) ?? getMimeType(key);

      console.error(`Enriching event ${eventId}...`);
      const result = await enrichImage(imageBytes, mime, modelConfig);
      const { error: enrichErr } = await insertEnrichment(eventId, result, userId);
      if (enrichErr) cliError(`Failed to save enrichment: ${(enrichErr as Error).message ?? enrichErr}`, EXIT.SERVICE);
      console.error("Done.");
    } catch (err) {
      cliError(`Failed to download ${key}: ${err}`, exitCodeForS3Error(err), String(err));
    }
    return;
  }

  if (values.pending) {
    const { data: pending, error: pendErr } = await getPendingEnrichments(userId);
    if (pendErr) cliError(`Pending enrichments failed: ${(pendErr as Error).message ?? pendErr}`, EXIT.SERVICE);
    if (!pending || pending.length === 0) {
      console.log(JSON.stringify({ enriched: 0, failed: 0, skipped: 0, total: 0 }, null, 2));
      return;
    }

    const bucket = process.env.SMGR_S3_BUCKET;
    if (!bucket) cliError("Set SMGR_S3_BUCKET to download images for enrichment");

    const s3 = createS3Client();
    const limit = pLimit(concurrency);
    let done = 0;
    let failed = 0;
    let skipped = 0;
    const total = pending.length;

    console.error(`Found ${total} items pending enrichment (concurrency: ${concurrency}).`);

    const tasks = pending.map((event, i) =>
      limit(async () => {
        const meta = (event.metadata as Record<string, unknown>) ?? {};
        const s3Key =
          (meta.s3_key as string) ??
          (event.remote_path
            ? String(event.remote_path).replace(`s3://${bucket}/`, "")
            : null);

        if (!s3Key) {
          skipped++;
          console.error(`[${i + 1}/${total}] ${event.id} — no S3 key, skipping`);
          return;
        }

        console.error(`[${i + 1}/${total}] Enriching ${event.id}...`);
        try {
          const imageBytes = await downloadS3Object(s3, bucket, s3Key);
          const mime = (meta.mime_type as string) ?? getMimeType(s3Key);
          const result = await enrichImage(imageBytes, mime, modelConfig);
          const { error: eErr } = await insertEnrichment(event.id, result, userId);
          if (eErr) throw eErr;
          done++;
        } catch (err) {
          failed++;
          logger.error("enrich item failed", { event_id: event.id, error: String(err) });
          console.error(`  Failed: ${err}`);
        }
      }),
    );

    await Promise.all(tasks);

    const summary = { enriched: done, failed, skipped, total };
    console.log(JSON.stringify(summary, null, 2));
    logger.info("enrich batch complete", summary);
    return;
  }

  cliError("Specify --pending, --status, --dry-run, or an event ID.");
}

async function cmdWatch(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      once: { type: "boolean", default: false },
      interval: { type: "string" },
      "max-errors": { type: "string" },
      verbose: { type: "boolean", default: false },
    },
  });

  if (values.verbose) verboseMode = true;

  const bucket = process.env.SMGR_S3_BUCKET;
  if (!bucket) cliError("Set SMGR_S3_BUCKET environment variable");

  const userId = requireUserId();
  const prefix = process.env.SMGR_S3_PREFIX ?? "";
  const intervalSecs = parseInt(
    values.interval ?? process.env.SMGR_WATCH_INTERVAL ?? "60",
    10,
  );
  const maxErrors = parseInt(values["max-errors"] ?? "5", 10);
  const autoEnrich = (process.env.SMGR_AUTO_ENRICH ?? "true").toLowerCase() !== "false";
  const deviceId = process.env.SMGR_DEVICE_ID ?? "default";

  const s3 = createS3Client();

  console.error(`Watching s3://${bucket}/${prefix}`);
  console.error(`Poll interval: ${intervalSecs}s | Auto-enrich: ${autoEnrich} | Max errors: ${maxErrors}`);

  let running = true;
  const shutdown = () => {
    running = false;
    console.error("\nShutting down...");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let consecutiveErrors = 0;

  while (running) {
    try {
      const objects = await listS3Objects(s3, bucket, prefix);
      const mediaObjects = objects.filter((o) => isMediaKey(o.key));
      const { data: watchedData, error: watchedErr } = await getWatchedKeys(userId);
      if (watchedErr) throw watchedErr;
      const seenKeys = new Set((watchedData ?? []).map((r) => r.s3_key));
      const newObjects = mediaObjects.filter((o) => !seenKeys.has(o.key));

      if (newObjects.length > 0) {
        const now = new Date().toLocaleTimeString();
        console.error(`[${now}] Found ${newObjects.length} new objects`);

        for (const obj of newObjects) {
          console.error(`  Processing: ${obj.key}`);
          try {
            const imageBytes = await downloadS3Object(s3, bucket, obj.key);
            const contentHash = sha256Bytes(imageBytes);

            const { data: existingEvent, error: hashErr } = await findEventByHash(contentHash, userId);
            if (hashErr) logger.warn("findEventByHash failed", { error: String(hashErr) });
            if (existingEvent?.id) {
              const { error: upErr } = await upsertWatchedKey(obj.key, existingEvent.id, obj.etag, obj.size, userId);
              if (upErr) logger.warn("upsertWatchedKey failed", { key: obj.key, error: String(upErr) });
              console.error(`    Already indexed (hash match)`);
              continue;
            }

            const eventId = newEventId();
            const contentType = detectContentType(obj.key);
            const meta = s3Metadata(obj.key, obj.size, obj.etag);
            const remotePath = `s3://${bucket}/${obj.key}`;

            const { error: insErr } = await insertEvent({
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
            if (insErr) throw insErr;
            const { error: upErr2 } = await upsertWatchedKey(obj.key, eventId, obj.etag, obj.size, userId);
            if (upErr2) logger.warn("upsertWatchedKey failed", { key: obj.key, error: String(upErr2) });
            console.error(`    Created event ${eventId}`);

            if (autoEnrich && contentType === "photo") {
              const mime = getMimeType(obj.key);
              if (mime.startsWith("image/")) {
                console.error("    Enriching...");
                try {
                  const result = await enrichImage(imageBytes, mime, modelConfig);
                  const { error: eErr } = await insertEnrichment(eventId, result, userId);
                  if (eErr) throw eErr;
                  console.error("    Enriched.");
                } catch (err) {
                  console.error(`    Enrichment failed: ${err}`);
                }
              }
            }
          } catch (err) {
            console.error(`    Error: ${err}`);
            const { error: upErr3 } = await upsertWatchedKey(obj.key, null, obj.etag, obj.size, userId);
            if (upErr3) logger.warn("upsertWatchedKey failed", { key: obj.key, error: String(upErr3) });
          }
        }
      }

      consecutiveErrors = 0;

      logger.info("watch scan complete", {
        bucket,
        total_objects: objects.length,
        new_objects: newObjects.length,
      });

      const ts = new Date().toLocaleTimeString();
      console.error(`[${ts}] Scanned: ${objects.length} objects, ${newObjects.length} new`);
    } catch (err) {
      consecutiveErrors++;
      logger.error("watch scan failed", {
        error: String(err),
        consecutive_errors: consecutiveErrors,
        max_errors: maxErrors,
      });
      console.error(`Poll error (${consecutiveErrors}/${maxErrors}): ${err}`);

      if (consecutiveErrors >= maxErrors) {
        cliError(
          `Stopping: ${maxErrors} consecutive scan failures`,
          EXIT.SERVICE,
          String(err),
        );
      }
    }

    if (values.once) break;

    // Sleep in 1s increments for graceful shutdown
    for (let i = 0; i < intervalSecs && running; i++) {
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
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.verbose) verboseMode = true;
  const filePath = positionals[0];
  if (!filePath) cliError("Usage: smgr add <file> [--prefix path/] [--no-enrich]");

  const bucket = process.env.SMGR_S3_BUCKET;
  if (!bucket) cliError("Set SMGR_S3_BUCKET environment variable");

  const userId = requireUserId();
  const deviceId = process.env.SMGR_DEVICE_ID ?? "default";

  const absPath = resolve(filePath);
  const stat = statSync(absPath);
  if (!stat.isFile()) cliError(`Not a file: ${absPath}`);

  const fileBytes = readFileSync(absPath);
  const contentHash = sha256Bytes(Buffer.from(fileBytes));
  const fileName = basename(absPath);
  const contentType = detectContentType(fileName);
  const mimeType = getMimeType(fileName);

  // Check for duplicates
  const { data: existingEvent, error: hashErr } = await findEventByHash(contentHash, userId);
  if (hashErr) logger.warn("findEventByHash failed", { error: String(hashErr) });
  if (existingEvent?.id) {
    console.log(`File already indexed (event ${existingEvent.id}), skipping.`);
    return;
  }

  // Upload to S3
  const s3Key = values.prefix ? `${values.prefix}${fileName}` : fileName;
  const s3 = createS3Client();

  console.error(`Uploading ${fileName} to s3://${bucket}/${s3Key}...`);
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

  const { error: insErr } = await insertEvent({
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
  if (insErr) cliError(`Failed to insert event: ${(insErr as Error).message ?? insErr}`, EXIT.SERVICE);

  // Track as watched key
  const { error: upErr } = await upsertWatchedKey(s3Key, eventId, "", stat.size, userId);
  if (upErr) logger.warn("upsertWatchedKey failed", { key: s3Key, error: String(upErr) });

  console.error(`Created event ${eventId}`);

  // Optionally enrich
  if (values.enrich && contentType === "photo" && mimeType.startsWith("image/")) {
    console.error("Enriching...");
    try {
      const result = await enrichImage(Buffer.from(fileBytes), mimeType, modelConfig);
      const { error: eErr } = await insertEnrichment(eventId, result, userId);
      if (eErr) throw eErr;
      console.error("Enriched.");
    } catch (err) {
      console.error(`Enrichment failed: ${err}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────

if (process.argv.includes("--verbose")) verboseMode = true;

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
  smgr enrich [--pending] [--status] [--concurrency N] [--dry-run] [<event_id>]
  smgr watch [--once] [--interval N] [--max-errors N]
  smgr add <file> [--prefix path/] [--no-enrich]

Flags (all commands):
  --verbose         Show technical error details on failure

Enrich flags:
  --concurrency N   Max parallel enrichment calls (default: 3)
  --dry-run         List pending events without calling the Claude API

Watch flags:
  --interval N      Poll interval in seconds (default: 60)
  --max-errors N    Stop after N consecutive scan failures (default: 5)

Exit codes:
  0  Success
  1  User error (bad arguments, missing env var, resource not found)
  2  Service error (S3 unreachable, DB timeout, API failure)
  3  Internal error (unexpected exception)

Environment:
  NEXT_PUBLIC_SUPABASE_URL     Supabase project URL
  SUPABASE_SECRET_KEY    Supabase service role key
  SMGR_S3_BUCKET               S3 bucket name
  SMGR_S3_ENDPOINT             Custom S3 endpoint (for Supabase Storage)
  SMGR_S3_REGION               AWS region (default: us-east-1)
  ANTHROPIC_API_KEY            For enrichment
  SMGR_USER_ID                 User UUID for tenant-scoped operations
  SMGR_DEVICE_ID               Device identifier (default: default)
  SMGR_WATCH_INTERVAL          Poll interval in seconds (default: 60)
  SMGR_AUTO_ENRICH             Auto-enrich on watch (default: true)`);
  process.exit(command ? 1 : 0);
}

const requestId = crypto.randomUUID();
runWithRequestId(requestId, async () => {
  // Load model config once at startup if a user ID is available
  const userId = process.env.SMGR_USER_ID;
  if (userId) {
    const { data: configRow, error: configErr } = await getModelConfig(userId);
    if (configErr) {
      logger.warn("failed to load model config", { error: String(configErr) });
    } else if (configRow) {
      modelConfig = {
        provider: configRow.provider,
        baseUrl: configRow.base_url,
        model: configRow.model,
        apiKey: configRow.api_key_encrypted,
      };
      logger.info("loaded model config", { provider: configRow.provider, model: configRow.model });
    }
  }

  commands[command](rest).catch((err) => {
    logger.error("unhandled command error", { error: String(err), stack: err?.stack });
    cliError(err.message ?? String(err), EXIT.INTERNAL);
  });
});
