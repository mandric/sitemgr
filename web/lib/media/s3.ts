/**
 * S3 client operations — list and download objects
 */

import {
  S3Client,
  ListObjectsV2Command,
  ListObjectsCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

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
  });
}

export async function listS3Objects(
  client: S3Client,
  bucket: string,
  prefix = ""
): Promise<S3Object[]> {
  const objects: S3Object[] = [];

  // Try v2 first, fall back to v1 for Supabase Storage / MinIO
  try {
    let continuationToken: string | undefined;
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix || undefined,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        })
      );

      for (const obj of response.Contents ?? []) {
        objects.push({
          key: obj.Key!,
          size: obj.Size ?? 0,
          etag: (obj.ETag ?? "").replace(/"/g, ""),
          lastModified: obj.LastModified?.toISOString() ?? "",
        });
      }

      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return objects;
  } catch (err: unknown) {
    const msg = String(err).toLowerCase();
    const isUnsupported =
      msg.includes("not implemented") ||
      msg.includes("unsupported") ||
      msg.includes("404") ||
      msg.includes("not found");

    if (!isUnsupported) throw err;
    console.error("  Note: list_objects_v2 not supported, using v1 fallback");
  }

  // Fallback: v1 with Marker pagination
  let marker: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsCommand({
        Bucket: bucket,
        Prefix: prefix || undefined,
        MaxKeys: 1000,
        Marker: marker,
      })
    );

    for (const obj of response.Contents ?? []) {
      objects.push({
        key: obj.Key!,
        size: obj.Size ?? 0,
        etag: (obj.ETag ?? "").replace(/"/g, ""),
        lastModified: obj.LastModified?.toISOString() ?? "",
      });
    }

    marker = response.IsTruncated
      ? response.NextMarker ?? objects[objects.length - 1]?.key
      : undefined;
  } while (marker);

  return objects;
}

export async function downloadS3Object(
  client: S3Client,
  bucket: string,
  key: string
): Promise<Buffer> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  const bytes = await response.Body!.transformToByteArray();
  return Buffer.from(bytes);
}
