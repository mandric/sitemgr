import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

import { sendMessageToAgent, type Message } from "@/lib/agent/core";

describe("sendMessageToAgent", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-api-key");
    mockCreate.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns content on successful response", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hello! How can I help?" }],
    });

    const result = await sendMessageToAgent("Hi there");

    expect(result).toEqual({ content: "Hello! How can I help?" });
    expect(mockCreate).toHaveBeenCalledOnce();

    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-4-20250514");
    expect(call.messages).toEqual([
      { role: "user", content: "Hi there" },
    ]);
  });

  it("includes conversation history in messages", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Based on our conversation..." }],
    });

    const history: Message[] = [
      { role: "user", content: "first message" },
      { role: "assistant", content: "first reply" },
    ];

    await sendMessageToAgent("follow up", history);

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages).toEqual([
      { role: "user", content: "first message" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "follow up" },
    ]);
  });

  it("returns error when API key is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    delete process.env.ANTHROPIC_API_KEY;

    const result = await sendMessageToAgent("test");
    expect(result).toEqual({ error: "API key not configured" });
  });

  it("returns error on unexpected response type", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", id: "123" }],
    });

    const result = await sendMessageToAgent("test");
    expect(result).toEqual({ error: "Unexpected response type" });
  });

  it("returns error on SDK exception", async () => {
    mockCreate.mockRejectedValue(new Error("Network failure"));

    const result = await sendMessageToAgent("test");
    expect(result).toEqual({ error: "Failed to get response from Claude" });
  });
});
