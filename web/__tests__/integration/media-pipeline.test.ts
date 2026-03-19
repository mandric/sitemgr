/**
 * End-to-end pipeline integration tests.
 * Combines S3 + DB operations with mocked enrichment.
 *
 * Requires `supabase start` to be running locally.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createS3Client, listS3Objects, uploadS3Object } from "@/lib/media/s3";
import {
  insertEvent,
  insertEnrichment,
  upsertWatchedKey,
  getWatchedKeys,
  queryEvents,
} from "@/lib/media/db";
import { newEventId, detectContentType, s3Metadata } from "@/lib/media/utils";
import {
  getAdminClient,
  createTestUser,
  cleanupTestData,
  getS3Config,
  TINY_JPEG,
} from "./setup";

const TEST_BUCKET = `test-pipeline-${Date.now()}`;

let s3: ReturnType<typeof createS3Client>;
let userId: string;
const uploadedKeys: string[] = [];

beforeAll(async () => {
  const config = getS3Config();
  s3 = createS3Client({
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });

  // Create bucket
  const admin = getAdminClient();
  await admin.storage.createBucket(TEST_BUCKET, { public: false });

  // Create test user
  const testUser = await createTestUser();
  userId = testUser.userId;
});

afterAll(async () => {
  // Clean up
  const admin = getAdminClient();
  if (uploadedKeys.length > 0) {
    await admin.storage.from(TEST_BUCKET).remove(uploadedKeys);
  }
  await admin.storage.deleteBucket(TEST_BUCKET);
  await cleanupTestData(userId);
});

beforeEach(async () => {
  const admin = getAdminClient();
  await admin.from("enrichments").delete().eq("user_id", userId);
  await admin.from("watched_keys").delete().eq("user_id", userId);
  await admin.from("events").delete().eq("user_id", userId);
});

describe("Full pipeline: S3 → DB → Search", () => {
  it("upload image → list → create event → verify in DB", async () => {
    const key = `pipeline-${Date.now()}.jpg`;
    uploadedKeys.push(key);

    // Upload to S3
    await uploadS3Object(s3, TEST_BUCKET, key, TINY_JPEG, "image/jpeg");

    // List objects via S3 client
    const objects = await listS3Objects(s3, TEST_BUCKET, "");
    const found = objects.find((o) => o.key === key);
    expect(found).toBeDefined();

    // Create event in DB
    const eventId = newEventId();
    const contentType = detectContentType(key);
    const meta = s3Metadata(key, found!.size, found!.etag);

    await insertEvent({
      id: eventId,
      device_id: "integration-test",
      type: "create",
      content_type: contentType,
      content_hash: `etag:${found!.etag}`,
      local_path: null,
      remote_path: `s3://${TEST_BUCKET}/${key}`,
      metadata: meta,
      parent_id: null,
      user_id: userId,
    });

    await upsertWatchedKey(key, eventId, found!.etag, found!.size, userId);

    // Verify watched key
    const watched = await getWatchedKeys(userId);
    expect(watched.has(key)).toBe(true);

    // Verify event in query results
    const result = await queryEvents({ userId });
    const ids = result.events.map((e: Record<string, unknown>) => e.id);
    expect(ids).toContain(eventId);
  });

  it("pipeline with mocked enrichment → search finds by description", async () => {
    const key = `pipeline-enrich-${Date.now()}.jpg`;
    uploadedKeys.push(key);

    // Upload to S3
    await uploadS3Object(s3, TEST_BUCKET, key, TINY_JPEG, "image/jpeg");

    // List + create event
    const objects = await listS3Objects(s3, TEST_BUCKET, "");
    const found = objects.find((o) => o.key === key);
    expect(found).toBeDefined();

    const eventId = newEventId();
    await insertEvent({
      id: eventId,
      device_id: "integration-test",
      type: "create",
      content_type: "photo",
      content_hash: `etag:${found!.etag}`,
      local_path: null,
      remote_path: `s3://${TEST_BUCKET}/${key}`,
      metadata: s3Metadata(key, found!.size, found!.etag),
      parent_id: null,
      user_id: userId,
    });

    await upsertWatchedKey(key, eventId, found!.etag, found!.size, userId);

    // Insert mock enrichment (no real Claude API call)
    await insertEnrichment(eventId, {
      description: "A fluffy orange tabby cat sleeping on a warm windowsill",
      objects: ["cat", "windowsill"],
      context: "indoor",
      suggested_tags: ["cat", "pet", "cozy"],
    }, userId);

    // Search should find by description
    const result = await queryEvents({
      userId,
      search: "orange tabby cat",
    });

    expect(result.total).toBeGreaterThanOrEqual(1);
    const match = result.events.find((e: Record<string, unknown>) => e.id === eventId);
    expect(match).toBeDefined();
  });
});
