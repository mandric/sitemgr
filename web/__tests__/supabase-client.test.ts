import { describe, it, expect, vi, beforeEach } from "vitest";

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
  const TEST_ANON_KEY = "publishable-anon-key";

  beforeEach(() => {
    mockCreateClient.mockClear();
  });

  describe("getAdminClient(config)", () => {
    it("creates client with provided url and serviceKey", () => {
      getAdminClient({ url: TEST_URL, serviceKey: TEST_SECRET_KEY });
      expect(mockCreateClient).toHaveBeenCalledWith(TEST_URL, TEST_SECRET_KEY);
    });

    it("throws when config is missing serviceKey", () => {
      expect(() => getAdminClient({ url: TEST_URL, serviceKey: "" })).toThrow("serviceKey");
    });

    it("throws when config is missing url", () => {
      expect(() => getAdminClient({ url: "", serviceKey: TEST_SECRET_KEY })).toThrow("url");
    });
  });

  describe("getUserClient(config)", () => {
    it("creates client with provided url and anonKey", () => {
      getUserClient({ url: TEST_URL, anonKey: TEST_ANON_KEY });
      expect(mockCreateClient).toHaveBeenCalledWith(TEST_URL, TEST_ANON_KEY);
    });

    it("does NOT use serviceKey even if a different key is passed", () => {
      getUserClient({ url: TEST_URL, anonKey: TEST_ANON_KEY });
      const passedKey = mockCreateClient.mock.calls[0][1];
      expect(passedKey).not.toBe(TEST_SECRET_KEY);
      expect(passedKey).toBe(TEST_ANON_KEY);
    });

    it("throws when config is missing anonKey", () => {
      expect(() => getUserClient({ url: TEST_URL, anonKey: "" })).toThrow("anonKey");
    });

    it("throws when config is missing url", () => {
      expect(() => getUserClient({ url: "", anonKey: TEST_ANON_KEY })).toThrow("url");
    });
  });

  describe("both clients", () => {
    it("use the provided URL", () => {
      getAdminClient({ url: TEST_URL, serviceKey: TEST_SECRET_KEY });
      getUserClient({ url: TEST_URL, anonKey: TEST_ANON_KEY });
      expect(mockCreateClient.mock.calls[0][0]).toBe(TEST_URL);
      expect(mockCreateClient.mock.calls[1][0]).toBe(TEST_URL);
    });
  });
});
