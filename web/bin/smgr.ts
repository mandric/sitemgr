#!/usr/bin/env npx tsx
/**
 * smgr CLI — talks to the web API (Next.js routes), not S3 directly.
 *
 * Usage:
 *   npx tsx bin/smgr.ts login
 *   npx tsx bin/smgr.ts bucket list
 *   npx tsx bin/smgr.ts bucket add --bucket-name B --endpoint-url URL --access-key-id K --secret-access-key S
 *   npx tsx bin/smgr.ts query --search "beach" --format json
 *   npx tsx bin/smgr.ts watch <bucket> --once
 *   npx tsx bin/smgr.ts add <bucket> <file>
 *   npx tsx bin/smgr.ts enrich <bucket> --pending
 */

import { parseArgs } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { createLogger, LogComponent } from "../lib/logger";

import { runWithRequestId } from "../lib/request-context";
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

// ── API fetch helper ────────────────────────────────────────────

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
  // Don't set Content-Type for FormData — browser/node sets multipart boundary automatically
  if (!headers.has("Content-Type") && options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url, { ...options, headers });
}

async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `API error ${res.status}`);
  }
  return res.json();
}

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

function cliError(message: string, code: ExitCode = EXIT.USER, detail?: string): never {
  console.error(`Error: ${message}`);
  if (verboseMode && detail) {
    console.error(`Detail: ${detail}`);
  }
  process.exit(code);
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

async function resolveBucketId(name: string): Promise<string> {
  const { data } = await apiGet<{ data: Array<{ id: string; bucket_name: string }> }>("/api/buckets");
  const bucket = (data ?? []).find((b) => b.bucket_name === name);
  if (!bucket) {
    cliError(`Bucket not found: ${name}`);
  }
  return bucket.id;
}

// ── Bucket Commands ─────────────────────────────────────────

async function cmdBucket(args: string[]) {
  const sub = args[0];
  const subArgs = args.slice(1);

  switch (sub) {
    case "list":
      return cmdBucketList();
    case "add":
      return cmdBucketAdd(subArgs);
    case "remove":
      return cmdBucketRemove(subArgs);
    case "test":
      return cmdBucketTest(subArgs);
    default:
      console.log(`Usage:
  smgr bucket list                     List configured buckets
  smgr bucket add [flags]              Add a bucket config
  smgr bucket remove <name>            Remove a bucket config
  smgr bucket test <name>              Test S3 connectivity`);
      process.exit(sub ? 1 : 0);
  }
}

async function cmdBucketList() {
  requireUserId();

  try {
    const { data } = await apiGet<{ data: Array<Record<string, unknown>> }>("/api/buckets");
    const buckets = data ?? [];

    if (buckets.length === 0) {
      console.log("No buckets configured. Use 'smgr bucket add' to add one.");
      return;
    }

    console.log();
    console.log(
      "Name".padEnd(30) +
      "Region".padEnd(15) +
      "Endpoint".padEnd(40) +
      "Created"
    );
    console.log("\u2500".repeat(95));

    for (const b of buckets) {
      const created = String(b.created_at ?? "").slice(0, 10);
      console.log(
        String(b.bucket_name ?? "").padEnd(30) +
        String(b.region ?? "-").padEnd(15) +
        String(b.endpoint_url ?? "").slice(0, 38).padEnd(40) +
        created
      );
    }
    console.log(`\n${buckets.length} bucket(s) configured`);
  } catch (err) {
    cliError(`Failed to list buckets: ${(err as Error).message ?? err}`, EXIT.SERVICE);
  }
}

async function cmdBucketAdd(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      "bucket-name": { type: "string" },
      "endpoint-url": { type: "string" },
      region: { type: "string" },
      "access-key-id": { type: "string" },
      "secret-access-key": { type: "string" },
    },
  });

  requireUserId();

  const bucketName = values["bucket-name"];
  const endpointUrl = values["endpoint-url"];
  const accessKeyId = values["access-key-id"];
  const secretAccessKey = values["secret-access-key"];

  if (!bucketName || !endpointUrl || !accessKeyId || !secretAccessKey) {
    cliError(
      "Required flags: --bucket-name, --endpoint-url, --access-key-id, --secret-access-key",
    );
  }

  try {
    const { data } = await apiPost<{ data: Record<string, unknown> }>("/api/buckets", {
      bucket_name: bucketName,
      endpoint_url: endpointUrl,
      region: values.region ?? null,
      access_key_id: accessKeyId,
      secret_access_key: secretAccessKey,
    });
    console.log(`Bucket "${bucketName}" added (id: ${data.id})`);
  } catch (err) {
    cliError(`Failed to add bucket: ${(err as Error).message ?? err}`, EXIT.SERVICE);
  }
}

async function cmdBucketRemove(args: string[]) {
  const name = args[0];
  if (!name) cliError("Usage: smgr bucket remove <bucket-name>");

  requireUserId();

  try {
    const id = await resolveBucketId(name);
    const res = await apiFetch(`/api/buckets/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      cliError(`Delete failed: ${body.error ?? res.statusText}`, EXIT.SERVICE);
    }
    console.log(`Bucket "${name}" removed.`);
  } catch (err) {
    cliError(`Failed to remove bucket: ${(err as Error).message ?? err}`, EXIT.SERVICE);
  }
}

async function cmdBucketTest(args: string[]) {
  const name = args[0];
  if (!name) cliError("Usage: smgr bucket test <bucket-name>");

  requireUserId();

  try {
    const id = await resolveBucketId(name);
    const { data } = await apiPost<{ data: { success: boolean; has_objects: boolean; message: string } }>(
      `/api/buckets/${id}/test`,
      {},
    );
    if (data.success) {
      console.log(`\u2713 ${data.message}`);
      if (data.has_objects) {
        console.log("  Bucket contains objects.");
      }
    } else {
      console.error(`\u2717 ${data.message}`);
      process.exit(EXIT.SERVICE);
    }
  } catch (err) {
    cliError(`Connectivity test failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
  }
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
      bucket: { type: "string" },
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

  if (values.bucket) {
    const bucketId = await resolveBucketId(values.bucket);
    params.set("bucket_config_id", bucketId);
  }

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

  const res = await apiFetch(`/api/events/${eventId}`);
  if (res.status === 404) {
    printJson({ data: null });
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    cliError(`Show failed: ${body.error ?? res.statusText}`, EXIT.SERVICE);
  }
  const { data: event } = await res.json();
  printJson(event);
}

interface DedupGroup {
  content_hash: string;
  copies: number;
  event_ids: string[];
  paths: string[];
}

async function cmdDedup(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const bucketName = positionals[0];
  if (!bucketName) {
    cliError("Usage: smgr dedup <bucket>", EXIT.USER);
  }

  requireUserId();

  try {
    const bucketId = await resolveBucketId(bucketName);
    const { data } = await apiGet<{
      data: { groups: DedupGroup[]; total_duplicate_groups: number };
    }>(`/api/dedup?bucket_config_id=${bucketId}`);

    const groups = data.groups;
    if (!groups || groups.length === 0) {
      console.log("No duplicates found.");
      return;
    }

    // Table output
    const hashW = 34;
    const copiesW = 8;
    console.log(
      `${"Hash".padEnd(hashW)}${"Copies".padEnd(copiesW)}Paths`,
    );
    console.log("─".repeat(60));

    for (const g of groups) {
      const shortPaths = g.paths.map((p) =>
        p.replace(/^s3:\/\/[^/]+\//, ""),
      );
      for (let i = 0; i < shortPaths.length; i++) {
        if (i === 0) {
          console.log(
            `${g.content_hash.padEnd(hashW)}${String(g.copies).padEnd(copiesW)}${shortPaths[i]}`,
          );
        } else {
          console.log(`${"".padEnd(hashW)}${"".padEnd(copiesW)}${shortPaths[i]}`);
        }
      }
    }

    const extraCopies = groups.reduce((sum, g) => sum + (g.copies - 1), 0);
    console.log(
      `\n${groups.length} duplicate group${groups.length === 1 ? "" : "s"}, ${extraCopies} extra cop${extraCopies === 1 ? "y" : "ies"}`,
    );
  } catch (err) {
    cliError(`Dedup failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
  }
}

async function cmdStats(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      bucket: { type: "string" },
    },
  });

  requireUserId();

  try {
    const params = new URLSearchParams();
    if (values.bucket) {
      const bucketId = await resolveBucketId(values.bucket);
      params.set("bucket_config_id", bucketId);
    }
    const qs = params.toString();
    const { data: stats } = await apiGet<{ data: unknown }>(`/api/stats${qs ? `?${qs}` : ""}`);
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

  // Bucket name is the first positional
  const bucketName = positionals[0];
  const eventId = positionals[1]; // optional: specific event ID

  if (!bucketName && !eventId) {
    cliError("Usage: smgr enrich <bucket> [--pending] [--dry-run] [--concurrency N]\n       smgr enrich <bucket> <event_id>\n       smgr enrich --status");
  }

  if (bucketName) {
    const bucketId = await resolveBucketId(bucketName);

    if (eventId) {
      // Enrich a specific event
      try {
        const { data } = await apiPost<{ data: Record<string, unknown> }>(
          `/api/buckets/${bucketId}/enrich`,
          { event_id: eventId },
        );
        printJson(data);
      } catch (err) {
        cliError(`Failed to enrich event: ${(err as Error).message ?? err}`, EXIT.SERVICE);
      }
      return;
    }

    if (values.pending || dryRun) {
      try {
        const { data } = await apiPost<{ data: Record<string, unknown> }>(
          `/api/buckets/${bucketId}/enrich`,
          { concurrency, dry_run: dryRun },
        );
        printJson(data);
      } catch (err) {
        cliError(`Enrichment failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
      }
      return;
    }

    // Default to --pending behavior
    try {
      const { data } = await apiPost<{ data: Record<string, unknown> }>(
        `/api/buckets/${bucketId}/enrich`,
        { concurrency },
      );
      printJson(data);
    } catch (err) {
      cliError(`Enrichment failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
    }
    return;
  }

  cliError("Specify a bucket name, --status, or an event ID.");
}

async function cmdWatch(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      once: { type: "boolean", default: false },
      interval: { type: "string" },
      "max-errors": { type: "string" },
      verbose: { type: "boolean", default: false },
      prefix: { type: "string" },
      "auto-enrich": { type: "boolean" },
      "no-auto-enrich": { type: "boolean" },
      "batch-size": { type: "string" },
      "device-id": { type: "string" },
    },
    allowPositionals: true,
  });

  if (values.verbose) verboseMode = true;

  const bucketName = positionals[0];
  if (!bucketName) cliError("Usage: smgr watch <bucket> [--once] [--prefix P] [--interval N]");

  requireUserId();

  const bucketId = await resolveBucketId(bucketName);
  const prefix = (values.prefix as string) ?? "";
  const intervalSecs = parseInt(
    (values.interval as string) ?? process.env.SMGR_WATCH_INTERVAL ?? "60",
    10,
  );
  const maxErrors = parseInt((values["max-errors"] as string) ?? "5", 10);
  const autoEnrich = values["no-auto-enrich"]
    ? false
    : values["auto-enrich"] ?? true;
  const batchSize = parseInt((values["batch-size"] as string) ?? "100", 10);
  const deviceId = (values["device-id"] as string) ?? process.env.SMGR_DEVICE_ID ?? "default";

  console.error(`Watching bucket "${bucketName}" (prefix: "${prefix}")`);
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
      const { data: scanResult } = await apiPost<{ data: Record<string, unknown> }>(
        `/api/buckets/${bucketId}/scan`,
        {
          prefix,
          batch_size: batchSize,
          auto_enrich: autoEnrich,
          device_id: deviceId,
        },
      );

      consecutiveErrors = 0;

      const ts = new Date().toLocaleTimeString();
      console.error(
        `[${ts}] Scanned: ${scanResult.total_objects} objects, ${scanResult.new_objects} new, ${scanResult.created_events} indexed`,
      );
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
      verbose: { type: "boolean", default: false },
      "device-id": { type: "string" },
    },
    allowPositionals: true,
  });

  if (values.verbose) verboseMode = true;

  const bucketName = positionals[0];
  const filePath = positionals[1];
  if (!bucketName || !filePath) cliError("Usage: smgr add <bucket> <file> [--prefix path/]");

  requireUserId();

  const bucketId = await resolveBucketId(bucketName);
  const absPath = resolve(filePath);
  const stat = statSync(absPath);
  if (!stat.isFile()) cliError(`Not a file: ${absPath}`);

  const fileBytes = readFileSync(absPath);
  const fileName = basename(absPath);

  const formData = new FormData();
  formData.append("file", new Blob([fileBytes]), fileName);
  if (values.prefix) formData.append("prefix", values.prefix);
  if (values["device-id"]) formData.append("device_id", values["device-id"]);

  console.error(`Uploading ${fileName} to bucket "${bucketName}"...`);

  try {
    const res = await apiFetch(`/api/buckets/${bucketId}/upload`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      cliError(`Upload failed: ${data.error ?? res.statusText}`, EXIT.SERVICE);
    }
    const { data } = await res.json();
    console.error(`Created event ${data.event_id}`);
    printJson(data);
  } catch (err) {
    cliError(`Upload failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
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
  bucket: cmdBucket,
  query: cmdQuery,
  show: cmdShow,
  stats: cmdStats,
  dedup: cmdDedup,
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

  smgr bucket list              List configured buckets
  smgr bucket add [flags]       Add a bucket config
  smgr bucket remove <name>     Remove a bucket config
  smgr bucket test <name>       Test S3 connectivity

  smgr query [--search Q] [--type TYPE] [--format json] [--limit N] [--bucket B]
  smgr show <event_id>
  smgr stats [--bucket B]
  smgr dedup <bucket>             Find duplicate files in a bucket
  smgr enrich <bucket> [--pending] [--dry-run] [--concurrency N] [<event_id>]
  smgr enrich --status
  smgr watch <bucket> [--prefix P] [--once] [--interval N] [--max-errors N]
             [--auto-enrich | --no-auto-enrich] [--batch-size N]
  smgr add <bucket> <file> [--prefix path/]

Authentication:
  Run 'smgr login' to authenticate. A browser window will open for you to approve
  the device. Credentials are stored in ~/.sitemgr/credentials.json.

Flags (all commands):
  --verbose         Show technical error details on failure

Bucket add flags:
  --bucket-name B         Bucket name (required)
  --endpoint-url URL      S3 endpoint URL (required)
  --region R              S3 region (optional)
  --access-key-id K       S3 access key (required)
  --secret-access-key S   S3 secret key (required)

Watch flags:
  --prefix P             Key prefix filter
  --auto-enrich          Enable auto-enrichment (default: true)
  --no-auto-enrich       Disable auto-enrichment
  --interval N           Poll interval in seconds (default: 60)
  --max-errors N         Stop after N consecutive scan failures (default: 5)
  --batch-size N         Max objects to process per scan (default: 100)
  --device-id D          Device identifier (default: default)

Exit codes:
  0  Success
  1  User error (bad arguments, missing env var, resource not found)
  2  Service error (S3 unreachable, DB timeout, API failure)
  3  Internal error (unexpected exception)

Environment:
  SMGR_WEB_URL           Web API URL (required, e.g. http://localhost:3000)
  SMGR_DEVICE_ID         Device identifier (default: default)
  SMGR_WATCH_INTERVAL    Poll interval in seconds (default: 60)`);
  process.exit(command ? 1 : 0);
}

const requestId = crypto.randomUUID();
runWithRequestId(requestId, async () => {
  commands[command](rest).catch((err) => {
    logger.error("unhandled command error", { error: String(err), stack: err?.stack });
    cliError(err.message ?? String(err), EXIT.INTERNAL);
  });
});
