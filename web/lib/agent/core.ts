/**
 * Core agent logic shared between web chat and WhatsApp interfaces
 */

import Anthropic from "@anthropic-ai/sdk";
import { AGENT_SYSTEM_PROMPT } from "./system-prompt";

export type Message = {
  role: "user" | "assistant";
  content: string;
};

export type AgentResponse = {
  content?: string;
  error?: string;
};

export async function sendMessageToAgent(
  message: string,
  conversationHistory?: Message[]
): Promise<AgentResponse> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { error: "API key not configured" };
    }

    const anthropic = new Anthropic({ apiKey });

    // Build messages array from conversation history
    const messages: Anthropic.MessageParam[] = [
      ...(conversationHistory || []).map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      {
        role: "user" as const,
        content: message,
      },
    ];

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: AGENT_SYSTEM_PROMPT,
      messages,
    });

    const content = response.content[0];
    if (content.type === "text") {
      return { content: content.text };
    }

    return { error: "Unexpected response type" };
  } catch (error) {
    console.error("Failed to send message to Claude:", error);
    return { error: "Failed to get response from Claude" };
  }
}
