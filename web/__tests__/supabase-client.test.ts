import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn().mockReturnValue({ from: vi.fn() }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

import { getAdminClient, getUserClient } from "@/lib/media/db";

describe("Supabase client constructors", () => {
  const TEST_URL = "https://test.supabase.co";
  const TEST_SECRET_KEY = "secret-service-role-key";
  const TEST_API_KEY = "publishable-anon-key";

  beforeEach(() => {
    mockCreateClient.mockClear();
    vi.stubEnv("SMGR_API_URL", TEST_URL);
    vi.stubEnv("SMGR_API_KEY", TEST_API_KEY);
    vi.stubEnv("SUPABASE_SECRET_KEY", TEST_SECRET_KEY);
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

    it("throws if SMGR_API_URL is not set", () => {
      vi.stubEnv("SMGR_API_URL", "");
      expect(() => getAdminClient()).toThrow("SMGR_API_URL");
    });
  });

  describe("getUserClient()", () => {
    it("uses SMGR_API_KEY (anon/publishable key)", () => {
      getUserClient();
      expect(mockCreateClient).toHaveBeenCalledWith(TEST_URL, TEST_API_KEY);
    });

    it("does NOT use SUPABASE_SECRET_KEY even if available", () => {
      getUserClient();
      const passedKey = mockCreateClient.mock.calls[0][1];
      expect(passedKey).not.toBe(TEST_SECRET_KEY);
      expect(passedKey).toBe(TEST_API_KEY);
    });

    it("throws if SMGR_API_KEY is not set", () => {
      vi.stubEnv("SMGR_API_KEY", "");
      expect(() => getUserClient()).toThrow("SMGR_API_KEY");
    });

    it("throws if SMGR_API_URL is not set", () => {
      vi.stubEnv("SMGR_API_URL", "");
      expect(() => getUserClient()).toThrow("SMGR_API_URL");
    });
  });

  describe("both clients", () => {
    it("use SMGR_API_URL for the URL", () => {
      getAdminClient();
      getUserClient();
      expect(mockCreateClient.mock.calls[0][0]).toBe(TEST_URL);
      expect(mockCreateClient.mock.calls[1][0]).toBe(TEST_URL);
    });
  });
});
