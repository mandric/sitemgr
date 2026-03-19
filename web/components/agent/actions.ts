"use server";

import { createClient } from "@/lib/supabase/server";
import {
  sendMessageToAgent,
  getConversationHistory,
  saveConversationHistory,
  type Message,
} from "@/lib/agent/core";
import { getStats } from "@/lib/media/db";

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

  // Fetch conversation history
  const history = await getConversationHistory("web", user.id);

  // Build user context
  const { data: buckets } = await supabase
    .from("bucket_configs")
    .select("id, bucket_name, endpoint_url, region, created_at")
    .eq("user_id", user.id);

  const stats = await getStats(user.id);

  const contextPrefix = [
    `[User context]`,
    `Buckets: ${buckets?.length ?? 0} configured${buckets?.length ? ` (${buckets.map((b) => b.bucket_name).join(", ")})` : ""}`,
    `Media: ${stats.total_events} events, ${stats.enriched} enriched, ${stats.pending_enrichment} pending enrichment`,
    stats.by_content_type
      ? `Types: ${Object.entries(stats.by_content_type).map(([k, v]) => `${k}: ${v}`).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const enrichedMessage = `${contextPrefix}\n\n${message}`;

  // Send with history
  const response = await sendMessageToAgent(enrichedMessage, history);

  // Save updated history
  if (response.content) {
    const updatedHistory: Message[] = [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: response.content },
    ];
    await saveConversationHistory("web", updatedHistory, user.id);
  }

  return response;
}
