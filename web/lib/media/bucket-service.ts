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
  insertEvent,
  insertEnrichment,
  upsertWatchedKey,
  getWatchedKeys,
  getPendingEnrichments,
  getModelConfig,
} from "@/lib/media/db";
import {
  newEventId,
  detectContentType,
  getMimeType,
  s3Metadata,
} from "@/lib/media/utils";
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

export type ScanResult = {
  bucket: string;
  total_objects: number;
  already_indexed: number;
  new_objects: number;
  created_events: number;
  batch_enriched: number;
  per_object: Array<{ key: string; status: ObjectStatus; error?: string }>;
};

export type EnrichResult = {
  enriched: number;
  failed: number;
  skipped: number;
  total: number;
};

type ObjectStatus = "enriched" | "indexed" | "enrich_failed" | "error";

const IMAGE_MIME_PREFIXES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

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
 * Scan an S3 bucket for new objects, insert events + watched_keys.
 */
export async function scanBucket(
  client: SupabaseClient,
  s3: S3Client,
  config: BucketConfig,
  userId: string,
  opts: {
    prefix?: string;
    batch_size?: number;
    auto_enrich?: boolean;
    device_id?: string;
  } = {},
): Promise<ScanResult> {
  const batchSize = opts.batch_size ?? 100;
  const deviceId = opts.device_id ?? "api";
  const prefix = opts.prefix ?? "";
  const autoEnrich = opts.auto_enrich ?? false;

  const allObjects = await listS3Objects(s3, config.bucket_name, prefix);

  // Get already-watched keys to find new ones
  const watchedResult = await getWatchedKeys(client, userId);
  if (watchedResult.error) {
    throw watchedResult.error;
  }
  const watchedKeys = new Set(
    (watchedResult.data ?? []).map((r: { s3_key: string }) => r.s3_key),
  );
  const newObjects = allObjects.filter((o) => !watchedKeys.has(o.key));
  const batch = newObjects.slice(0, batchSize);

  const limit = pLimit(3);

  const perObject = await Promise.all(
    batch.map((obj) =>
      limit(async (): Promise<{ key: string; status: ObjectStatus; error?: string }> => {
        try {
          const eventId = newEventId();
          const contentType = detectContentType(obj.key);
          const mimeType = getMimeType(obj.key);

          const insertResult = await insertEvent(client, {
            id: eventId,
            device_id: deviceId,
            type: "create",
            content_type: contentType,
            content_hash: `etag:${obj.etag}`,
            local_path: null,
            remote_path: `s3://${config.bucket_name}/${obj.key}`,
            metadata: s3Metadata(obj.key, obj.size, obj.etag),
            parent_id: null,
            bucket_config_id: config.id,
            user_id: userId,
          });
          if (insertResult.error) throw insertResult.error;

          const upsertResult = await upsertWatchedKey(
            client, obj.key, eventId, obj.etag, obj.size, userId, config.id,
          );
          if (upsertResult.error) {
            logger.warn("upsertWatchedKey failed", {
              key: obj.key,
              error: (upsertResult.error as Error).message ?? String(upsertResult.error),
            });
          }

          // Enrich if it's an image and auto-enrich is on
          if (autoEnrich && IMAGE_MIME_PREFIXES.includes(mimeType)) {
            try {
              const imageBytes = await downloadS3Object(s3, config.bucket_name, obj.key);
              const result = await enrichImage(imageBytes, mimeType);
              const enrichInsert = await insertEnrichment(client, eventId, result, userId);
              if (enrichInsert.error) throw enrichInsert.error;
              return { key: obj.key, status: "enriched" };
            } catch (enrichErr) {
              logger.warn("enrichment failed", {
                key: obj.key,
                error: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
              });
              return {
                key: obj.key,
                status: "enrich_failed",
                error: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
              };
            }
          }

          return { key: obj.key, status: "indexed" };
        } catch (err) {
          return {
            key: obj.key,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    ),
  );

  const createdEvents = perObject.filter(
    (r) => r.status === "indexed" || r.status === "enriched" || r.status === "enrich_failed",
  ).length;
  const batchEnriched = perObject.filter((r) => r.status === "enriched").length;

  logger.info("scanBucket complete", {
    bucket: config.bucket_name,
    created_events: createdEvents,
    batch_enriched: batchEnriched,
    errors: perObject.filter((r) => r.status === "error").length,
  });

  return {
    bucket: config.bucket_name,
    total_objects: allObjects.length,
    already_indexed: allObjects.length - newObjects.length,
    new_objects: newObjects.length,
    created_events: createdEvents,
    batch_enriched: batchEnriched,
    per_object: perObject,
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
