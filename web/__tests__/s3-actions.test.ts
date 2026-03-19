import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mockFrom,
  mockS3Send,
  mockBucketLookup,
  mockBucketInsert,
  mockBucketDelete,
  mockWithUserResolution,
  PHONE,
  fakeBucketConfig,
} from "./helpers/agent-test-setup";

// ── vi.mock() blocks (hoisted by vitest) ────────────────────────

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn() };
  },
}));

vi.mock("@/lib/media/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/media/db")>();
  return {
    ...actual,
    getAdminClient: () => ({ from: mockFrom }),
    getUserClient: () => ({ from: mockFrom }),
    getWatchedKeys: vi.fn().mockResolvedValue(new Set()),
    insertEvent: vi.fn().mockResolvedValue(undefined),
    insertEnrichment: vi.fn().mockResolvedValue(undefined),
    upsertWatchedKey: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/media/s3", () => ({
  createS3Client: () => ({ send: mockS3Send }),
  listS3Objects: vi.fn(),
  downloadS3Object: vi.fn(),
}));

vi.mock("@/lib/crypto/encryption", () => ({
  encryptSecret: vi.fn().mockResolvedValue("encrypted"),
  decryptSecret: vi.fn().mockResolvedValue("decrypted-secret"),
}));

vi.mock("@/lib/crypto/encryption-versioned", () => ({
  encryptSecretVersioned: vi.fn().mockResolvedValue("v2:encrypted"),
  decryptSecretVersioned: vi.fn().mockResolvedValue("decrypted-secret"),
  getEncryptionVersion: vi.fn().mockReturnValue(2),
  needsMigration: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/media/enrichment", () => ({
  enrichImage: vi.fn().mockResolvedValue({
    description: "A test image",
    objects: ["test"],
    context: "testing",
    suggested_tags: ["test"],
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    raw_response: "{}",
  }),
}));

// ── Imports (after mocks) ───────────────────────────────────────

import { executeAction } from "@/lib/agent/core";
import {
  encryptSecretVersioned,
  decryptSecretVersioned,
} from "@/lib/crypto/encryption-versioned";
import { listS3Objects, downloadS3Object } from "@/lib/media/s3";
import {
  getWatchedKeys,
  insertEvent,
  upsertWatchedKey,
  insertEnrichment,
} from "@/lib/media/db";

// ── Tests ───────────────────────────────────────────────────────

describe("S3 action handlers", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY", "test-key");
    mockFrom.mockReset();
    // Default: resolve user_profiles lookups, return empty chain for other tables
    mockWithUserResolution({});
    mockS3Send.mockReset();
    vi.mocked(listS3Objects).mockReset();
    vi.mocked(downloadS3Object).mockReset();
    vi.mocked(getWatchedKeys).mockReset().mockResolvedValue(new Set());
    vi.mocked(insertEvent).mockReset().mockResolvedValue(undefined);
    vi.mocked(insertEnrichment).mockReset().mockResolvedValue(undefined);
    vi.mocked(upsertWatchedKey).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── test_bucket ─────────────────────────────────────────────

  describe("test_bucket", () => {
    it("returns error when bucket_name is missing", async () => {
      const result = await executeAction(
        { action: "test_bucket", params: {} },
        PHONE,
      );
      expect(JSON.parse(result)).toEqual({ error: "bucket_name is required", errorType: "validation_error" });
    });

    it("returns error when bucket config not found", async () => {
      mockBucketLookup(null);
      const result = await executeAction(
        { action: "test_bucket", params: { bucket_name: "nonexistent" } },
        PHONE,
      );
      expect(JSON.parse(result)).toEqual({
        error: 'Bucket "nonexistent" not found',
        errorType: "not_found",
      });
    });

    it("returns success when S3 list works", async () => {
      mockBucketLookup(fakeBucketConfig);
      mockS3Send.mockResolvedValue({ KeyCount: 5 });

      const result = await executeAction(
        { action: "test_bucket", params: { bucket_name: "my-bucket" } },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.has_objects).toBe(true);
    });

    it("falls back to v1 when v2 fails", async () => {
      mockBucketLookup(fakeBucketConfig);
      mockS3Send
        .mockRejectedValueOnce(new Error("not implemented"))
        .mockResolvedValueOnce({ Contents: [{ Key: "test.jpg" }] });

      const result = await executeAction(
        { action: "test_bucket", params: { bucket_name: "my-bucket" } },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
    });

    it("returns failure on access error", async () => {
      mockBucketLookup(fakeBucketConfig);
      mockS3Send.mockRejectedValue(new Error("Access Denied"));

      const result = await executeAction(
        { action: "test_bucket", params: { bucket_name: "my-bucket" } },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Access Denied");
    });
  });

  // ── list_objects ────────────────────────────────────────────

  describe("list_objects", () => {
    it("lists objects from bucket", async () => {
      mockBucketLookup(fakeBucketConfig);
      vi.mocked(listS3Objects).mockResolvedValue([
        {
          key: "photo1.jpg",
          size: 1024,
          etag: "abc",
          lastModified: "2026-01-01",
        },
        {
          key: "photo2.jpg",
          size: 2048,
          etag: "def",
          lastModified: "2026-01-02",
        },
      ]);

      const result = await executeAction(
        {
          action: "list_objects",
          params: { bucket_name: "my-bucket", limit: 10 },
        },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.returned).toBe(2);
      expect(parsed.total).toBe(2);
      expect(parsed.objects).toHaveLength(2);
    });

    it("respects limit parameter", async () => {
      mockBucketLookup(fakeBucketConfig);
      const objects = Array.from({ length: 20 }, (_, i) => ({
        key: `file${i}.jpg`,
        size: 1024,
        etag: `etag${i}`,
        lastModified: "2026-01-01",
      }));
      vi.mocked(listS3Objects).mockResolvedValue(objects);

      const result = await executeAction(
        {
          action: "list_objects",
          params: { bucket_name: "my-bucket", limit: 5 },
        },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.returned).toBe(5);
      expect(parsed.total).toBe(20);
    });
  });

  // ── count_objects ───────────────────────────────────────────

  describe("count_objects", () => {
    it("counts objects grouped by type", async () => {
      mockBucketLookup(fakeBucketConfig);
      vi.mocked(listS3Objects).mockResolvedValue([
        { key: "photo.jpg", size: 1024, etag: "a", lastModified: "" },
        { key: "video.mp4", size: 2048, etag: "b", lastModified: "" },
        { key: "doc.pdf", size: 512, etag: "c", lastModified: "" },
        { key: "photo2.png", size: 1024, etag: "d", lastModified: "" },
      ]);

      const result = await executeAction(
        { action: "count_objects", params: { bucket_name: "my-bucket" } },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.total).toBe(4);
      expect(parsed.by_type.photo).toBe(2);
      expect(parsed.by_type.video).toBe(1);
    });
  });

  // ── add_bucket ──────────────────────────────────────────────

  describe("add_bucket", () => {
    it("returns error when required fields are missing", async () => {
      const result = await executeAction(
        { action: "add_bucket", params: { bucket_name: "b" } },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("Missing required fields");
    });

    it("encrypts secret and inserts config", async () => {
      const mockInsert = mockBucketInsert({
        id: "new-id",
        bucket_name: "my-bucket",
      });

      const result = await executeAction(
        {
          action: "add_bucket",
          params: {
            bucket_name: "my-bucket",
            endpoint_url: "https://s3.example.com",
            access_key_id: "AKID",
            secret_access_key: "my-secret",
          },
        },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.bucket.bucket_name).toBe("my-bucket");

      expect(encryptSecretVersioned).toHaveBeenCalledWith("my-secret");

      const insertedRow = mockInsert.mock.calls[0][0];
      expect(insertedRow.secret_access_key).toBe("v2:encrypted");
      expect(insertedRow.encryption_key_version).toBe(2);
      expect(insertedRow.user_id).toBe("test-user-uuid");
    });

    it("returns error on duplicate bucket", async () => {
      mockBucketInsert(null as unknown as Record<string, unknown>, {
        code: "23505",
        message: "unique violation",
      });

      const result = await executeAction(
        {
          action: "add_bucket",
          params: {
            bucket_name: "dup-bucket",
            endpoint_url: "https://s3.example.com",
            access_key_id: "AKID",
            secret_access_key: "secret",
          },
        },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("already configured");
    });
  });

  // ── remove_bucket ───────────────────────────────────────────

  describe("remove_bucket", () => {
    it("returns error when bucket_name is missing", async () => {
      const result = await executeAction(
        { action: "remove_bucket", params: {} },
        PHONE,
      );
      expect(JSON.parse(result)).toEqual({ error: "bucket_name is required", errorType: "validation_error" });
    });

    it("deletes bucket config and returns success", async () => {
      mockBucketDelete();

      const result = await executeAction(
        { action: "remove_bucket", params: { bucket_name: "my-bucket" } },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain("my-bucket");
    });

    it("returns error on database failure", async () => {
      mockBucketDelete({ message: "connection lost" });

      const result = await executeAction(
        { action: "remove_bucket", params: { bucket_name: "my-bucket" } },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toBe("Failed to remove bucket");
    });
  });

  // ── getBucketConfig error discrimination ────────────────────

  describe("getBucketConfig error discrimination", () => {
    it("returns not-found error when bucket does not exist", async () => {
      mockBucketLookup(null);
      const result = await executeAction(
        { action: "test_bucket", params: { bucket_name: "ghost" } },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("not found");
    });

    it("returns decrypt error when decryption fails", async () => {
      mockBucketLookup(fakeBucketConfig);
      vi.mocked(decryptSecretVersioned).mockRejectedValueOnce(
        new Error(
          "Failed to decrypt secret with version 2 key. The ENCRYPTION_KEY_CURRENT may be incorrect.",
        ),
      );

      const result = await executeAction(
        { action: "test_bucket", params: { bucket_name: "my-bucket" } },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });
  });

  // ── index_bucket ────────────────────────────────────────────

  describe("index_bucket", () => {
    it("indexes new objects and skips already-watched keys", async () => {
      mockBucketLookup(fakeBucketConfig);
      vi.mocked(listS3Objects).mockResolvedValue([
        { key: "old.jpg", size: 1024, etag: "old", lastModified: "" },
        { key: "new.jpg", size: 2048, etag: "new", lastModified: "" },
        { key: "new2.txt", size: 512, etag: "new2", lastModified: "" },
      ]);
      vi.mocked(getWatchedKeys).mockResolvedValue(new Set(["old.jpg"]));

      const result = await executeAction(
        {
          action: "index_bucket",
          params: { bucket_name: "my-bucket", batch_size: 10 },
        },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.total_objects).toBe(3);
      expect(parsed.already_indexed).toBe(1);
      expect(parsed.batch_indexed).toBe(2);
      expect(parsed.remaining).toBe(0);
    });

    it("respects batch_size limit", async () => {
      mockBucketLookup(fakeBucketConfig);
      const objects = Array.from({ length: 20 }, (_, i) => ({
        key: `file${i}.txt`,
        size: 100,
        etag: `e${i}`,
        lastModified: "",
      }));
      vi.mocked(listS3Objects).mockResolvedValue(objects);
      vi.mocked(getWatchedKeys).mockResolvedValue(new Set());

      const result = await executeAction(
        {
          action: "index_bucket",
          params: { bucket_name: "my-bucket", batch_size: 5 },
        },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.batch_indexed).toBe(5);
      expect(parsed.remaining).toBe(15);
    });

    it("enriches image files during indexing", async () => {
      mockBucketLookup(fakeBucketConfig);
      vi.mocked(listS3Objects).mockResolvedValue([
        { key: "photo.jpeg", size: 1024, etag: "abc", lastModified: "" },
      ]);
      vi.mocked(getWatchedKeys).mockResolvedValue(new Set());
      vi.mocked(downloadS3Object).mockResolvedValue(Buffer.from("fake-image"));

      const result = await executeAction(
        {
          action: "index_bucket",
          params: { bucket_name: "my-bucket", batch_size: 10 },
        },
        PHONE,
      );
      const parsed = JSON.parse(result);
      expect(parsed.batch_indexed).toBe(1);
      expect(parsed.batch_enriched).toBe(1);
      expect(vi.mocked(insertEnrichment)).toHaveBeenCalled();
    });
  });
});
