#!/usr/bin/env npx tsx
/**
 * smgr CLI — TypeScript port of the Python prototype.
 * Talks to the web API (Next.js routes), not Supabase directly.
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
import { createLogger, LogComponent } from "../lib/logger";

import { runWithRequestId } from "../lib/request-context";
import { S3ErrorType } from "../lib/media/s3-errors";
import { login, clearCredentials, loadCredentials, refreshSession, resolveApiConfig } from "../lib/auth/cli-auth";

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

// ── API fetch helper ────────────────────────────────────────────

/**
 * Make an authenticated request to the web API.
 * Automatically refreshes the session and attaches the Bearer token.
 */
async function apiFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const creds = await refreshSession();
  if (!creds) {
    cliError("Not logged in. Run 'smgr login' first.", EXIT.USER);
  }

  const { webUrl } = resolveApiConfig();
  const url = `${webUrl}${path}`;
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${creds.access_token}`);
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url, { ...options, headers });
}

/** Convenience: GET + parse JSON, throw on error */
async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `API error ${res.status}`);
  }
  return res.json();
}

/** Convenience: POST + parse JSON, throw on error */
async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error ?? `API error ${res.status}`);
  }
  return res.json();
}

// ── Shared S3 CLI options ───────────────────────────────────────
const s3Options = {
  bucket: { type: "string" as const },
  endpoint: { type: "string" as const },
  region: { type: "string" as const },
  "access-key-id": { type: "string" as const },
  "secret-access-key": { type: "string" as const },
  "device-id": { type: "string" as const },
};

function resolveS3Args(values: Record<string, string | boolean | undefined>) {
  const bucket = (values.bucket as string) ?? process.env.SMGR_S3_BUCKET;
  if (!bucket) cliError("Provide --bucket or set SMGR_S3_BUCKET");
  const deviceId = (values["device-id"] as string) ?? process.env.SMGR_DEVICE_ID ?? "default";
  const s3 = createS3Client({
    endpoint: values.endpoint as string | undefined,
    region: values.region as string | undefined,
    accessKeyId: values["access-key-id"] as string | undefined,
    secretAccessKey: values["secret-access-key"] as string | undefined,
  });
  return { bucket, deviceId, s3 };
}

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
  const creds = loadCredentials();
  if (creds?.user_id) return creds.user_id;

  cliError(
    "Not logged in. Run 'smgr login' to authenticate.",
    EXIT.USER,
  );
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
  requireUserId();

  const params = new URLSearchParams();
  if (values.search) params.set("search", values.search);
  if (values.type) params.set("type", values.type);
  if (values.since) params.set("since", values.since);
  if (values.until) params.set("until", values.until);
  if (values.device) params.set("device", values.device);
  params.set("limit", values.limit!);
  params.set("offset", values.offset!);

  try {
    const result = await apiGet<{ data: Record<string, unknown>[]; count: number }>(
      `/api/events?${params}`,
    );
    const { data, count } = result;

    if (values.format === "json") {
      printJson({ data, count });
    } else {
      const events = data ?? [];
      console.log();
      console.log(
        "ID".padEnd(28) +
          "Date".padEnd(22) +
          "Type".padEnd(8) +
          "Path/Key"
      );
      console.log("\u2500".repeat(100));

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
  } catch (err) {
    cliError(`Query failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
  }
}

async function cmdShow(args: string[]) {
  const eventId = args[0];
  if (!eventId) cliError("Usage: smgr show <event_id>");

  requireUserId();

  try {
    const { data: event } = await apiGet<{ data: unknown }>(`/api/events/${eventId}`);
    if (!event) cliError(`Event not found: ${eventId}`);
    printJson(event);
  } catch (err) {
    cliError(`Show failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
  }
}

async function cmdStats() {
  requireUserId();

  try {
    const { data: stats } = await apiGet<{ data: unknown }>("/api/stats");
    printJson(stats);
  } catch (err) {
    cliError(`Stats failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
  }
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

  requireUserId();

  if (values.status) {
    try {
      const { data: status } = await apiGet<{ data: unknown }>("/api/enrichments/status");
      printJson(status);
    } catch (err) {
      cliError(`Enrich status failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
    }
    return;
  }

  if (dryRun) {
    try {
      const { data: pending } = await apiGet<{ data: Array<{ id: string }> }>("/api/enrichments/pending");
      console.log(JSON.stringify({ pending: (pending ?? []).length, items: (pending ?? []).map((e) => e.id) }, null, 2));
    } catch (err) {
      cliError(`Pending enrichments failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
    }
    return;
  }

  const eventId = positionals[0];

  if (eventId) {
    // Enrich a specific event
    try {
      const { data: event } = await apiGet<{ data: Record<string, unknown> }>(`/api/events/${eventId}`);
      if (!event) cliError(`Event not found: ${eventId}`);

      const meta = (event.metadata as Record<string, unknown>) ?? {};
      const remotePath = event.remote_path as string | null;
      const s3Key = (meta.s3_key as string) ?? null;

      if (!remotePath && !s3Key) cliError("Event has no S3 path to download from");

      const bucket = process.env.SMGR_S3_BUCKET;
      if (!bucket) cliError("Set SMGR_S3_BUCKET to download images for enrichment");

      const key = s3Key ?? remotePath!.replace(`s3://${bucket}/`, "");
      const s3 = createS3Client();

      const imageBytes = await downloadS3Object(s3, bucket, key);
      const mime = (meta.mime_type as string) ?? getMimeType(key);

      console.error(`Enriching event ${eventId}...`);
      const result = await enrichImage(imageBytes, mime, modelConfig);
      await apiPost("/api/enrichments", { event_id: eventId, result });
      console.error("Done.");
    } catch (err) {
      cliError(`Failed to enrich event ${eventId}: ${(err as Error).message ?? err}`, exitCodeForS3Error(err), String(err));
    }
    return;
  }

  if (values.pending) {
    try {
      const { data: pending } = await apiGet<{ data: Array<Record<string, unknown>> }>("/api/enrichments/pending");
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
            console.error(`[${i + 1}/${total}] ${event.id} \u2014 no S3 key, skipping`);
            return;
          }

          console.error(`[${i + 1}/${total}] Enriching ${event.id}...`);
          try {
            const imageBytes = await downloadS3Object(s3, bucket, s3Key);
            const mime = (meta.mime_type as string) ?? getMimeType(s3Key);
            const result = await enrichImage(imageBytes, mime, modelConfig);
            await apiPost("/api/enrichments", { event_id: event.id, result });
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
    } catch (err) {
      cliError(`Pending enrichments failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
    }
    return;
  }

  cliError("Specify --pending, --status, --dry-run, or an event ID.");
}

async function cmdWatch(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      ...s3Options,
      once: { type: "boolean", default: false },
      interval: { type: "string" },
      "max-errors": { type: "string" },
      verbose: { type: "boolean", default: false },
      prefix: { type: "string" },
      "auto-enrich": { type: "boolean" },
      "no-auto-enrich": { type: "boolean" },
    },
  });

  if (values.verbose) verboseMode = true;

  const { bucket, deviceId, s3 } = resolveS3Args(values);

  requireUserId();
  const prefix = (values.prefix as string) ?? process.env.SMGR_S3_PREFIX ?? "";
  const intervalSecs = parseInt(
    (values.interval as string) ?? process.env.SMGR_WATCH_INTERVAL ?? "60",
    10,
  );
  const maxErrors = parseInt((values["max-errors"] as string) ?? "5", 10);
  const autoEnrich = values["no-auto-enrich"]
    ? false
    : values["auto-enrich"] ?? (process.env.SMGR_AUTO_ENRICH ?? "true").toLowerCase() !== "false";

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

      const { data: watchedData } = await apiGet<{ data: Array<{ s3_key: string }> }>("/api/watched-keys");
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

            const { data: existingEvent } = await apiGet<{ data: { id: string } | null }>(
              `/api/events/by-hash/${encodeURIComponent(contentHash)}`,
            );
            if (existingEvent?.id) {
              await apiPost("/api/watched-keys", {
                s3_key: obj.key,
                event_id: existingEvent.id,
                etag: obj.etag,
                size_bytes: obj.size,
              });
              console.error(`    Already indexed (hash match)`);
              continue;
            }

            const eventId = newEventId();
            const contentType = detectContentType(obj.key);
            const meta = s3Metadata(obj.key, obj.size, obj.etag);
            const remotePath = `s3://${bucket}/${obj.key}`;

            await apiPost("/api/events", {
              id: eventId,
              device_id: deviceId,
              type: "create",
              content_type: contentType,
              content_hash: contentHash,
              local_path: null,
              remote_path: remotePath,
              metadata: meta,
              parent_id: null,
            });

            await apiPost("/api/watched-keys", {
              s3_key: obj.key,
              event_id: eventId,
              etag: obj.etag,
              size_bytes: obj.size,
            });
            console.error(`    Created event ${eventId}`);

            if (autoEnrich && contentType === "photo") {
              const mime = getMimeType(obj.key);
              if (mime.startsWith("image/")) {
                console.error("    Enriching...");
                try {
                  const result = await enrichImage(imageBytes, mime, modelConfig);
                  await apiPost("/api/enrichments", { event_id: eventId, result });
                  console.error("    Enriched.");
                } catch (err) {
                  console.error(`    Enrichment failed: ${err}`);
                }
              }
            }
          } catch (err) {
            console.error(`    Error: ${err}`);
            try {
              await apiPost("/api/watched-keys", {
                s3_key: obj.key,
                event_id: null,
                etag: obj.etag,
                size_bytes: obj.size,
              });
            } catch (upErr) {
              logger.warn("upsertWatchedKey failed", { key: obj.key, error: String(upErr) });
            }
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
      ...s3Options,
      prefix: { type: "string", default: "" },
      enrich: { type: "boolean", default: true },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.verbose) verboseMode = true;
  const filePath = positionals[0];
  if (!filePath) cliError("Usage: smgr add <file> [--prefix path/] [--no-enrich]");

  const { bucket, deviceId, s3 } = resolveS3Args(values);

  requireUserId();

  const absPath = resolve(filePath);
  const stat = statSync(absPath);
  if (!stat.isFile()) cliError(`Not a file: ${absPath}`);

  const fileBytes = readFileSync(absPath);
  const contentHash = sha256Bytes(Buffer.from(fileBytes));
  const fileName = basename(absPath);
  const contentType = detectContentType(fileName);
  const mimeType = getMimeType(fileName);

  // Check for duplicates
  try {
    const { data: existingEvent } = await apiGet<{ data: { id: string } | null }>(
      `/api/events/by-hash/${encodeURIComponent(contentHash)}`,
    );
    if (existingEvent?.id) {
      console.log(`File already indexed (event ${existingEvent.id}), skipping.`);
      return;
    }
  } catch (err) {
    logger.warn("findEventByHash failed", { error: String(err) });
  }

  // Upload to S3
  const s3Key = values.prefix ? `${values.prefix}${fileName}` : fileName;

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

  try {
    await apiPost("/api/events", {
      id: eventId,
      device_id: deviceId,
      type: "create",
      content_type: contentType,
      content_hash: contentHash,
      local_path: absPath,
      remote_path: remotePath,
      metadata: meta,
      parent_id: null,
    });
  } catch (err) {
    cliError(`Failed to insert event: ${(err as Error).message ?? err}`, EXIT.SERVICE);
  }

  // Track as watched key
  try {
    await apiPost("/api/watched-keys", {
      s3_key: s3Key,
      event_id: eventId,
      etag: "",
      size_bytes: stat.size,
    });
  } catch (err) {
    logger.warn("upsertWatchedKey failed", { key: s3Key, error: String(err) });
  }

  console.error(`Created event ${eventId}`);

  // Optionally enrich
  if (values.enrich && contentType === "photo" && mimeType.startsWith("image/")) {
    console.error("Enriching...");
    try {
      const result = await enrichImage(Buffer.from(fileBytes), mimeType, modelConfig);
      await apiPost("/api/enrichments", { event_id: eventId, result });
      console.error("Enriched.");
    } catch (err) {
      console.error(`Enrichment failed: ${err}`);
    }
  }
}

// ── Auth Commands ────────────────────────────────────────────

async function cmdLogin() {
  try {
    const creds = await login();
    console.log(`Logged in as ${creds.email} (${creds.user_id})`);
  } catch (err) {
    cliError(`Login failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
  }
}

async function cmdLogout() {
  clearCredentials();
  console.log("Logged out. Credentials removed.");
}

async function cmdWhoami() {
  const creds = loadCredentials();
  if (!creds) {
    console.log("Not logged in. Run 'smgr login' to authenticate.");
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const expired = creds.expires_at <= now;

  console.log(`Email:   ${creds.email}`);
  console.log(`User ID: ${creds.user_id}`);
  console.log(`Token:   ${expired ? "expired (run 'smgr login' to re-authenticate)" : "valid"}`);
}

// ── Main ─────────────────────────────────────────────────────

if (process.argv.includes("--verbose")) verboseMode = true;

const [command, ...rest] = process.argv.slice(2);

const commands: Record<string, (args: string[]) => Promise<void>> = {
  login: () => cmdLogin(),
  logout: () => cmdLogout(),
  whoami: () => cmdWhoami(),
  query: cmdQuery,
  show: cmdShow,
  stats: () => cmdStats(),
  enrich: cmdEnrich,
  watch: cmdWatch,
  add: cmdAdd,
};

if (!command || !(command in commands)) {
  console.log(`smgr \u2014 S3-event-driven media indexer

Usage:
  smgr login                    Authenticate via browser (device code flow)
  smgr logout                   Clear stored credentials
  smgr whoami                   Show current session info

  smgr query [--search Q] [--type TYPE] [--format json] [--limit N]
  smgr show <event_id>
  smgr stats
  smgr enrich [--pending] [--status] [--concurrency N] [--dry-run] [<event_id>]
  smgr watch [S3 flags] [--prefix P] [--once] [--interval N] [--max-errors N]
             [--auto-enrich | --no-auto-enrich]
  smgr add <file> [S3 flags] [--prefix path/] [--no-enrich]

Authentication:
  Run 'smgr login' to authenticate. A browser window will open for you to approve
  the device. Credentials are stored in ~/.sitemgr/credentials.json.

Flags (all commands):
  --verbose         Show technical error details on failure

Enrich flags:
  --concurrency N   Max parallel enrichment calls (default: 3)
  --dry-run         List pending events without calling the Claude API

S3 flags (watch, add):
  --bucket B             S3 bucket name (or SMGR_S3_BUCKET)
  --endpoint URL         Custom S3 endpoint (or SMGR_S3_ENDPOINT)
  --region R             S3 region (or SMGR_S3_REGION, default: us-east-1)
  --access-key-id K      S3 access key (or S3_ACCESS_KEY_ID)
  --secret-access-key S  S3 secret key (or S3_SECRET_ACCESS_KEY)
  --device-id D          Device identifier (or SMGR_DEVICE_ID, default: default)

Watch flags:
  --prefix P             Key prefix filter (or SMGR_S3_PREFIX)
  --auto-enrich          Enable auto-enrichment (default: true)
  --no-auto-enrich       Disable auto-enrichment
  --interval N           Poll interval in seconds (default: 60)
  --max-errors N         Stop after N consecutive scan failures (default: 5)

Exit codes:
  0  Success
  1  User error (bad arguments, missing env var, resource not found)
  2  Service error (S3 unreachable, DB timeout, API failure)
  3  Internal error (unexpected exception)

Environment:
  SMGR_WEB_URL           Web API URL (required, e.g. http://localhost:3000)
  SMGR_S3_BUCKET         S3 bucket name
  SMGR_S3_ENDPOINT       Custom S3 endpoint (for Supabase Storage)
  SMGR_S3_REGION         S3 region (default: us-east-1)
  ANTHROPIC_API_KEY      For enrichment
  SMGR_DEVICE_ID         Device identifier (default: default)
  SMGR_WATCH_INTERVAL    Poll interval in seconds (default: 60)
  SMGR_AUTO_ENRICH       Auto-enrich on watch (default: true)`);
  process.exit(command ? 1 : 0);
}

// Load model config once at startup if a user ID is available
const requestId = crypto.randomUUID();
runWithRequestId(requestId, async () => {
  const creds = loadCredentials();
  if (creds?.user_id) {
    try {
      const { data: configRow } = await apiGet<{ data: { provider: string; base_url: string | null; model: string; api_key_encrypted: string | null } | null }>("/api/model-config");
      if (configRow) {
        modelConfig = {
          provider: configRow.provider,
          baseUrl: configRow.base_url,
          model: configRow.model,
          apiKey: configRow.api_key_encrypted,
        };
        logger.info("loaded model config", { provider: configRow.provider, model: configRow.model });
      }
    } catch (err) {
      logger.warn("failed to load model config", { error: String(err) });
    }
  }

  commands[command](rest).catch((err) => {
    logger.error("unhandled command error", { error: String(err), stack: err?.stack });
    cliError(err.message ?? String(err), EXIT.INTERNAL);
  });
});
