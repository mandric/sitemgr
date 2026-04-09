#!/usr/bin/env npx tsx
/**
 * sitemgr CLI — talks to the web API (Next.js routes), not S3 directly.
 *
 * Usage:
 *   npx tsx bin/sitemgr.ts login
 *   npx tsx bin/sitemgr.ts bucket list
 *   npx tsx bin/sitemgr.ts bucket add --bucket-name B --endpoint-url URL --access-key-id K --secret-access-key S
 *   npx tsx bin/sitemgr.ts query --search "beach" --format json
 *   npx tsx bin/sitemgr.ts scan <bucket>
 *   npx tsx bin/sitemgr.ts sync <local-dir> <bucket> [--dry-run]
 *   npx tsx bin/sitemgr.ts import <bucket> [--prefix]
 *   npx tsx bin/sitemgr.ts add <bucket> <file>
 *   npx tsx bin/sitemgr.ts enrich <bucket> --pending
 */

import { parseArgs } from "node:util";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { resolve, basename, relative, join, posix } from "node:path";
import { createHash } from "node:crypto";
import pLimit from "p-limit";
import { createLogger, LogComponent } from "../lib/logger";
import { humanSize } from "../lib/media/utils";
import type { ScanResult, ImportResult } from "../lib/media/bucket-service";
import type { S3Object } from "../lib/media/s3";

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
    cliError("Not logged in. Run 'sitemgr login' first.", EXIT.USER);
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
    "Not logged in. Run 'sitemgr login' to authenticate.",
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
  sitemgr bucket list                     List configured buckets
  sitemgr bucket add [flags]              Add a bucket config
  sitemgr bucket remove <name>            Remove a bucket config
  sitemgr bucket test <name>              Test S3 connectivity`);
      process.exit(sub ? 1 : 0);
  }
}

async function cmdBucketList() {
  requireUserId();

  try {
    const { data } = await apiGet<{ data: Array<Record<string, unknown>> }>("/api/buckets");
    const buckets = data ?? [];

    if (buckets.length === 0) {
      console.log("No buckets configured. Use 'sitemgr bucket add' to add one.");
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
  if (!name) cliError("Usage: sitemgr bucket remove <bucket-name>");

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
  if (!name) cliError("Usage: sitemgr bucket test <bucket-name>");

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
  if (!eventId) cliError("Usage: sitemgr show <event_id>");

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
    cliError("Usage: sitemgr dedup <bucket>", EXIT.USER);
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
    cliError("Usage: sitemgr enrich <bucket> [--pending] [--dry-run] [--concurrency N]\n       sitemgr enrich <bucket> <event_id>\n       sitemgr enrich --status");
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

// ── Scan (read-only diff) ──────────────────────────────────────

async function cmdScan(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      prefix: { type: "string" },
      format: { type: "string", default: "table" },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.verbose) verboseMode = true;

  const bucketName = positionals[0];
  if (!bucketName) {
    cliError("Usage: sitemgr scan <bucket> [--prefix P] [--format json]");
  }

  requireUserId();

  const bucketId = await resolveBucketId(bucketName);
  const prefix = (values.prefix as string) ?? "";

  try {
    const { data: report } = await apiPost<{ data: ScanResult }>(
      `/api/buckets/${bucketId}/scan`,
      { prefix: prefix || undefined },
    );

    if (values.format === "json") {
      printJson(report);
      return;
    }

    console.log();
    console.log(`Bucket: ${report.bucket}`);
    console.log(`  Total S3 objects: ${report.total_objects}`);
    console.log(`  Synced:     ${report.synced_count} files`);
    console.log(`  Untracked:  ${report.untracked_count} files`);
    console.log(`  Modified:   ${report.modified_count} files`);

    if (report.untracked.length > 0) {
      console.log("\nUntracked (in S3 but no event recorded):");
      for (const e of report.untracked) {
        console.log(`  ${e.key}  (${humanSize(e.size)})`);
      }
    }
    if (report.modified.length > 0) {
      console.log("\nModified (S3 content changed since last sync):");
      for (const e of report.modified) {
        console.log(`  ${e.key}  (${humanSize(e.size)})`);
      }
    }
  } catch (err) {
    cliError(`Scan failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
  }
}

// ── Sync (local → S3) ──────────────────────────────────────────

function walkLocalDir(root: string): Array<{ absPath: string; relPath: string; size: number }> {
  const out: Array<{ absPath: string; relPath: string; size: number }> = [];
  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const stat = statSync(full);
        // S3 uses forward slashes regardless of host OS
        const rel = relative(root, full).split(/[\\/]/).join(posix.sep);
        out.push({ absPath: full, relPath: rel, size: stat.size });
      }
    }
  };
  walk(root);
  return out;
}

function md5OfFile(absPath: string): string {
  const hash = createHash("md5");
  hash.update(readFileSync(absPath));
  return hash.digest("hex");
}

async function cmdSync(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      prefix: { type: "string", default: "" },
      "dry-run": { type: "boolean", default: false },
      concurrency: { type: "string", default: "3" },
      "device-id": { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.verbose) verboseMode = true;

  const localDir = positionals[0];
  const bucketName = positionals[1];
  if (!localDir || !bucketName) {
    cliError(
      "Usage: sitemgr sync <local-dir> <bucket> [--prefix path/] [--dry-run] [--concurrency N]",
    );
  }

  requireUserId();

  const absLocal = resolve(localDir);
  const stat = statSync(absLocal);
  if (!stat.isDirectory()) {
    cliError(`Not a directory: ${absLocal}`, EXIT.USER);
  }

  const bucketId = await resolveBucketId(bucketName);
  const prefix = values.prefix ?? "";
  const dryRun = values["dry-run"] ?? false;
  const concurrency = Math.max(1, parseInt(values.concurrency ?? "3", 10));

  // 1. Walk local directory
  console.error(`Scanning local directory ${absLocal}...`);
  const localFiles = walkLocalDir(absLocal);
  console.error(`Found ${localFiles.length} local file(s).`);

  // 2. List S3 objects under the prefix
  console.error(`Listing S3 bucket "${bucketName}"${prefix ? ` (prefix: ${prefix})` : ""}...`);
  const listingParams = new URLSearchParams();
  if (prefix) listingParams.set("prefix", prefix);
  const qs = listingParams.toString();
  const { data: s3Objects } = await apiGet<{ data: S3Object[] }>(
    `/api/buckets/${bucketId}/objects${qs ? `?${qs}` : ""}`,
  );

  // Build a map: s3 key -> etag
  const s3ByKey = new Map<string, S3Object>();
  for (const obj of s3Objects ?? []) {
    s3ByKey.set(obj.key, obj);
  }

  // 3. Diff local vs S3
  type PendingUpload = { absPath: string; relPath: string; s3Key: string; size: number };
  const uploads: PendingUpload[] = [];
  let skipped = 0;

  for (const file of localFiles) {
    const s3Key = prefix ? `${prefix}${file.relPath}` : file.relPath;
    const s3Obj = s3ByKey.get(s3Key);

    if (!s3Obj) {
      uploads.push({ ...file, s3Key });
      continue;
    }

    // Multipart ETags (contain "-") cannot be compared against local MD5.
    // If size matches, assume the file is unchanged; otherwise re-upload.
    const isMultipart = s3Obj.etag.includes("-");
    if (isMultipart) {
      if (s3Obj.size === file.size) {
        skipped++;
      } else {
        uploads.push({ ...file, s3Key });
      }
      continue;
    }

    const localMd5 = md5OfFile(file.absPath);
    if (localMd5 === s3Obj.etag) {
      skipped++;
    } else {
      uploads.push({ ...file, s3Key });
    }
  }

  console.error(
    `Diff: ${uploads.length} to upload, ${skipped} unchanged, ${localFiles.length} local total.`,
  );

  if (dryRun) {
    console.log();
    console.log("Dry run — no uploads performed.");
    if (uploads.length > 0) {
      console.log("\nWould upload:");
      for (const u of uploads) {
        console.log(`  ${u.s3Key}  (${humanSize(u.size)})`);
      }
    }
    return;
  }

  if (uploads.length === 0) {
    console.log("Nothing to upload — bucket is in sync.");
    return;
  }

  // 4. Upload pending files via the upload API
  const limit = pLimit(concurrency);
  let done = 0;
  let failed = 0;
  let completed = 0;

  await Promise.all(
    uploads.map((u) =>
      limit(async () => {
        try {
          const fileBytes = readFileSync(u.absPath);
          const formData = new FormData();
          formData.append("file", new Blob([fileBytes]), basename(u.relPath));
          // Recreate the directory prefix so the upload route concatenates
          // prefix + basename back into the original s3 key.
          const dirPrefix = u.s3Key.slice(0, u.s3Key.length - basename(u.relPath).length);
          if (dirPrefix) formData.append("prefix", dirPrefix);
          if (values["device-id"]) formData.append("device_id", values["device-id"]);

          const res = await apiFetch(`/api/buckets/${bucketId}/upload`, {
            method: "POST",
            body: formData,
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(body.error ?? `upload ${res.status}`);
          }
          done++;
          const idx = ++completed;
          console.error(`[${idx}/${uploads.length}] ${u.s3Key}`);
        } catch (err) {
          failed++;
          const idx = ++completed;
          console.error(
            `[${idx}/${uploads.length}] FAIL ${u.s3Key}: ${(err as Error).message ?? err}`,
          );
        }
      }),
    ),
  );

  console.log();
  console.log(`Uploaded: ${done}  Skipped: ${skipped}  Failed: ${failed}`);
  if (failed > 0) process.exit(EXIT.SERVICE);
}

// ── Import (ingest pre-existing S3 objects) ──────────────────

async function cmdImport(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      prefix: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      concurrency: { type: "string" },
      "batch-size": { type: "string" },
      format: { type: "string", default: "table" },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.verbose) verboseMode = true;

  const bucketName = positionals[0];
  if (!bucketName) {
    cliError(
      "Usage: sitemgr import <bucket> [--prefix P] [--dry-run] [--concurrency N] [--batch-size N]",
    );
  }

  requireUserId();

  const bucketId = await resolveBucketId(bucketName);
  const prefix = values.prefix ?? "";
  const dryRun = values["dry-run"] ?? false;
  const concurrency = values.concurrency ? parseInt(values.concurrency, 10) : undefined;
  const batchSize = values["batch-size"] ? parseInt(values["batch-size"], 10) : undefined;

  if (concurrency !== undefined && (!Number.isFinite(concurrency) || concurrency < 1)) {
    cliError("--concurrency must be a positive integer");
  }
  if (batchSize !== undefined && (!Number.isFinite(batchSize) || batchSize < 1)) {
    cliError("--batch-size must be a positive integer");
  }

  console.error(
    `Importing untracked objects from "${bucketName}"${prefix ? ` (prefix: ${prefix})` : ""}${dryRun ? " [dry run]" : ""}...`,
  );

  try {
    const { data: report } = await apiPost<{ data: ImportResult }>(
      `/api/buckets/${bucketId}/import`,
      {
        prefix: prefix || undefined,
        dry_run: dryRun,
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(batchSize !== undefined ? { batch_size: batchSize } : {}),
      },
    );

    if (values.format === "json") {
      printJson(report);
      return;
    }

    console.log();
    console.log(`Bucket: ${report.bucket}`);
    console.log(`  Untracked: ${report.untracked_count} objects`);
    if (report.dry_run) {
      console.log();
      console.log(`Dry run — would import ${report.untracked_count} events.`);
      return;
    }
    console.log(`  Imported:  ${report.imported}`);
    console.log(`  Errors:    ${report.errors}`);
    if (report.errors > 0) {
      process.exit(EXIT.SERVICE);
    }
  } catch (err) {
    cliError(`Import failed: ${(err as Error).message ?? err}`, EXIT.SERVICE);
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
  if (!bucketName || !filePath) cliError("Usage: sitemgr add <bucket> <file> [--prefix path/]");

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
    console.log("Not logged in. Run 'sitemgr login' to authenticate.");
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const expired = creds.expires_at <= now;

  console.log(`Email:   ${creds.email}`);
  console.log(`User ID: ${creds.user_id}`);
  console.log(`Token:   ${expired ? "expired (run 'sitemgr login' to re-authenticate)" : "valid"}`);
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
  scan: cmdScan,
  sync: cmdSync,
  import: cmdImport,
  add: cmdAdd,
};

if (!command || !(command in commands)) {
  console.log(`sitemgr \u2014 S3-event-driven media indexer

Usage:
  sitemgr login                    Authenticate via browser (device code flow)
  sitemgr logout                   Clear stored credentials
  sitemgr whoami                   Show current session info

  sitemgr bucket list              List configured buckets
  sitemgr bucket add [flags]       Add a bucket config
  sitemgr bucket remove <name>     Remove a bucket config
  sitemgr bucket test <name>       Test S3 connectivity

  sitemgr query [--search Q] [--type TYPE] [--format json] [--limit N] [--bucket B]
  sitemgr show <event_id>
  sitemgr stats [--bucket B]
  sitemgr dedup <bucket>                        Find duplicate files in a bucket
  sitemgr enrich <bucket> [--pending] [--dry-run] [--concurrency N] [<event_id>]
  sitemgr enrich --status
  sitemgr scan <bucket> [--prefix P] [--format json]
                                                Read-only diff: S3 vs recorded events
  sitemgr sync <local-dir> <bucket> [--prefix P] [--dry-run] [--concurrency N]
                                                Upload local files to S3 (local \u2192 S3)
  sitemgr import <bucket> [--prefix P] [--dry-run] [--concurrency N] [--batch-size N]
                                                Create s3:put events for untracked S3 objects
  sitemgr add <bucket> <file> [--prefix path/]  Upload a single file

Authentication:
  Run 'sitemgr login' to authenticate. A browser window will open for you to approve
  the device. Credentials are stored in ~/.sitemgr/credentials.json.

Flags (all commands):
  --verbose         Show technical error details on failure

Bucket add flags:
  --bucket-name B         Bucket name (required)
  --endpoint-url URL      S3 endpoint URL (required)
  --region R              S3 region (optional)
  --access-key-id K       S3 access key (required)
  --secret-access-key S   S3 secret key (required)

Sync flags:
  --prefix P             S3 key prefix to upload under
  --dry-run              Print what would be uploaded, don't upload
  --concurrency N        Parallel upload workers (default: 3)
  --device-id D          Device identifier recorded in events

Import flags:
  --prefix P             Only import objects under this S3 key prefix
  --dry-run              Print the untracked count without writing events
  --concurrency N        Parallel insert batches (default: 3)
  --batch-size N         Rows per insert batch (default: 500)
  --format json          Emit the import report as JSON instead of a table

Exit codes:
  0  Success
  1  User error (bad arguments, missing env var, resource not found)
  2  Service error (S3 unreachable, DB timeout, API failure)
  3  Internal error (unexpected exception)

Environment:
  SITEMGR_WEB_URL           Web API URL (required, e.g. http://localhost:3000)
  SITEMGR_DEVICE_ID         Device identifier (default: default)`);
  process.exit(command ? 1 : 0);
}

const requestId = crypto.randomUUID();
runWithRequestId(requestId, async () => {
  commands[command](rest).catch((err) => {
    logger.error("unhandled command error", { error: String(err), stack: err?.stack });
    cliError(err.message ?? String(err), EXIT.INTERNAL);
  });
});
