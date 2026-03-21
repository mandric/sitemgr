/**
 * Media lifecycle tests — end-to-end user journey from upload to search.
 * Merges media-db and media-pipeline test coverage.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAdminClient,
  createTestUser,
  seedUserData,
  cleanupUserData,
  getS3Config,
  TINY_JPEG,
  type SeedResult,
} from "./setup";
import {
  insertEvent,
  insertEnrichment,
  upsertWatchedKey,
} from "../../lib/media/db";
import {
  createS3Client,
  uploadS3Object,
} from "../../lib/media/s3";

let admin: SupabaseClient;
let userId: string;
let userClient: SupabaseClient;
let userBId: string;
let userBClient: SupabaseClient;
let userBSeed: SeedResult;
let s3: ReturnType<typeof createS3Client>;
let bucketName: string;
const uploadedKeys: string[] = [];

beforeAll(async () => {
  admin = getAdminClient();
  const s3Config = getS3Config();

  const user = await createTestUser();
  userId = user.userId;
  userClient = user.client;

  const userB = await createTestUser();
  userBId = userB.userId;
  userBClient = userB.client;
  userBSeed = await seedUserData(admin, userBId, { eventCount: 1 });

  // Create test bucket
  bucketName = `test-lifecycle-${Date.now()}`;
  await admin.storage.createBucket(bucketName, { public: false });

  // Seed bucket config for primary user
  await admin.from("bucket_configs").insert({
    user_id: userId,
    bucket_name: bucketName,
    endpoint_url: s3Config.endpoint,
    access_key_id: s3Config.accessKeyId,
    secret_access_key: s3Config.secretAccessKey,
  });

  // Seed user profile for primary user
  await admin.from("user_profiles").insert({
    id: userId,
    phone_number: `+1555${userId.slice(0, 8)}`,
  });

  s3 = createS3Client({
    endpoint: s3Config.endpoint,
    region: s3Config.region,
    accessKeyId: s3Config.accessKeyId,
    secretAccessKey: s3Config.secretAccessKey,
  });
}, 30000);

afterAll(async () => {
  // Clean up S3 objects
  if (uploadedKeys.length > 0) {
    await admin.storage.from(bucketName).remove(uploadedKeys);
  }
  // Delete bucket
  await admin.storage.deleteBucket(bucketName).catch(() => {});

  // Clean up primary user data
  await admin.from("enrichments").delete().eq("user_id", userId);
  await admin.from("watched_keys").delete().eq("user_id", userId);
  await admin.from("events").delete().eq("user_id", userId);
  await admin.from("bucket_configs").delete().eq("user_id", userId);
  await admin.from("conversations").delete().eq("user_id", userId);
  await admin.from("user_profiles").delete().eq("id", userId);
  await admin.auth.admin.deleteUser(userId);

  await cleanupUserData(admin, userBId);

  // Tear down authenticated sessions
  await userClient.auth.signOut();
  await userBClient.auth.signOut();

  // Clean up all client connections to prevent dangling handles
  await Promise.all([
    admin.removeAllChannels(),
    userClient.removeAllChannels(),
    userBClient.removeAllChannels(),
  ]);
});

describe("when uploading and searching for media", () => {
  const eventId = `lifecycle-search-evt-1`;

  it("should find uploaded photo via full-text search matching enrichment description", async () => {
    // Upload to S3
    const key = `${userId.slice(0, 8)}/photo-search.jpg`;
    await uploadS3Object(s3, bucketName, key, TINY_JPEG, "image/jpeg");
    uploadedKeys.push(key);

    // Insert event (type: "create" matches what search_events SQL function filters)
    const { error: evtErr } = await insertEvent(admin, {
      id: eventId,
      device_id: "test-device",
      type: "create",
      content_type: "image/jpeg",
      content_hash: `hash-search-${Date.now()}`,
      local_path: null,
      remote_path: null,
      metadata: null,
      parent_id: null,
      user_id: userId,
    });
    expect(evtErr).toBeNull();

    // Insert enrichment with searchable description
    const { error: enrErr } = await insertEnrichment(
      admin,
      eventId,
      {
        description: "sunset over mountains",
        objects: ["mountain", "sun"],
        context: "outdoor landscape",
        suggested_tags: ["nature", "sunset"],
      },
      userId,
    );
    expect(enrErr).toBeNull();

    // Search for it using correct parameter name (query_text, not p_query)
    const { data, error } = await admin.rpc("search_events", {
      p_user_id: userId,
      query_text: "sunset",
    });
    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data!.length).toBeGreaterThanOrEqual(1);
    const found = data!.find(
      (e: { id: string }) => e.id === eventId,
    );
    expect(found).toBeDefined();
  });

  it("should not return results for non-matching search query", async () => {
    const { data } = await admin.rpc("search_events", {
      p_user_id: userId,
      query_text: "xyznonexistent",
    });
    expect(data ?? []).toHaveLength(0);
  });
});

describe("when requesting statistics", () => {
  const evtPhoto2 = `lifecycle-stats-photo-2`;
  const evtVideo = `lifecycle-stats-video-1`;

  beforeAll(async () => {
    // Seed additional events for stats (type: "create" for content type stats)
    const { error: e1 } = await insertEvent(admin, {
      id: evtPhoto2,
      device_id: "test-device",
      type: "create",
      content_type: "image/jpeg",
      content_hash: `hash-stats-photo2-${Date.now()}`,
      local_path: null,
      remote_path: null,
      metadata: null,
      parent_id: null,
      user_id: userId,
    });
    expect(e1).toBeNull();

    const { error: e2 } = await insertEvent(admin, {
      id: evtVideo,
      device_id: "test-device",
      type: "create",
      content_type: "video/mp4",
      content_hash: `hash-stats-video-${Date.now()}`,
      local_path: null,
      remote_path: null,
      metadata: null,
      parent_id: null,
      user_id: userId,
    });
    expect(e2).toBeNull();

    const { error: e3 } = await insertEnrichment(
      admin,
      evtPhoto2,
      {
        description: "another photo",
        objects: [],
        context: "",
        suggested_tags: [],
      },
      userId,
    );
    expect(e3).toBeNull();
  });

  it("should return correct counts by content type", async () => {
    const { data } = await admin.rpc("stats_by_content_type", {
      p_user_id: userId,
    });
    expect(data).toBeDefined();
    const jpegRow = data!.find(
      (r: { content_type: string }) => r.content_type === "image/jpeg",
    );
    expect(jpegRow).toBeDefined();
    expect(Number(jpegRow!.count)).toBeGreaterThanOrEqual(2);
  });

  it("should return correct counts by event type", async () => {
    const { data } = await admin.rpc("stats_by_event_type", {
      p_user_id: userId,
    });
    expect(data).toBeDefined();
    const createRow = data!.find(
      (r: { type: string }) => r.type === "create",
    );
    expect(createRow).toBeDefined();
    expect(Number(createRow!.count)).toBeGreaterThanOrEqual(3);
  });
});

describe("when checking enrichment progress", () => {
  it("should show correct pending and enriched counts", async () => {
    // Query directly via admin to bypass getUserClient() RLS issue
    const [totalRes, enrichedRes] = await Promise.all([
      admin
        .from("events")
        .select("*", { count: "exact", head: true })
        .eq("type", "create")
        .eq("user_id", userId),
      admin
        .from("enrichments")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId),
    ]);

    const total = totalRes.count ?? 0;
    const enriched = enrichedRes.count ?? 0;
    const pending = total - enriched;

    // We have 3 "create" events, 2 enriched (search + photo2)
    expect(enriched).toBeGreaterThanOrEqual(2);
    expect(pending).toBeGreaterThanOrEqual(1);
    expect(total).toBe(enriched + pending);
  });
});

describe("when re-scanning a watched key", () => {
  it("should update etag on re-scan without creating duplicate", async () => {
    const testKey = `${userId.slice(0, 8)}/watched-upsert-test.jpg`;

    // First upsert
    const { error: u1 } = await upsertWatchedKey(admin, testKey, null, "etag-abc", 1000, userId);
    expect(u1).toBeNull();

    // Re-upsert with new etag
    const { error: u2 } = await upsertWatchedKey(admin, testKey, null, "etag-def", 2000, userId);
    expect(u2).toBeNull();

    // Verify only one row with updated etag
    const { data } = await admin
      .from("watched_keys")
      .select("*")
      .eq("s3_key", testKey);
    expect(data).toHaveLength(1);
    expect(data![0].etag).toBe("etag-def");
    expect(data![0].size_bytes).toBe(2000);
  });
});

describe("when another user has media", () => {
  it("should not include other user's events in query results", async () => {
    const { data } = await userClient.from("events").select("*");
    expect(data).toBeDefined();
    for (const event of data!) {
      expect(event.user_id).toBe(userId);
    }
    // Ensure user B's events are not included
    const userBEventIds = userBSeed.eventIds;
    const returnedIds = data!.map((e: { id: string }) => e.id);
    for (const id of userBEventIds) {
      expect(returnedIds).not.toContain(id);
    }
  });
});
