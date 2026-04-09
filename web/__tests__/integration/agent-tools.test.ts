/**
 * Integration tests for the web agent tool dispatch (`lib/agent/tools.ts`).
 *
 * Exercises executeTool against real local Supabase with seeded events
 * and enrichments. Verifies that the tools:
 *   - return live data scoped to the authenticated user (tenant isolation)
 *   - surface well-formed JSON payloads that Claude can parse as tool_result
 *   - handle validation and not-found cases without throwing
 *
 * These tests do NOT call the Anthropic API — that's covered by the E2E
 * agent spec. Here we focus on the backend layer the agent depends on.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { executeTool } from "../../lib/agent/tools";
import {
  createTestUser,
  cleanupUserData,
  getAdminClient,
  seedUserData,
} from "./setup";

describe("web agent tools", () => {
  const admin = getAdminClient();
  let userA: Awaited<ReturnType<typeof createTestUser>>;
  let userB: Awaited<ReturnType<typeof createTestUser>>;
  let seedA: Awaited<ReturnType<typeof seedUserData>>;

  beforeAll(async () => {
    userA = await createTestUser();
    userB = await createTestUser();

    seedA = await seedUserData(admin, userA.userId, {
      eventCount: 3,
      withEnrichments: true,
      withBucketConfig: false,
      withConversation: false,
      withUserProfile: false,
    });

    // User B gets one event with no enrichment — used to verify tenant isolation.
    await seedUserData(admin, userB.userId, {
      eventCount: 1,
      withEnrichments: false,
      withBucketConfig: false,
      withConversation: false,
      withUserProfile: false,
    });
  });

  afterAll(async () => {
    await cleanupUserData(admin, userA.userId);
    await cleanupUserData(admin, userB.userId);
  });

  describe("get_stats", () => {
    it("returns live counts for the authenticated user", async () => {
      const result = await executeTool(
        "get_stats",
        {},
        { client: userA.client, userId: userA.userId },
      );
      const parsed = JSON.parse(result);

      expect(parsed.error).toBeUndefined();
      expect(parsed.total_events).toBe(3);
      expect(parsed.enriched).toBe(3);
      expect(parsed.by_content_type).toBeDefined();
    });

    it("scopes counts to the user (tenant isolation)", async () => {
      const result = await executeTool(
        "get_stats",
        {},
        { client: userB.client, userId: userB.userId },
      );
      const parsed = JSON.parse(result);

      expect(parsed.total_events).toBe(1);
      expect(parsed.enriched).toBe(0);
    });
  });

  describe("query_media", () => {
    it("returns all media events when no filters are provided", async () => {
      const result = await executeTool(
        "query_media",
        {},
        { client: userA.client, userId: userA.userId },
      );
      const parsed = JSON.parse(result);

      expect(parsed.error).toBeUndefined();
      expect(Array.isArray(parsed.results)).toBe(true);
      expect(parsed.results.length).toBe(3);
    });

    it("respects the limit parameter", async () => {
      const result = await executeTool(
        "query_media",
        { limit: 2 },
        { client: userA.client, userId: userA.userId },
      );
      const parsed = JSON.parse(result);

      expect(parsed.results.length).toBe(2);
    });

    it("searches enrichment text via full-text search", async () => {
      // Seeded enrichments have description "Test enrichment for <id>".
      const result = await executeTool(
        "query_media",
        { search: "enrichment" },
        { client: userA.client, userId: userA.userId },
      );
      const parsed = JSON.parse(result);

      expect(parsed.error).toBeUndefined();
      expect(Array.isArray(parsed.results)).toBe(true);
      expect(parsed.results.length).toBeGreaterThan(0);
    });

    it("isolates results between users", async () => {
      const result = await executeTool(
        "query_media",
        {},
        { client: userB.client, userId: userB.userId },
      );
      const parsed = JSON.parse(result);

      expect(parsed.results.length).toBe(1);
      for (const row of parsed.results) {
        expect(row.user_id).toBe(userB.userId);
      }
    });
  });

  describe("show_media", () => {
    it("returns full event details including enrichment", async () => {
      const eventId = seedA.eventIds[0];
      const result = await executeTool(
        "show_media",
        { id: eventId },
        { client: userA.client, userId: userA.userId },
      );
      const parsed = JSON.parse(result);

      expect(parsed.error).toBeUndefined();
      expect(parsed.id).toBe(eventId);
      expect(parsed.user_id).toBe(userA.userId);
      expect(parsed.enrichment).toBeDefined();
      expect(parsed.enrichment.description).toContain("Test enrichment");
    });

    it("returns a validation error when id is missing", async () => {
      const result = await executeTool(
        "show_media",
        {},
        { client: userA.client, userId: userA.userId },
      );
      const parsed = JSON.parse(result);

      expect(parsed.error).toBe("id is required");
    });

    it("returns not-found for another user's event (tenant isolation)", async () => {
      const foreignEventId = seedA.eventIds[0];
      const result = await executeTool(
        "show_media",
        { id: foreignEventId },
        { client: userB.client, userId: userB.userId },
      );
      const parsed = JSON.parse(result);

      expect(parsed.error).toBe("Media item not found");
    });
  });

  describe("unknown tool", () => {
    it("returns an error string rather than throwing", async () => {
      const result = await executeTool(
        "nonexistent_tool",
        {},
        { client: userA.client, userId: userA.userId },
      );
      const parsed = JSON.parse(result);

      expect(parsed.error).toContain("Unknown tool");
    });
  });
});
