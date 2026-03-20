/**
 * Media storage tests — S3-compatible storage operations via Supabase Storage.
 * Rewritten from media-s3.test.ts with BDD naming.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createS3Client,
  listS3Objects,
  downloadS3Object,
  uploadS3Object,
} from "../../lib/media/s3";
import { getS3Config, TINY_JPEG, getAdminClient } from "./setup";

const TEST_BUCKET = `test-storage-${Date.now()}`;

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

  const admin = getAdminClient();
  await admin.storage.createBucket(TEST_BUCKET, { public: false });
});

afterAll(async () => {
  const admin = getAdminClient();
  if (uploadedKeys.length > 0) {
    await admin.storage.from(TEST_BUCKET).remove(uploadedKeys);
  }
  await admin.storage.deleteBucket(TEST_BUCKET).catch(() => {});
});

describe("when uploading objects", () => {
  it("should upload an object and list it in the bucket", async () => {
    const key = `test/photo1-${Date.now()}.jpg`;
    uploadedKeys.push(key);

    await uploadS3Object(s3, TEST_BUCKET, key, TINY_JPEG, "image/jpeg");

    const objects = await listS3Objects(s3, TEST_BUCKET, "test/");
    const found = objects.find((o) => o.key === key);
    expect(found).toBeDefined();
    expect(found!.size).toBe(TINY_JPEG.length);
  });
});

describe("when downloading objects", () => {
  it("should download an uploaded object with correct content", async () => {
    const key = `test/download-${Date.now()}.jpg`;
    uploadedKeys.push(key);

    const original = Buffer.from("hello-world-test-content");
    await uploadS3Object(
      s3,
      TEST_BUCKET,
      key,
      original,
      "application/octet-stream",
    );

    const downloaded = await downloadS3Object(s3, TEST_BUCKET, key);
    expect(Buffer.compare(downloaded, original)).toBe(0);
  });
});

describe("when listing nonexistent prefixes", () => {
  it("should return empty list for nonexistent prefix", async () => {
    const objects = await listS3Objects(
      s3,
      TEST_BUCKET,
      `nonexistent-${Date.now()}/`,
    );
    expect(objects).toEqual([]);
  });
});

describe("when uploading multiple objects", () => {
  it("should upload and list multiple objects", async () => {
    const keys = Array.from(
      { length: 3 },
      (_, i) => `batch/photo${i + 1}-${Date.now()}.jpg`,
    );
    uploadedKeys.push(...keys);

    for (const key of keys) {
      await uploadS3Object(s3, TEST_BUCKET, key, TINY_JPEG, "image/jpeg");
    }

    const objects = await listS3Objects(s3, TEST_BUCKET, "batch/");
    const foundKeys = objects.map((o) => o.key);
    for (const key of keys) {
      expect(foundKeys).toContain(key);
    }
  });
});
