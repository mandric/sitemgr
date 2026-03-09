import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the agent core module
vi.mock("@/lib/agent/core", () => ({
  planAction: vi.fn(),
  executeAction: vi.fn(),
  summarizeResult: vi.fn(),
  getConversationHistory: vi.fn(),
  saveConversationHistory: vi.fn(),
}));

// Mock the media db module
const mockSelect = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ error: null }) });
const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
vi.mock("@/lib/media/db", () => ({
  getSupabaseClient: vi.fn(() => ({
    from: mockFrom,
  })),
}));

// Mock global fetch for Twilio calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { GET, POST } from "@/app/api/whatsapp/route";
import {
  planAction,
  executeAction,
  summarizeResult,
  getConversationHistory,
  saveConversationHistory,
} from "@/lib/agent/core";
import { NextRequest } from "next/server";

const mockPlan = vi.mocked(planAction);
const mockExecute = vi.mocked(executeAction);
const mockSummarize = vi.mocked(summarizeResult);
const mockGetHistory = vi.mocked(getConversationHistory);
const mockSaveHistory = vi.mocked(saveConversationHistory);

function makeRequest(body: Record<string, string>): NextRequest {
  const formBody = new URLSearchParams(body).toString();
  return new NextRequest("http://localhost/api/whatsapp", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody,
  });
}

describe("WhatsApp route", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_sid");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test_auth_token");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
    mockPlan.mockReset();
    mockExecute.mockReset();
    mockSummarize.mockReset();
    mockGetHistory.mockReset();
    mockSaveHistory.mockReset();
    mockFetch.mockReset();
    // Default Supabase mock chain
    mockSelect.mockReturnValue({ limit: vi.fn().mockResolvedValue({ error: null }) });
    mockFrom.mockReturnValue({ select: mockSelect });
    // Default Twilio response
    mockFetch.mockResolvedValue({ ok: true });
    // Default conversation history
    mockGetHistory.mockResolvedValue([]);
    mockSaveHistory.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("GET", () => {
    it("returns healthy status when all checks pass", async () => {
      const res = await GET();
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("smgr-whatsapp-bot");
      expect(json.timestamp).toBeDefined();
      expect(json.checks.env_vars).toBe("ok");
      expect(json.checks.supabase).toBe("ok");
    });

    it("returns degraded status when env vars are missing", async () => {
      vi.unstubAllEnvs();
      // Only set Supabase vars (needed for DB check) but omit webhook vars
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");

      const res = await GET();
      const json = await res.json();
      expect(res.status).toBe(503);
      expect(json.status).toBe("degraded");
      expect(json.checks.env_vars).toContain("missing:");
    });

    it("returns degraded status when Supabase connection fails", async () => {
      // Make the Supabase mock return an error
      mockSelect.mockReturnValueOnce({
        limit: vi.fn().mockResolvedValue({ error: { message: "Invalid API key" } }),
      });

      const res = await GET();
      const json = await res.json();
      expect(res.status).toBe(503);
      expect(json.status).toBe("degraded");
      expect(json.checks.supabase).toContain("Invalid API key");
    });
  });

  describe("POST", () => {
    it("processes direct action and sends response via Twilio", async () => {
      mockPlan.mockResolvedValue({ action: "direct", response: "Hello!" });

      const req = makeRequest({
        From: "whatsapp:+1234567890",
        Body: "hi",
      });

      const res = await POST(req);
      const text = await res.text();

      expect(text).toBe("<Response></Response>");
      expect(mockPlan).toHaveBeenCalledOnce();
      expect(mockExecute).not.toHaveBeenCalled();

      // Check Twilio was called
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain("api.twilio.com");
      expect(options.method).toBe("POST");
    });

    it("processes db action with plan/execute/summarize cycle", async () => {
      mockPlan.mockResolvedValue({ action: "stats" });
      mockExecute.mockResolvedValue('{"total_events": 42}');
      mockSummarize.mockResolvedValue("You have 42 events!");

      const req = makeRequest({
        From: "whatsapp:+1234567890",
        Body: "show me my photos",
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockPlan).toHaveBeenCalledOnce();
      expect(mockExecute).toHaveBeenCalledWith({ action: "stats" }, "whatsapp:+1234567890");
      expect(mockSummarize).toHaveBeenCalledWith("show me my photos", '{"total_events": 42}');
      expect(mockSaveHistory).toHaveBeenCalledOnce();
    });

    it("returns empty TwiML for empty body", async () => {
      const req = makeRequest({ From: "whatsapp:+1234567890", Body: "" });
      const res = await POST(req);
      const text = await res.text();
      expect(text).toBe("<Response></Response>");
      expect(mockPlan).not.toHaveBeenCalled();
    });

    it("returns 200 with empty TwiML on error and sends error message to user", async () => {
      mockPlan.mockRejectedValue(new Error("API key not configured"));

      const req = makeRequest({
        From: "whatsapp:+1234567890",
        Body: "hello",
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("<Response></Response>");

      // Should have tried to send an error message back to the user
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain("api.twilio.com");
      const body = new URLSearchParams(options.body);
      expect(body.get("To")).toBe("whatsapp:+1234567890");
      expect(body.get("Body")).toContain("something went wrong");
    });

    it("returns empty TwiML when env vars are missing", async () => {
      vi.unstubAllEnvs();
      // Don't set any env vars — should detect missing config

      const req = makeRequest({
        From: "whatsapp:+1234567890",
        Body: "hello",
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("<Response></Response>");
      // Should not attempt to call any agent functions
      expect(mockPlan).not.toHaveBeenCalled();
    });
  });
});
