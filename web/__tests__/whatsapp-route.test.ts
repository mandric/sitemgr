import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the agent core module
vi.mock("@/lib/agent/core", () => ({
  planAction: vi.fn(),
  executeAction: vi.fn(),
  summarizeResult: vi.fn(),
  getConversationHistory: vi.fn(),
  saveConversationHistory: vi.fn(),
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
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_sid");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test_auth_token");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886");
    mockPlan.mockReset();
    mockExecute.mockReset();
    mockSummarize.mockReset();
    mockGetHistory.mockReset();
    mockSaveHistory.mockReset();
    mockFetch.mockReset();
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
    it("returns health check", async () => {
      const res = await GET();
      const json = await res.json();
      expect(json.status).toBe("ok");
      expect(json.service).toBe("smgr-whatsapp-bot");
      expect(json.timestamp).toBeDefined();
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

    it("returns 200 with empty TwiML on error", async () => {
      mockPlan.mockRejectedValue(new Error("API key not configured"));

      const req = makeRequest({
        From: "whatsapp:+1234567890",
        Body: "hello",
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("<Response></Response>");
    });
  });
});
