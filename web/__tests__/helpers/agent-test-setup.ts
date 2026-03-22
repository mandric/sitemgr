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
  const bucketChain = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: config, error: null }),
        }),
      }),
    }),
  };
  mockWithUserResolution(bucketChain);
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
  const bucketChain = { insert: mockInsert };
  mockWithUserResolution(bucketChain);
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
  const bucketChain = {
    insert: vi.fn((row: Record<string, unknown>) => {
      ref.row = row;
      return { select: mockSelect };
    }),
  };
  mockWithUserResolution(bucketChain);
  return ref;
}

/** Mock a `delete → eq → eq` chain (used by removeBucket). */
export function mockBucketDelete(error: Record<string, unknown> | null = null) {
  const bucketChain = {
    delete: () => ({
      eq: () => ({
        eq: () => Promise.resolve({ error }),
      }),
    }),
  };
  mockWithUserResolution(bucketChain);
}

// ── resolveUserId chain helper ──────────────────────────────────

/** Chain returned for user_profiles lookups (resolveUserId). */
const userProfilesChain = {
  select: () => ({
    eq: () => ({
      maybeSingle: () =>
        Promise.resolve({ data: { id: "test-user-uuid" }, error: null }),
    }),
  }),
};

/**
 * Wraps mockFrom to handle resolveUserId's user_profiles lookup transparently.
 * Call this in beforeEach after setting up the bucket mock chain.
 * It makes mockFrom dispatch by table name: "user_profiles" → resolveUserId chain,
 * anything else → the previously configured return value.
 */
export function mockWithUserResolution(bucketChain: Record<string, unknown>) {
  mockFrom.mockImplementation((table: string) => {
    if (table === "user_profiles") return userProfilesChain;
    return bucketChain;
  });
}

/** Create a mock SupabaseClient that delegates .from() to mockFrom. */
export function createMockClient() {
  return { from: (...args: unknown[]) => mockFrom(...(args as [string])) } as never;
}

// ── Shared test constants ───────────────────────────────────────

export const PHONE = "+1234567890";

export const fakeBucketConfig = {
  id: "cfg-1",
  phone_number: PHONE,
  user_id: "test-user-uuid",
  bucket_name: "my-bucket",
  endpoint_url: "https://s3.example.com",
  region: "us-east-1",
  access_key_id: "AKID",
  secret_access_key: "encrypted-secret",
};
