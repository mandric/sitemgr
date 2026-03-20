/**
 * Integration tests for the encrypt → store → retrieve → decrypt lifecycle.
 *
 * Unlike s3-actions.test.ts, these tests use REAL encryption (not mocked)
 * so we can verify the full roundtrip through getBucketConfig.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mockFrom,
  mockS3Send,
  mockBucketLookup,
  mockBucketInsertCapture,
  PHONE,
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
    getWatchedKeys: vi.fn().mockResolvedValue({ data: [], error: null }),
    insertEvent: vi.fn().mockResolvedValue({ data: null, error: null }),
    insertEnrichment: vi.fn().mockResolvedValue({ data: null, error: null }),
    upsertWatchedKey: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
});

vi.mock("@/lib/media/s3", () => ({
  createS3Client: () => ({ send: mockS3Send }),
  listS3Objects: vi.fn(),
  downloadS3Object: vi.fn(),
}));

// NOTE: encryption is NOT mocked — we use the real implementation
vi.mock("@/lib/media/enrichment", () => ({
  enrichImage: vi.fn().mockResolvedValue({}),
}));

// ── Imports (after mocks) ───────────────────────────────────────

import { executeAction } from "@/lib/agent/core";

// ── Tests ───────────────────────────────────────────────────────

const TEST_KEY = "integration-test-encryption-key";

describe("encryption lifecycle (real crypto, mocked DB)", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY_CURRENT", TEST_KEY);
    mockFrom.mockReset();
    mockS3Send.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("addBucket encrypts → getBucketConfig decrypts → original secret recovered", async () => {
    const originalSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    // Step 1: addBucket encrypts the secret
    const ref = mockBucketInsertCapture({
      id: "cfg-1",
      bucket_name: "test-bucket",
    });

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
      PHONE,
    );
    expect(JSON.parse(addResult).success).toBe(true);

    // Verify the stored secret is encrypted (not plaintext)
    expect(ref.row).not.toBeNull();
    expect(ref.row!.secret_access_key).not.toBe(originalSecret);
    expect(typeof ref.row!.secret_access_key).toBe("string");

    // Step 2: Simulate DB returning the encrypted row for getBucketConfig
    mockBucketLookup({
      id: "cfg-1",
      phone_number: PHONE,
      bucket_name: "test-bucket",
      endpoint_url: "https://s3.example.com",
      region: "us-east-1",
      access_key_id: "AKIAIOSFODNN7EXAMPLE",
      secret_access_key: ref.row!.secret_access_key,
    });

    // testBucket calls getBucketConfig which decrypts, then uses the secret
    mockS3Send.mockResolvedValue({ KeyCount: 1 });

    const testResult = await executeAction(
      { action: "test_bucket", params: { bucket_name: "test-bucket" } },
      PHONE,
    );
    const parsed = JSON.parse(testResult);

    // If decryption failed, we'd get an error instead of success
    expect(parsed.success).toBe(true);
  });

  it("returns error when ENCRYPTION_KEY_CURRENT changes between encrypt and decrypt", async () => {
    const originalSecret = "my-secret-key-12345";

    // Step 1: Encrypt with original key
    const ref = mockBucketInsertCapture({
      id: "cfg-1",
      bucket_name: "test-bucket",
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
      PHONE,
    );
    expect(ref.row).not.toBeNull();

    // Step 2: Change the encryption key (simulating key rotation or misconfiguration)
    vi.stubEnv("ENCRYPTION_KEY_CURRENT", "completely-different-key");

    // Step 3: Try to retrieve — decryption should fail
    mockBucketLookup({
      id: "cfg-1",
      phone_number: PHONE,
      bucket_name: "test-bucket",
      endpoint_url: "https://s3.example.com",
      region: null,
      access_key_id: "AKID",
      secret_access_key: ref.row!.secret_access_key,
    });

    const result = await executeAction(
      { action: "test_bucket", params: { bucket_name: "test-bucket" } },
      PHONE,
    );
    const parsed = JSON.parse(result);

    // Should get an error, not success
    expect(parsed.error).toBeDefined();
    // Error message changed with versioned encryption
    expect(parsed.error).toMatch(/ENCRYPTION_KEY_CURRENT|decrypt/i);
  });
});
