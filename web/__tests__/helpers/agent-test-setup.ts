/**
 * Shared mock setup for tests that import from @/lib/agent/core.
 *
 * Usage:
 *   import { mockFrom, mockS3Send, mockBucketLookup, mockBucketInsert, mockBucketDelete } from "./helpers/agent-test-setup";
 *
 * vi.mock() calls must live at the top level of the test file (vitest hoists them),
 * so this module only exports the mock references and helper functions.
 * Each test file still needs its own vi.mock() blocks that wire up these references.
 */
import { vi } from "vitest";

// ── Mock references (wired up by vi.mock() in each test file) ──

export const mockFrom = vi.fn();
export const mockS3Send = vi.fn();

// ── Supabase chain helpers ──────────────────────────────────────

/** Mock a `select → eq → eq → maybeSingle` chain (used by getBucketConfig). */
export function mockBucketLookup(config: Record<string, unknown> | null) {
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

/** Mock an `insert → select → single` chain (used by addBucket). Returns the mock insert fn for assertions. */
export function mockBucketInsert(
  responseData: Record<string, unknown>,
  error: Record<string, unknown> | null = null,
) {
  const mockSelect = vi.fn().mockReturnValue({
    single: () => Promise.resolve({ data: responseData, error }),
  });
  const mockInsert = vi.fn().mockReturnValue({ select: mockSelect });
  mockFrom.mockReturnValue({ insert: mockInsert });
  return mockInsert;
}

/**
 * Mock an `insert` chain that captures the inserted row (used by lifecycle tests).
 * Returns a ref object whose `.row` property is set when insert is called.
 */
export function mockBucketInsertCapture(responseData: Record<string, unknown>) {
  const ref = { row: null as Record<string, unknown> | null };
  const mockSelect = vi.fn().mockReturnValue({
    single: () => Promise.resolve({ data: responseData, error: null }),
  });
  mockFrom.mockReturnValue({
    insert: vi.fn((row: Record<string, unknown>) => {
      ref.row = row;
      return { select: mockSelect };
    }),
  });
  return ref;
}

/** Mock a `delete → eq → eq` chain (used by removeBucket). */
export function mockBucketDelete(error: Record<string, unknown> | null = null) {
  mockFrom.mockReturnValue({
    delete: () => ({
      eq: () => ({
        eq: () => Promise.resolve({ error }),
      }),
    }),
  });
}

// ── Shared test constants ───────────────────────────────────────

export const PHONE = "+1234567890";

export const fakeBucketConfig = {
  id: "cfg-1",
  phone_number: PHONE,
  bucket_name: "my-bucket",
  endpoint_url: "https://s3.example.com",
  region: "us-east-1",
  access_key_id: "AKID",
  secret_access_key: "encrypted-secret",
};
