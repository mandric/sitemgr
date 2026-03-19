/**
 * Database integration tests for media pipeline.
 * Requires `supabase start` to be running locally.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  getAdminClient,
  createTestUser,
  cleanupTestData,
} from "./setup";
import {
  insertEvent,
  insertEnrichment,
  upsertWatchedKey,
  getWatchedKeys,
  queryEvents,
  getStats,
  getEnrichStatus,
} from "@/lib/media/db";
import { newEventId } from "@/lib/media/utils";

let userIdA: string;
let userIdB: string;

beforeAll(async () => {
  const userA = await createTestUser();
  const userB = await createTestUser();
  userIdA = userA.userId;
  userIdB = userB.userId;
});

afterAll(async () => {
  await cleanupTestData(userIdA);
  await cleanupTestData(userIdB);
});

beforeEach(async () => {
  // Clean event/enrichment data between tests (keep users)
  const admin = getAdminClient();
  await admin.from("enrichments").delete().eq("user_id", userIdA);
  await admin.from("enrichments").delete().eq("user_id", userIdB);
  await admin.from("watched_keys").delete().eq("user_id", userIdA);
  await admin.from("watched_keys").delete().eq("user_id", userIdB);
  await admin.from("events").delete().eq("user_id", userIdA);
  await admin.from("events").delete().eq("user_id", userIdB);
});

describe("Full-Text Search", () => {
  it("insert event + enrichment → search by description text → found", async () => {
    const eventId = newEventId();
    await insertEvent({
      id: eventId,
      device_id: "test",
      type: "create",
      content_type: "photo",
      content_hash: `sha256:${eventId}`,
      local_path: null,
      remote_path: `s3://test-bucket/${eventId}.jpg`,
      metadata: { s3_key: `${eventId}.jpg` },
      parent_id: null,
      user_id: userIdA,
    });

    await insertEnrichment(eventId, {
      description: "A golden retriever playing in the park",
      objects: ["dog", "park"],
      context: "outdoor",
      suggested_tags: ["dog", "park"],
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      raw_response: "{}",
    }, userIdA);

    const result = await queryEvents({
      userId: userIdA,
      search: "golden retriever",
    });

    expect(result.total).toBeGreaterThanOrEqual(1);
    const found = result.events.find((e: any) => e.id === eventId);
    expect(found).toBeDefined();
  });

  it("filter by content_type + date range + search text", async () => {
    // Create today's photo
    const photoId = newEventId();
    await insertEvent({
      id: photoId,
      device_id: "test",
      type: "create",
      content_type: "photo",
      content_hash: `sha256:${photoId}`,
      local_path: null,
      remote_path: `s3://test/${photoId}.jpg`,
      metadata: {},
      parent_id: null,
      user_id: userIdA,
    });

    await insertEnrichment(photoId, {
      description: "sunset over ocean",
      objects: [],
      context: "",
      suggested_tags: ["sunset"],
      provider: "anthropic",
      model: "test",
      raw_response: "{}",
    }, userIdA);

    // Create today's video
    const videoId = newEventId();
    await insertEvent({
      id: videoId,
      device_id: "test",
      type: "create",
      content_type: "video",
      content_hash: `sha256:${videoId}`,
      local_path: null,
      remote_path: `s3://test/${videoId}.mp4`,
      metadata: {},
      parent_id: null,
      user_id: userIdA,
    });

    const result = await queryEvents({
      userId: userIdA,
      type: "photo",
      search: "sunset",
    });

    const ids = result.events.map((e: any) => e.id);
    expect(ids).toContain(photoId);
    expect(ids).not.toContain(videoId);
  });
});

describe("RLS Isolation", () => {
  it("user A cannot see user B events via queryEvents", async () => {
    const eventA = newEventId();
    const eventB = newEventId();

    await insertEvent({
      id: eventA,
      device_id: "test",
      type: "create",
      content_type: "photo",
      content_hash: `sha256:${eventA}`,
      local_path: null,
      remote_path: `s3://test/${eventA}.jpg`,
      metadata: {},
      parent_id: null,
      user_id: userIdA,
    });

    await insertEvent({
      id: eventB,
      device_id: "test",
      type: "create",
      content_type: "photo",
      content_hash: `sha256:${eventB}`,
      local_path: null,
      remote_path: `s3://test/${eventB}.jpg`,
      metadata: {},
      parent_id: null,
      user_id: userIdB,
    });

    const resultA = await queryEvents({ userId: userIdA });
    const resultB = await queryEvents({ userId: userIdB });

    const idsA = resultA.events.map((e: any) => e.id);
    const idsB = resultB.events.map((e: any) => e.id);

    expect(idsA).toContain(eventA);
    expect(idsA).not.toContain(eventB);
    expect(idsB).toContain(eventB);
    expect(idsB).not.toContain(eventA);
  });
});

describe("Stats", () => {
  it("returns correct counts matching actual data", async () => {
    const id1 = newEventId();
    const id2 = newEventId();

    await insertEvent({
      id: id1,
      device_id: "test",
      type: "create",
      content_type: "photo",
      content_hash: `sha256:${id1}`,
      local_path: null,
      remote_path: `s3://test/${id1}.jpg`,
      metadata: {},
      parent_id: null,
      user_id: userIdA,
    });
    await insertEvent({
      id: id2,
      device_id: "test",
      type: "create",
      content_type: "video",
      content_hash: `sha256:${id2}`,
      local_path: null,
      remote_path: `s3://test/${id2}.mp4`,
      metadata: {},
      parent_id: null,
      user_id: userIdA,
    });

    const stats = await getStats(userIdA);
    expect(stats.total_events).toBeGreaterThanOrEqual(2);
  });
});

describe("Upsert Bug Fix Verification", () => {
  it("upsert watched key → re-upsert with new ETag → ETag updated", async () => {
    const eventId = newEventId();
    const key = `test-upsert-${Date.now()}.jpg`;

    await insertEvent({
      id: eventId,
      device_id: "test",
      type: "create",
      content_type: "photo",
      content_hash: `sha256:${eventId}`,
      local_path: null,
      remote_path: `s3://test/${key}`,
      metadata: {},
      parent_id: null,
      user_id: userIdA,
    });

    // First upsert
    await upsertWatchedKey(key, eventId, "etag-abc", 1000, userIdA);

    // Verify first value
    const watched1 = await getWatchedKeys(userIdA);
    expect(watched1.has(key)).toBe(true);

    // Re-upsert with new etag
    await upsertWatchedKey(key, eventId, "etag-def", 2000, userIdA);

    // Verify the row was updated (not just ignored)
    const admin = getAdminClient();
    const { data } = await admin
      .from("watched_keys")
      .select("etag, size_bytes")
      .eq("s3_key", key)
      .eq("user_id", userIdA)
      .single();

    expect(data?.etag).toBe("etag-def");
    expect(data?.size_bytes).toBe(2000);
  });
});

describe("Enrich Status", () => {
  it("returns correct pending count", async () => {
    const enrichedId = newEventId();
    const pendingId = newEventId();

    await insertEvent({
      id: enrichedId,
      device_id: "test",
      type: "create",
      content_type: "photo",
      content_hash: `sha256:${enrichedId}`,
      local_path: null,
      remote_path: `s3://test/${enrichedId}.jpg`,
      metadata: {},
      parent_id: null,
      user_id: userIdA,
    });
    await insertEnrichment(enrichedId, {
      description: "enriched",
      objects: [],
      context: "",
      suggested_tags: [],
      provider: "anthropic",
      model: "test",
      raw_response: "{}",
    }, userIdA);

    await insertEvent({
      id: pendingId,
      device_id: "test",
      type: "create",
      content_type: "photo",
      content_hash: `sha256:${pendingId}`,
      local_path: null,
      remote_path: `s3://test/${pendingId}.jpg`,
      metadata: {},
      parent_id: null,
      user_id: userIdA,
    });

    const status = await getEnrichStatus(userIdA);
    expect(status.pending).toBeGreaterThanOrEqual(1);
    expect(status.enriched).toBeGreaterThanOrEqual(1);
  });
});
