import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the agent core module
vi.mock("@/lib/agent/core", () => ({
  sendMessageToAgent: vi.fn(),
}));

// Mock global fetch for Twilio calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { GET, POST } from "@/app/api/whatsapp/route";
import { sendMessageToAgent } from "@/lib/agent/core";
import { NextRequest } from "next/server";

const mockAgent = vi.mocked(sendMessageToAgent);

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
    mockAgent.mockReset();
    mockFetch.mockReset();
    // Default Twilio response
    mockFetch.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("GET", () => {
    it("returns health check", async () => {
      const res = await GET();
      const json = await res.json();
      expect(json.status).toBe("ok");
      expect(json.service).toBe("whatsapp-webhook");
      expect(json.timestamp).toBeDefined();
    });
  });

  describe("POST", () => {
    it("processes message and sends response via Twilio", async () => {
      mockAgent.mockResolvedValue({ content: "Here are your stats!" });

      const req = makeRequest({
        From: "whatsapp:+1234567890",
        Body: "show me my photos",
      });

      const res = await POST(req);
      const json = await res.json();

      expect(json).toEqual({ success: true });
      expect(mockAgent).toHaveBeenCalledWith("show me my photos");

      // Check Twilio was called
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain("api.twilio.com");
      expect(url).toContain("AC_test_sid");
      expect(options.method).toBe("POST");
    });

    it("returns 400 when From or Body is missing", async () => {
      const req = makeRequest({ From: "whatsapp:+1234567890" });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("sends error message to user on agent failure", async () => {
      mockAgent.mockResolvedValue({ error: "API key not configured" });

      const req = makeRequest({
        From: "whatsapp:+1234567890",
        Body: "hello",
      });

      const res = await POST(req);
      expect(res.status).toBe(500);

      // Should still send a message to the user via Twilio
      expect(mockFetch).toHaveBeenCalledOnce();
      const body = mockFetch.mock.calls[0][1].body;
      expect(body.toString()).toContain("Sorry");
    });
  });
});
