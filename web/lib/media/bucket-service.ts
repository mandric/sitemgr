/**
 * Shared bucket service — extracted from agent/core.ts for reuse by API routes.
 *
 * All functions take explicit dependencies (supabase, s3, userId) rather than
 * relying on phone number resolution or env vars.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { S3Client } from "@aws-sdk/client-s3";
import { ListObjectsV2Command, ListObjectsCommand } from "@aws-sdk/client-s3";
import pLimit from "p-limit";
import {
  encryptSecretVersioned,
  decryptSecretVersioned,
  getEncryptionVersion,
  needsMigration,
} from "@/lib/crypto/encryption-versioned";
import {
  createS3Client,
  listS3Objects,
  downloadS3Object,
} from "@/lib/media/s3";
import {
  insertEnrichment,
  getPendingEnrichments,
  getModelConfig,
} from "@/lib/media/db";
import { getMimeType, newEventId, detectContentType, s3Metadata } from "@/lib/media/utils";
import { EVENT_OP_S3_PUT } from "@/lib/media/constants";
import { enrichImage } from "@/lib/media/enrichment";
import { createLogger, LogComponent } from "@/lib/logger";

const logger = createLogger(LogComponent.S3);

// ── Types ──────────────────────────────────────────────────────

export type BucketConfig = {
  id: string;
  bucket_name: string;
  endpoint_url: string;
  region?: string;
  access_key_id: string;
  secret_access_key: string;
  [key: string]: unknown;
};

export type BucketConfigResult = {
  exists: boolean;
  config?: BucketConfig;
  error?: Error;
};

export type ScanObjectEntry = {
  key: string;
  remote_path: string;
  size: number;
  etag: string;
};

export type ScanModifiedEntry = ScanObjectEntry & {
  previous_hash: string;
};

/**
 * Diff report produced by scanBucket. Compares S3 listing (source of truth
 * for remote state) against events table (source of truth for what sitemgr
 * has recorded). No database writes are made by scan.
 */
export type ScanResult = {
  bucket: string;
  total_objects: number;
  synced_count: number;
  untracked_count: number;
  modified_count: number;
  /** S3 objects that have no matching event (never recorded by sitemgr) */
  untracked: ScanObjectEntry[];
  /** S3 objects whose ETag differs from the latest recorded event */
  modified: ScanModifiedEntry[];
};

export type EnrichResult = {
  enriched: number;
  failed: number;
  skipped: number;
  total: number;
};

/**
 * Result of `importBucket`. `untracked_count` is what scan reported before
 * any inserts; `imported` is how many rows were actually written.
 */
export type ImportResult = {
  bucket: string;
  untracked_count: number;
  imported: number;
  skipped: number;
  errors: number;
  dry_run: boolean;
};

const IMPORT_DEFAULT_BATCH_SIZE = 500;
const IMPORT_DEFAULT_CONCURRENCY = 3;

// ── Bucket Config ──────────────────────────────────────────────

/**
 * Fetch a bucket config by name or UUID, decrypt the secret, and
 * lazy-migrate the encryption key if needed.
 */
export async function getBucketConfig(
  client: SupabaseClient,
  userId: string,
  bucketNameOrId: string,
): Promise<BucketConfigResult> {
  if (!bucketNameOrId) return { exists: false };

  // Detect UUID format to decide lookup column
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bucketNameOrId);
  const column = isUuid ? "id" : "bucket_name";

  const { data, error } = await client
    .from("bucket_configs")
    .select("*")
    .eq(column, bucketNameOrId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    logger.error("bucket config lookup failed", { bucket: bucketNameOrId, error: error.message });
    return { exists: true, error: new Error(error.message) };
  }
  if (!data) return { exists: false };

  try {
    const decryptedSecret = await decryptSecretVersioned(data.secret_access_key);

    // Lazy migration: re-encrypt with current version if needed
    if (needsMigration(data.secret_access_key)) {
      const newCiphertext = await encryptSecretVersioned(decryptedSecret);
      const newVersion = getEncryptionVersion(newCiphertext);

      void (async () => {
        try {
          const { error } = await client
            .from("bucket_configs")
            .update({
              secret_access_key: newCiphertext,
              encryption_key_version: newVersion,
            })
            .eq("id", data.id);

          if (error) {
            logger.error("lazy migration failed", { bucket: data.bucket_name, error: error.message });
          } else {
            logger.info("lazy migration complete", { bucket: data.bucket_name, new_version: newVersion });
          }
        } catch (err) {
          logger.error("lazy migration exception", {
            bucket: data.bucket_name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }

    return {
      exists: true,
      config: { ...data, secret_access_key: decryptedSecret },
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error("cannot decrypt bucket config", {
      bucket: data.bucket_name,
      error: error.message,
    });
    return { exists: true, error };
  }
}

/**
 * Create an S3Client from a decrypted BucketConfig.
 */
export function createS3ClientFromConfig(config: BucketConfig): S3Client {
  return createS3Client({
    endpoint: config.endpoint_url,
    region: config.region ?? undefined,
    accessKeyId: config.access_key_id,
    secretAccessKey: config.secret_access_key,
  });
}

/**
 * Test S3 connectivity by listing 1 object. Falls back to v1 API.
 */
export async function testBucketConnectivity(
  s3: S3Client,
  bucketName: string,
): Promise<{ success: boolean; has_objects: boolean; message: string }> {
  try {
    try {
      const response = await s3.send(
        new ListObjectsV2Command({ Bucket: bucketName, MaxKeys: 1 }),
      );
      const count = response.KeyCount ?? 0;
      return {
        success: true,
        has_objects: count > 0,
        message: `Read access confirmed for "${bucketName}"`,
      };
    } catch {
      // Fallback to v1 for providers that don't support v2
      const response = await s3.send(
        new ListObjectsCommand({ Bucket: bucketName, MaxKeys: 1 }),
      );
      const count = (response.Contents ?? []).length;
      return {
        success: true,
        has_objects: count > 0,
        message: `Read access confirmed for "${bucketName}" (v1 API)`,
      };
    }
  } catch (err) {
    return {
      success: false,
      has_objects: false,
      message: `Cannot read bucket "${bucketName}": ${(err as Error).message}`,
    };
  }
}

/**
 * Strip the dedup hash prefix (`etag:`) to get the raw S3 ETag.
 * Events before spec 19 may have bare ETags; events after have `etag:<etag>`.
 */
function hashToEtag(hash: string | null): string | null {
  if (!hash) return null;
  return hash.startsWith("etag:") ? hash.slice(5) : hash;
}

/**
 * Page size when paginating through events for a bucket. PostgREST's default
 * row cap is 1000; explicitly paging lets us process buckets with more than
 * 1000 events without silently missing any.
 */
const SCAN_EVENTS_PAGE_SIZE = 1000;

/**
 * Produce a read-only diff report comparing the S3 listing against recorded
 * events. Scan does NOT create events — events represent state changes and
 * discovering an S3 object is an observation, not a change. Use
 * `sitemgr sync` to write local files to S3 (which creates `s3:put` events
 * as a side effect).
 */
export async function scanBucket(
  client: SupabaseClient,
  s3: S3Client,
  config: BucketConfig,
  userId: string,
  opts: {
    prefix?: string;
  } = {},
): Promise<ScanResult> {
  const prefix = opts.prefix ?? "";

  // S3 listing and the events query are independent — run them in parallel.
  // Events are paged (PostgREST caps responses at ~1000 rows), ordered by
  // timestamp DESC so that Map.set keeps only the latest hash per remote_path
  // on first insertion.
  const [allObjects, latestHashByPath] = await Promise.all([
    listS3Objects(s3, config.bucket_name, prefix),
    (async (): Promise<Map<string, string | null>> => {
      const map = new Map<string, string | null>();
      let offset = 0;
      for (;;) {
        const { data, error } = await client
          .from("events")
          .select("remote_path, content_hash")
          .eq("user_id", userId)
          .eq("bucket_config_id", config.id)
          .eq("op", EVENT_OP_S3_PUT)
          .order("timestamp", { ascending: false })
          .range(offset, offset + SCAN_EVENTS_PAGE_SIZE - 1);
        if (error) throw error;
        const rows = data ?? [];
        for (const row of rows) {
          if (!row.remote_path) continue;
          if (!map.has(row.remote_path)) {
            map.set(row.remote_path, row.content_hash);
          }
        }
        if (rows.length < SCAN_EVENTS_PAGE_SIZE) break;
        offset += SCAN_EVENTS_PAGE_SIZE;
      }
      return map;
    })(),
  ]);

  const untracked: ScanObjectEntry[] = [];
  const modified: ScanModifiedEntry[] = [];
  let syncedCount = 0;

  for (const obj of allObjects) {
    const remotePath = `s3://${config.bucket_name}/${obj.key}`;
    const entry: ScanObjectEntry = {
      key: obj.key,
      remote_path: remotePath,
      size: obj.size,
      etag: obj.etag,
    };

    if (!latestHashByPath.has(remotePath)) {
      untracked.push(entry);
      continue;
    }

    const recordedHash = latestHashByPath.get(remotePath) ?? null;
    const recordedEtag = hashToEtag(recordedHash);
    if (recordedEtag === obj.etag) {
      syncedCount++;
    } else {
      modified.push({ ...entry, previous_hash: recordedHash ?? "" });
    }
  }

  logger.info("scanBucket complete", {
    bucket: config.bucket_name,
    total_objects: allObjects.length,
    synced: syncedCount,
    untracked: untracked.length,
    modified: modified.length,
  });

  return {
    bucket: config.bucket_name,
    total_objects: allObjects.length,
    synced_count: syncedCount,
    untracked_count: untracked.length,
    modified_count: modified.length,
    untracked,
    modified,
  };
}

/**
 * Ingest pre-existing S3 objects into the events table.
 *
 * Reuses `scanBucket` to identify objects that live in S3 but have no
 * matching event, then creates one `s3:put` event per untracked object so
 * that `enrich --pending` can process them.
 *
 * Import is the write-side counterpart of scan's read-only diff. Modified
 * objects (S3 ETag differs from the latest recorded event) are left alone —
 * those need sync to resolve.
 *
 * Idempotent: re-running after a successful import classifies the same
 * objects as `synced` (not `untracked`) and imports nothing.
 */
export async function importBucket(
  client: SupabaseClient,
  s3: S3Client,
  config: BucketConfig,
  userId: string,
  opts: {
    prefix?: string;
    dry_run?: boolean;
    batch_size?: number;
    concurrency?: number;
  } = {},
): Promise<ImportResult> {
  const dryRun = opts.dry_run ?? false;
  const batchSize = opts.batch_size ?? IMPORT_DEFAULT_BATCH_SIZE;
  const concurrency = opts.concurrency ?? IMPORT_DEFAULT_CONCURRENCY;

  const scan = await scanBucket(client, s3, config, userId, {
    prefix: opts.prefix,
  });

  const untrackedCount = scan.untracked.length;

  if (dryRun || untrackedCount === 0) {
    return {
      bucket: config.bucket_name,
      untracked_count: untrackedCount,
      imported: 0,
      skipped: 0,
      errors: 0,
      dry_run: dryRun,
    };
  }

  // Build event rows from the untracked scan entries. Content type is
  // derived from the key alone — import does not download objects.
  const rows = scan.untracked.map((entry) => ({
    id: newEventId(),
    timestamp: new Date().toISOString(),
    device_id: "api",
    op: EVENT_OP_S3_PUT,
    content_type: detectContentType(entry.key),
    content_hash: `etag:${entry.etag}`,
    local_path: null,
    remote_path: entry.remote_path,
    metadata: {
      ...s3Metadata(entry.key, entry.size, entry.etag),
      source: "s3-import",
    },
    parent_id: null,
    bucket_config_id: config.id,
    user_id: userId,
  }));

  // Chunk into batches so each HTTP round-trip inserts many rows.
  const batches: (typeof rows)[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    batches.push(rows.slice(i, i + batchSize));
  }

  const limit = pLimit(concurrency);
  let imported = 0;
  let errors = 0;

  await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        const { error } = await client.from("events").insert(batch);
        if (error) {
          errors += batch.length;
          logger.error("importBucket batch insert failed", {
            bucket: config.bucket_name,
            batch_size: batch.length,
            error: error.message,
            code: error.code,
          });
        } else {
          imported += batch.length;
        }
      }),
    ),
  );

  logger.info("importBucket complete", {
    bucket: config.bucket_name,
    untracked: untrackedCount,
    imported,
    errors,
  });

  return {
    bucket: config.bucket_name,
    untracked_count: untrackedCount,
    imported,
    skipped: 0,
    errors,
    dry_run: false,
  };
}

/**
 * Enrich unenriched images in a bucket.
 */
export async function enrichBucketPending(
  client: SupabaseClient,
  s3: S3Client,
  config: BucketConfig,
  userId: string,
  opts: {
    event_id?: string;
    concurrency?: number;
    dry_run?: boolean;
  } = {},
): Promise<EnrichResult> {
  const concurrency = opts.concurrency ?? 3;
  const dryRun = opts.dry_run ?? false;

  // Get pending enrichments for this user, filtered by bucket
  const { data: pending, error } = await getPendingEnrichments(client, userId);
  if (error) {
    throw error;
  }

  // Filter to events that belong to this bucket
  let items = (pending ?? []).filter(
    (e) => e.remote_path?.startsWith(`s3://${config.bucket_name}/`),
  );

  // If a specific event_id is requested, filter to just that one
  if (opts.event_id) {
    items = items.filter((e) => e.id === opts.event_id);
  }

  if (dryRun) {
    return {
      enriched: 0,
      failed: 0,
      skipped: 0,
      total: items.length,
    };
  }

  if (items.length === 0) {
    return { enriched: 0, failed: 0, skipped: 0, total: 0 };
  }

  // Load model config for this user
  const { data: modelConfigRow } = await getModelConfig(client, userId);
  const modelConfig = modelConfigRow
    ? {
        provider: modelConfigRow.provider,
        baseUrl: modelConfigRow.base_url,
        model: modelConfigRow.model,
        apiKey: modelConfigRow.api_key_encrypted,
      }
    : undefined;

  const limit = pLimit(concurrency);
  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  const tasks = items.map((event) =>
    limit(async () => {
      const meta = (event.metadata as Record<string, unknown>) ?? {};
      const s3Key =
        (meta.s3_key as string) ??
        (event.remote_path
          ? String(event.remote_path).replace(`s3://${config.bucket_name}/`, "")
          : null);

      if (!s3Key) {
        skipped++;
        return;
      }

      try {
        const imageBytes = await downloadS3Object(s3, config.bucket_name, s3Key);
        const mime = (meta.mime_type as string) ?? getMimeType(s3Key);
        const result = await enrichImage(imageBytes, mime, modelConfig);
        const enrichInsert = await insertEnrichment(client, event.id, result, userId);
        if (enrichInsert.error) throw enrichInsert.error;
        enriched++;
      } catch (err) {
        failed++;
        logger.error("enrich item failed", {
          event_id: event.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  await Promise.all(tasks);

  return { enriched, failed, skipped, total: items.length };
}
