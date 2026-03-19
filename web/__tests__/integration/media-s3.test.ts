/**
 * S3 integration tests for media pipeline.
 * Requires `supabase start` to be running locally.
 *
 * Tests use Supabase Storage's S3-compatible API.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createS3Client, listS3Objects, downloadS3Object, uploadS3Object } from "@/lib/media/s3";
import { getS3Config, TINY_JPEG, getAdminClient } from "./setup";

const TEST_BUCKET = `test-media-s3-${Date.now()}`;

let s3: ReturnType<typeof createS3Client>;
const uploadedKeys: string[] = [];

beforeAll(async () => {
  const config = getS3Config();
  s3 = createS3Client({
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });

  // Create test bucket via Supabase Storage API
  const admin = getAdminClient();
  await admin.storage.createBucket(TEST_BUCKET, { public: false });
});

afterAll(async () => {
  // Clean up uploaded objects
  const admin = getAdminClient();
  if (uploadedKeys.length > 0) {
    await admin.storage.from(TEST_BUCKET).remove(uploadedKeys);
  }
  await admin.storage.deleteBucket(TEST_BUCKET);
});

describe("S3 upload and list", () => {
  it("upload object → list → verify in listing", async () => {
    const key = `test-${Date.now()}.jpg`;
    uploadedKeys.push(key);

    await uploadS3Object(s3, TEST_BUCKET, key, TINY_JPEG, "image/jpeg");

    const objects = await listS3Objects(s3, TEST_BUCKET, "");
    const found = objects.find((o) => o.key === key);
    expect(found).toBeDefined();
    expect(found!.size).toBe(TINY_JPEG.length);
  });

  it("upload multiple objects → listing returns all", async () => {
    const keys = Array.from({ length: 5 }, (_, i) => `multi-${Date.now()}-${i}.jpg`);
    uploadedKeys.push(...keys);

    for (const key of keys) {
      await uploadS3Object(s3, TEST_BUCKET, key, TINY_JPEG, "image/jpeg");
    }

    const objects = await listS3Objects(s3, TEST_BUCKET, "");
    const foundKeys = objects.map((o) => o.key);
    for (const key of keys) {
      expect(foundKeys).toContain(key);
    }
  });
});

describe("S3 download", () => {
  it("download uploaded object → content matches original", async () => {
    const key = `download-test-${Date.now()}.jpg`;
    uploadedKeys.push(key);

    const original = Buffer.from("hello-world-test-content");
    await uploadS3Object(s3, TEST_BUCKET, key, original, "application/octet-stream");

    const downloaded = await downloadS3Object(s3, TEST_BUCKET, key);
    expect(Buffer.compare(downloaded, original)).toBe(0);
  });
});

describe("S3 empty bucket listing", () => {
  it("list objects from empty prefix → returns empty array", async () => {
    const objects = await listS3Objects(s3, TEST_BUCKET, `nonexistent-prefix-${Date.now()}/`);
    expect(objects).toEqual([]);
  });
});
