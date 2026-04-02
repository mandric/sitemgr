/**
 * Integration tests for GET /api/stats.
 * Tests aggregate event/enrichment statistics via real Supabase.
 */
import {
  createTestUserWithToken,
  cleanupUserData,
  getAdminClient,
  seedUserData,
} from "./setup";

const BASE_URL = `http://localhost:${process.env.WEB_PORT ?? "3000"}`;

function apiFetch(path: string, token: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("API stats routes", () => {
  let user1: { userId: string; accessToken: string };
  let seed: Awaited<ReturnType<typeof seedUserData>>;
  const admin = getAdminClient();

  beforeAll(async () => {
    user1 = await createTestUserWithToken();
    seed = await seedUserData(admin, user1.userId, {
      eventCount: 2,
      withEnrichments: true,
      withWatchedKeys: true,
      withBucketConfig: true,
      withConversation: false,
      withUserProfile: true,
    });
  });

  afterAll(async () => {
    await cleanupUserData(admin, user1.userId);
  });

  it("GET /api/stats returns event and enrichment counts", async () => {
    const res = await apiFetch("/api/stats", user1.accessToken);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveProperty("total_events");
    expect(body.data).toHaveProperty("enriched");
    expect(body.data.total_events).toBeGreaterThanOrEqual(2);
    expect(body.data.enriched).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/stats?bucket_config_id filters stats", async () => {
    // Events without bucket_config_id won't match, so filtered count should be 0
    const res = await apiFetch(
      `/api/stats?bucket_config_id=${seed.bucketConfigId}`,
      user1.accessToken,
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveProperty("total_events");
    // Seeded events don't have bucket_config_id set, so filtered total should be 0
    expect(body.data.total_events).toBe(0);
  });

  it("GET /api/stats without auth returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/stats`);
    expect(res.status).toBe(401);
  });
});
