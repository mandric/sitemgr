/**
 * Integration tests for the encrypt → store → retrieve → decrypt lifecycle.
 *
 * Unlike s3-actions.test.ts, these tests use REAL encryption (not mocked)
 * so we can verify the full roundtrip through getBucketConfig.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Anthropic SDK (required by core.ts import)
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn() };
  },
}));

// Mock Supabase — we control what the DB "stores" and "returns"
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

// Mock S3 — not the focus here, but needed for testBucket to complete
const mockS3Send = vi.fn();
vi.mock("@/lib/media/s3", () => ({
  createS3Client: () => ({ send: mockS3Send }),
  listS3Objects: vi.fn(),
  downloadS3Object: vi.fn(),
}));

// NOTE: encryption is NOT mocked — we use the real implementation
vi.mock("@/lib/media/enrichment", () => ({
  enrichImage: vi.fn().mockResolvedValue({}),
}));

import { executeAction } from "@/lib/agent/core";

const PHONE = "+1234567890";
const TEST_KEY = "integration-test-encryption-key";

describe("encryption lifecycle (real crypto, mocked DB)", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    mockFrom.mockReset();
    mockS3Send.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("addBucket encrypts → getBucketConfig decrypts → original secret recovered", async () => {
    const originalSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    // Capture what addBucket inserts into the DB
    let storedRow: Record<string, unknown> | null = null;
    const mockSelect = vi.fn().mockReturnValue({
      single: () =>
        Promise.resolve({
          data: { id: "cfg-1", bucket_name: "test-bucket" },
          error: null,
        }),
    });
    mockFrom.mockReturnValue({
      insert: vi.fn((row: Record<string, unknown>) => {
        storedRow = row;
        return { select: mockSelect };
      }),
    });

    // Step 1: addBucket encrypts the secret
    const addResult = await executeAction(
      {
        action: "add_bucket",
        params: {
          bucket_name: "test-bucket",
          endpoint_url: "https://s3.example.com",
          access_key_id: "AKIAIOSFODNN7EXAMPLE",
          secret_access_key: originalSecret,
        },
      },
      PHONE
    );
    expect(JSON.parse(addResult).success).toBe(true);

    // Verify the stored secret is encrypted (not plaintext)
    expect(storedRow).not.toBeNull();
    expect(storedRow!.secret_access_key).not.toBe(originalSecret);
    expect(typeof storedRow!.secret_access_key).toBe("string");

    // Step 2: Simulate DB returning the encrypted row for getBucketConfig
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  id: "cfg-1",
                  phone_number: PHONE,
                  bucket_name: "test-bucket",
                  endpoint_url: "https://s3.example.com",
                  region: "us-east-1",
                  access_key_id: "AKIAIOSFODNN7EXAMPLE",
                  secret_access_key: storedRow!.secret_access_key,
                },
                error: null,
              }),
          }),
        }),
      }),
    });

    // testBucket calls getBucketConfig which decrypts, then uses the secret
    mockS3Send.mockResolvedValue({ KeyCount: 1 });

    const testResult = await executeAction(
      { action: "test_bucket", params: { bucket_name: "test-bucket" } },
      PHONE
    );
    const parsed = JSON.parse(testResult);

    // If decryption failed, we'd get an error instead of success
    expect(parsed.success).toBe(true);
  });

  it("returns error when ENCRYPTION_KEY changes between encrypt and decrypt", async () => {
    const originalSecret = "my-secret-key-12345";

    // Step 1: Encrypt with original key
    let storedRow: Record<string, unknown> | null = null;
    const mockSelect = vi.fn().mockReturnValue({
      single: () =>
        Promise.resolve({
          data: { id: "cfg-1", bucket_name: "test-bucket" },
          error: null,
        }),
    });
    mockFrom.mockReturnValue({
      insert: vi.fn((row: Record<string, unknown>) => {
        storedRow = row;
        return { select: mockSelect };
      }),
    });

    await executeAction(
      {
        action: "add_bucket",
        params: {
          bucket_name: "test-bucket",
          endpoint_url: "https://s3.example.com",
          access_key_id: "AKID",
          secret_access_key: originalSecret,
        },
      },
      PHONE
    );
    expect(storedRow).not.toBeNull();

    // Step 2: Change the encryption key (simulating key rotation or misconfiguration)
    vi.stubEnv("ENCRYPTION_KEY", "completely-different-key");

    // Step 3: Try to retrieve — decryption should fail
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  id: "cfg-1",
                  phone_number: PHONE,
                  bucket_name: "test-bucket",
                  endpoint_url: "https://s3.example.com",
                  region: null,
                  access_key_id: "AKID",
                  secret_access_key: storedRow!.secret_access_key,
                },
                error: null,
              }),
          }),
        }),
      }),
    });

    const result = await executeAction(
      { action: "test_bucket", params: { bucket_name: "test-bucket" } },
      PHONE
    );
    const parsed = JSON.parse(result);

    // Should get an error, not success
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("ENCRYPTION_KEY may have changed");
  });
});
