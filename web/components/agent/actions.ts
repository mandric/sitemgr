"use server";

import { createClient } from "@/lib/supabase/server";
import {
  sendMessageToAgent,
  getConversationHistory,
  saveConversationHistory,
  type Message,
} from "@/lib/agent/core";

export async function sendMessage(
  message: string,
): Promise<{ content?: string; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Not authenticated" };
  }

  // Fetch conversation history scoped to this user
  const history = await getConversationHistory(supabase, "web", user.id);

  // Send with history and tool context. The agent will call tools
  // (query_media, get_stats, show_media) against Supabase as needed —
  // no static context prefix is injected.
  const response = await sendMessageToAgent(message, supabase, user.id, history);

  // Save updated history
  if (response.content) {
    const updatedHistory: Message[] = [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: response.content },
    ];
    await saveConversationHistory(supabase, "web", updatedHistory, user.id);
  }

  return response;
}
