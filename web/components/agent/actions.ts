"use server";

import { sendMessageToAgent } from "@/lib/agent/core";

export async function sendMessage(
  message: string
): Promise<{ content?: string; error?: string }> {
  // TODO: Add userId param and fetch conversation history from database
  // TODO: Add user context (buckets, media stats, etc.)

  return sendMessageToAgent(message);
}
