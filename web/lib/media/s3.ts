/**
 * S3 client operations — list and download objects
 */

import {
  S3Client,
  ListObjectsV2Command,
  ListObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createLogger, LogComponent } from "@/lib/logger";
import { classifyS3Error, S3ErrorType } from "./s3-errors";
import { validateS3Key } from "./validation";

const logger = createLogger(LogComponent.S3);

const MAX_PAGES = 1000;

export interface S3Object {
  key: string;
  size: number;
  etag: string;
  lastModified: string;
}

export interface S3Config {
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export function createS3Client(config: S3Config = {}): S3Client {
  const endpoint = config.endpoint ?? process.env.SMGR_S3_ENDPOINT;
  const region = config.region ?? process.env.SMGR_S3_REGION ?? "us-east-1";

  return new S3Client({
    ...(endpoint ? { endpoint } : {}),
    region,
    ...(config.accessKeyId && config.secretAccessKey
      ? {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        }
      : {}),
    forcePathStyle: !!endpoint,
    maxAttempts: 4,
    retryMode: "adaptive",
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5000,
      socketTimeout: 30000,
    }),
  });
}

export async function listS3Objects(
  client: S3Client,
  bucket: string,
  prefix = "",
): Promise<S3Object[]> {
  const objects: S3Object[] = [];

  // Try v2 first, fall back to v1 for Supabase Storage / MinIO
  try {
    let continuationToken: string | undefined;
    let pageCount = 0;
    do {
      pageCount++;
      if (pageCount > MAX_PAGES) {
        throw new Error(
          `S3 pagination exceeded ${MAX_PAGES} pages for bucket "${bucket}" — possible infinite loop`,
        );
      }

      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix || undefined,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of response.Contents ?? []) {
        if (!obj.LastModified) {
          logger.warn(
            "S3 object has no LastModified, using current timestamp",
            { bucket, key: obj.Key },
          );
        }
        objects.push({
          key: obj.Key!,
          size: obj.Size ?? 0,
          etag: (obj.ETag ?? "").replace(/"/g, ""),
          lastModified:
            obj.LastModified?.toISOString() ?? new Date().toISOString(),
        });
      }

      if (response.IsTruncated && !response.NextContinuationToken) {
        logger.warn(
          "S3 response IsTruncated but no NextContinuationToken — treating as last page",
          { bucket, page: pageCount, objects_so_far: objects.length },
        );
      }
      continuationToken =
        response.IsTruncated && response.NextContinuationToken
          ? response.NextContinuationToken
          : undefined;
    } while (continuationToken);

    logger.info("s3 listing complete", {
      bucket,
      prefix: prefix || undefined,
      total_objects: objects.length,
      pages: pageCount,
    });

    return objects;
  } catch (err: unknown) {
    const errorType = classifyS3Error(err);
    if (errorType !== S3ErrorType.Unsupported) throw err;
    logger.info("list_objects_v2 not supported, falling back to v1", {
      bucket,
    });
  }

  // Fallback: v1 with Marker pagination
  let marker: string | undefined;
  let v1PageCount = 0;
  do {
    v1PageCount++;
    if (v1PageCount > MAX_PAGES) {
      throw new Error(
        `S3 pagination exceeded ${MAX_PAGES} pages for bucket "${bucket}" — possible infinite loop`,
      );
    }

    const response = await client.send(
      new ListObjectsCommand({
        Bucket: bucket,
        Prefix: prefix || undefined,
        MaxKeys: 1000,
        Marker: marker,
      }),
    );

    for (const obj of response.Contents ?? []) {
      if (!obj.LastModified) {
        logger.warn(
          "S3 object has no LastModified, using current timestamp",
          { bucket, key: obj.Key },
        );
      }
      objects.push({
        key: obj.Key!,
        size: obj.Size ?? 0,
        etag: (obj.ETag ?? "").replace(/"/g, ""),
        lastModified:
          obj.LastModified?.toISOString() ?? new Date().toISOString(),
      });
    }

    marker = response.IsTruncated
      ? response.NextMarker ?? objects[objects.length - 1]?.key
      : undefined;
  } while (marker);

  logger.info("s3 listing complete", {
    bucket,
    prefix: prefix || undefined,
    total_objects: objects.length,
    pages: v1PageCount,
    fallback: "v1",
  });

  return objects;
}

export async function downloadS3Object(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer> {
  const keyValidation = validateS3Key(key);
  if (!keyValidation.valid) {
    throw new Error(`Invalid S3 key: ${keyValidation.errors.join(", ")}`);
  }

  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const bytes = await response.Body!.transformToByteArray();
    return Buffer.from(bytes);
  } catch (err) {
    const s3ErrorType = classifyS3Error(err);
    (err as any).s3ErrorType = s3ErrorType;
    logger.error("s3 download failed", {
      bucket,
      key,
      s3ErrorType: S3ErrorType[s3ErrorType],
      error: String(err),
    });
    throw err;
  }
}

export async function uploadS3Object(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  contentType?: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ...(contentType ? { ContentType: contentType } : {}),
    }),
  );
}
