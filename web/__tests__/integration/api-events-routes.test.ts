/**
 * Integration tests for /api/events routes.
 * Tests event query, show, by-hash via fetch() with Bearer tokens.
 */
import {
  createTestUserWithToken,
  cleanupUserData,
  getAdminClient,
  seedUserData,
  assertInsert,
} from "./setup";

const BASE_URL = `http://localhost:${process.env.WEB_PORT ?? "3000"}`;

function apiFetch(path: string, token: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("API events routes", () => {
  let user1: { userId: string; accessToken: string };
  let user2: { userId: string; accessToken: string };
  let seed: Awaited<ReturnType<typeof seedUserData>>;
  const admin = getAdminClient();

  beforeAll(async () => {
    user1 = await createTestUserWithToken();
    user2 = await createTestUserWithToken();

    // Seed 3 events with enrichments for user1
    seed = await seedUserData(admin, user1.userId, {
      eventCount: 3,
      withEnrichments: true,
      withWatchedKeys: false,
      withBucketConfig: true,
      withConversation: false,
      withUserProfile: true,
    });

    // Link first event to the bucket config for filtering tests
    if (seed.bucketConfigId) {
      await admin
        .from("events")
        .update({ bucket_config_id: seed.bucketConfigId })
        .eq("id", seed.eventIds[0]);
    }
  });

  afterAll(async () => {
    await cleanupUserData(admin, user1.userId);
    await cleanupUserData(admin, user2.userId);
  });

  it("GET /api/events returns seeded events", async () => {
    const res = await apiFetch("/api/events", user1.accessToken);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(3);
  });

  it("GET /api/events?bucket_config_id filters events", async () => {
    const res = await apiFetch(
      `/api/events?bucket_config_id=${seed.bucketConfigId}`,
      user1.accessToken,
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.length).toBe(1);
  });

  it("GET /api/events?limit=1 returns single event", async () => {
    const res = await apiFetch("/api/events?limit=1", user1.accessToken);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.length).toBe(1);
  });

  it("GET /api/events/[id] returns event detail", async () => {
    const eventId = seed.eventIds[0];
    const res = await apiFetch(`/api/events/${eventId}`, user1.accessToken);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveProperty("id", eventId);
  });

  it("GET /api/events/by-hash/[hash] returns matching event", async () => {
    const prefix = user1.userId.slice(0, 8);
    const hash = `hash-${prefix}-1`;
    const res = await apiFetch(`/api/events/by-hash/${hash}`, user1.accessToken);
    expect(res.status).toBe(200);

    const body = await res.json();
    // findEventByHash only selects "id", so just verify we got a result
    expect(body.data).toBeTruthy();
    expect(body.data).toHaveProperty("id");
  });

  it("GET /api/events without auth returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/events`);
    expect(res.status).toBe(401);
  });

  it("GET /api/events/[id] for another user returns 404", async () => {
    const eventId = seed.eventIds[0];
    const res = await apiFetch(`/api/events/${eventId}`, user2.accessToken);
    expect(res.status).toBe(404);
  });
});
