import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreateClient = vi.fn().mockReturnValue({ from: vi.fn() });

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

import { getAdminClient, getUserClient } from "@/lib/media/db";

describe("Supabase client constructors", () => {
  const TEST_URL = "https://test.supabase.co";
  const TEST_SECRET_KEY = "secret-service-role-key";
  const TEST_PUBLISHABLE_KEY = "publishable-anon-key";

  beforeEach(() => {
    mockCreateClient.mockClear();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_URL);
    vi.stubEnv("SUPABASE_SECRET_KEY", TEST_SECRET_KEY);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getAdminClient()", () => {
    it("uses SUPABASE_SECRET_KEY (service role key)", () => {
      getAdminClient();
      expect(mockCreateClient).toHaveBeenCalledWith(TEST_URL, TEST_SECRET_KEY);
    });

    it("throws if SUPABASE_SECRET_KEY is not set", () => {
      vi.stubEnv("SUPABASE_SECRET_KEY", "");
      expect(() => getAdminClient()).toThrow("SUPABASE_SECRET_KEY");
    });

    it("throws if NEXT_PUBLIC_SUPABASE_URL is not set", () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
      expect(() => getAdminClient()).toThrow("NEXT_PUBLIC_SUPABASE_URL");
    });
  });

  describe("getUserClient()", () => {
    it("uses NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (anon/publishable key)", () => {
      getUserClient();
      expect(mockCreateClient).toHaveBeenCalledWith(
        TEST_URL,
        TEST_PUBLISHABLE_KEY,
      );
    });

    it("does NOT use SUPABASE_SECRET_KEY even if available", () => {
      getUserClient();
      const passedKey = mockCreateClient.mock.calls[0][1];
      expect(passedKey).not.toBe(TEST_SECRET_KEY);
      expect(passedKey).toBe(TEST_PUBLISHABLE_KEY);
    });

    it("throws if NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set", () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
      expect(() => getUserClient()).toThrow(
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      );
    });

    it("throws if NEXT_PUBLIC_SUPABASE_URL is not set", () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
      expect(() => getUserClient()).toThrow("NEXT_PUBLIC_SUPABASE_URL");
    });
  });

  describe("both clients", () => {
    it("use NEXT_PUBLIC_SUPABASE_URL for the URL", () => {
      getAdminClient();
      getUserClient();
      expect(mockCreateClient.mock.calls[0][0]).toBe(TEST_URL);
      expect(mockCreateClient.mock.calls[1][0]).toBe(TEST_URL);
    });
  });
});
