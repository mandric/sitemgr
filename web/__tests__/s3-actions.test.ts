import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Anthropic SDK (required by core.ts import)
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn() };
  },
}));

// Mock Supabase
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockMaybeSingle = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/media/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/media/db")>();
  return {
    ...actual,
    getSupabaseClient: () => ({ from: mockFrom }),
    getWatchedKeys: vi.fn().mockResolvedValue(new Set()),
    insertEvent: vi.fn().mockResolvedValue(undefined),
    insertEnrichment: vi.fn().mockResolvedValue(undefined),
    upsertWatchedKey: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock S3
const mockS3Send = vi.fn();
vi.mock("@/lib/media/s3", () => ({
  createS3Client: () => ({ send: mockS3Send }),
  listS3Objects: vi.fn(),
  downloadS3Object: vi.fn(),
}));

// Mock encryption
vi.mock("@/lib/crypto/encryption", () => ({
  encryptSecret: vi.fn().mockResolvedValue("encrypted"),
  decryptSecret: vi.fn().mockResolvedValue("decrypted-secret"),
}));

// Mock enrichment
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

import { executeAction } from "@/lib/agent/core";
import { listS3Objects, downloadS3Object } from "@/lib/media/s3";
import { getWatchedKeys, insertEvent, upsertWatchedKey, insertEnrichment } from "@/lib/media/db";

const PHONE = "+1234567890";

const fakeBucketConfig = {
  id: "cfg-1",
  phone_number: PHONE,
  bucket_name: "my-bucket",
  endpoint_url: "https://s3.example.com",
  region: "us-east-1",
  access_key_id: "AKID",
  secret_access_key: "encrypted-secret",
};

function mockBucketLookup(config: typeof fakeBucketConfig | null) {
  mockFrom.mockReturnValue({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: config, error: null }),
        }),
      }),
    }),
  });
}

describe("S3 action handlers", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY", "test-key");
    mockFrom.mockReset();
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

  describe("test_bucket", () => {
    it("returns error when bucket_name is missing", async () => {
      const result = await executeAction(
        { action: "test_bucket", params: {} },
        PHONE
      );
      expect(JSON.parse(result)).toEqual({ error: "bucket_name is required" });
    });

    it("returns error when bucket config not found", async () => {
      mockBucketLookup(null);
      const result = await executeAction(
        { action: "test_bucket", params: { bucket_name: "nonexistent" } },
        PHONE
      );
      expect(JSON.parse(result)).toEqual({
        error: 'Bucket "nonexistent" not found',
      });
    });

    it("returns success when S3 list works", async () => {
      mockBucketLookup(fakeBucketConfig);
      mockS3Send.mockResolvedValue({ KeyCount: 5 });

      const result = await executeAction(
        { action: "test_bucket", params: { bucket_name: "my-bucket" } },
        PHONE
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
        PHONE
      );
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
    });

    it("returns failure on access error", async () => {
      mockBucketLookup(fakeBucketConfig);
      mockS3Send.mockRejectedValue(new Error("Access Denied"));

      const result = await executeAction(
        { action: "test_bucket", params: { bucket_name: "my-bucket" } },
        PHONE
      );
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Access Denied");
    });
  });

  describe("list_objects", () => {
    it("lists objects from bucket", async () => {
      mockBucketLookup(fakeBucketConfig);
      vi.mocked(listS3Objects).mockResolvedValue([
        { key: "photo1.jpg", size: 1024, etag: "abc", lastModified: "2026-01-01" },
        { key: "photo2.jpg", size: 2048, etag: "def", lastModified: "2026-01-02" },
      ]);

      const result = await executeAction(
        { action: "list_objects", params: { bucket_name: "my-bucket", limit: 10 } },
        PHONE
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
        { action: "list_objects", params: { bucket_name: "my-bucket", limit: 5 } },
        PHONE
      );
      const parsed = JSON.parse(result);
      expect(parsed.returned).toBe(5);
      expect(parsed.total).toBe(20);
    });
  });

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
        PHONE
      );
      const parsed = JSON.parse(result);
      expect(parsed.total).toBe(4);
      expect(parsed.by_type.photo).toBe(2);
      expect(parsed.by_type.video).toBe(1);
    });
  });

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
        { action: "index_bucket", params: { bucket_name: "my-bucket", batch_size: 10 } },
        PHONE
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
        { action: "index_bucket", params: { bucket_name: "my-bucket", batch_size: 5 } },
        PHONE
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
        { action: "index_bucket", params: { bucket_name: "my-bucket", batch_size: 10 } },
        PHONE
      );
      const parsed = JSON.parse(result);
      expect(parsed.batch_indexed).toBe(1);
      expect(parsed.batch_enriched).toBe(1);
      expect(vi.mocked(insertEnrichment)).toHaveBeenCalled();
    });
  });
});
