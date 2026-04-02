/**
 * Integration tests for /api/enrichments routes.
 * Tests enrichment status and pending endpoints via real Supabase.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestUserWithToken,
  cleanupUserData,
  getAdminClient,
  assertInsert,
} from "./setup";
import { CONTENT_TYPE_PHOTO } from "../../lib/media/constants";

const BASE_URL = `http://localhost:${process.env.WEB_PORT ?? "3000"}`;

function apiFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });
}

describe("API enrichment routes", () => {
  let user1: { userId: string; accessToken: string };
  const admin = getAdminClient();
  let pendingEventId: string;

  beforeAll(async () => {
    user1 = await createTestUserWithToken();

    // Seed user profile
    assertInsert(
      "user_profiles",
      await admin.from("user_profiles").insert({
        id: user1.userId,
        phone_number: `+1555${user1.userId.slice(0, 8)}`,
      }),
    );

    const prefix = user1.userId.slice(0, 8);

    // Seed 3 events: 2 with enrichments, 1 without (pending)
    for (let i = 1; i <= 3; i++) {
      const eventId = `${prefix}-enr-${i}`;
      assertInsert(
        `events[${i}]`,
        await admin.from("events").insert({
          id: eventId,
          timestamp: new Date().toISOString(),
          device_id: `device-${prefix}`,
          type: "create",
          content_type: CONTENT_TYPE_PHOTO,
          content_hash: `enr-hash-${prefix}-${i}`,
          user_id: user1.userId,
        }),
      );

      if (i <= 2) {
        // Add enrichment for first 2 events
        assertInsert(
          `enrichments[${eventId}]`,
          await admin.from("enrichments").insert({
            event_id: eventId,
            description: `Enrichment for ${eventId}`,
            objects: ["obj1"],
            context: "test",
            tags: ["tag1"],
            user_id: user1.userId,
          }),
        );
      } else {
        pendingEventId = eventId;
      }
    }
  });

  afterAll(async () => {
    await cleanupUserData(admin, user1.userId);
  });

  it("GET /api/enrichments/status returns enriched vs pending counts", async () => {
    const res = await apiFetch("/api/enrichments/status", user1.accessToken);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveProperty("total_media");
    expect(body.data).toHaveProperty("enriched");
    expect(body.data).toHaveProperty("pending");
    expect(body.data.total_media).toBe(3);
    expect(body.data.enriched).toBe(2);
    expect(body.data.pending).toBe(1);
  });

  it("GET /api/enrichments/pending returns unenriched events", async () => {
    const res = await apiFetch("/api/enrichments/pending", user1.accessToken);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].id).toBe(pendingEventId);
  });

  it("POST /api/enrichments without auth returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/enrichments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: "x", result: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/enrichments/status without auth returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/enrichments/status`);
    expect(res.status).toBe(401);
  });
});
