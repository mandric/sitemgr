"use server";

import { sendMessageToAgent } from "@/lib/agent/core";

export async function sendMessage(
  message: string,
  userId: string
): Promise<{ content?: string; error?: string }> {
  // TODO: Fetch conversation history from database
  // TODO: Add user context (buckets, media stats, etc.)

  return sendMessageToAgent(message);
}
