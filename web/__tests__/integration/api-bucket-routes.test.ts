/**
 * Integration tests for /api/buckets routes.
 * Tests bucket CRUD via fetch() with Bearer tokens against real Next.js + Supabase.
 */
import { createTestUserWithToken, cleanupUserData, getAdminClient } from "./setup";

const BASE_URL = `http://localhost:${process.env.WEB_PORT ?? "3000"}`;

function apiFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });
}

describe("API bucket routes", () => {
  let user1: { userId: string; accessToken: string };
  let user2: { userId: string; accessToken: string };
  let createdBucketId: string;
  const admin = getAdminClient();

  beforeAll(async () => {
    user1 = await createTestUserWithToken();
    user2 = await createTestUserWithToken();
  });

  afterAll(async () => {
    await cleanupUserData(admin, user1.userId);
    await cleanupUserData(admin, user2.userId);
  });

  it("POST /api/buckets creates bucket config and returns 201", async () => {
    const res = await apiFetch("/api/buckets", user1.accessToken, {
      method: "POST",
      body: JSON.stringify({
        bucket_name: `test-bucket-${Date.now()}`,
        endpoint_url: "http://localhost:9000",
        access_key_id: "test-access-key",
        secret_access_key: "test-secret-key",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toHaveProperty("id");
    expect(body.data).toHaveProperty("bucket_name");
    expect(body.data).toHaveProperty("endpoint_url");
    expect(body.data).toHaveProperty("created_at");
    createdBucketId = body.data.id;
  });

  it("GET /api/buckets lists bucket configs for user", async () => {
    const res = await apiFetch("/api/buckets", user1.accessToken);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((b: { id: string }) => b.id === createdBucketId)).toBe(true);
  });

  it("DELETE /api/buckets/[id] removes bucket", async () => {
    // Create a second bucket to delete
    const createRes = await apiFetch("/api/buckets", user1.accessToken, {
      method: "POST",
      body: JSON.stringify({
        bucket_name: `delete-me-${Date.now()}`,
        endpoint_url: "http://localhost:9000",
        access_key_id: "test-key",
        secret_access_key: "test-secret",
      }),
    });
    const { data: created } = await createRes.json();

    const delRes = await apiFetch(`/api/buckets/${created.id}`, user1.accessToken, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);

    // Verify it's gone
    const listRes = await apiFetch("/api/buckets", user1.accessToken);
    const { data: buckets } = await listRes.json();
    expect(buckets.some((b: { id: string }) => b.id === created.id)).toBe(false);
  });

  it("GET /api/buckets without auth returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/buckets`);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("DELETE /api/buckets/[id] for another user has no effect", async () => {
    // user2 tries to delete user1's bucket
    const delRes = await apiFetch(`/api/buckets/${createdBucketId}`, user2.accessToken, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200); // silent no-op

    // Verify user1's bucket still exists
    const listRes = await apiFetch("/api/buckets", user1.accessToken);
    const { data: buckets } = await listRes.json();
    expect(buckets.some((b: { id: string }) => b.id === createdBucketId)).toBe(true);
  });
});
