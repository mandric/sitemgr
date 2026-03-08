/**
 * Core agent logic shared between web chat and WhatsApp interfaces.
 *
 * WhatsApp flow: planAction → executeAction → summarizeResult
 * Web chat flow: sendMessageToAgent (simple single-turn)
 */

import Anthropic from "@anthropic-ai/sdk";
import { AGENT_SYSTEM_PROMPT, WHATSAPP_PLANNER_PROMPT } from "./system-prompt";
import { getSupabaseClient } from "@/lib/media/db";
import { queryEvents, showEvent, getStats, getEnrichStatus } from "@/lib/media/db";
import { encryptSecret } from "@/lib/crypto/encryption";

// ── Types ──────────────────────────────────────────────────────

export type Message = {
  role: "user" | "assistant";
  content: string;
};

export type AgentResponse = {
  content?: string;
  error?: string;
};

interface AgentPlan {
  action: string;
  params?: Record<string, unknown>;
  response?: string;
}

// ── Web chat (simple) ──────────────────────────────────────────

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

// ── WhatsApp agent (plan → execute → summarize) ────────────────

export async function planAction(
  userMessage: string,
  history: Message[]
): Promise<AgentPlan> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const anthropic = new Anthropic({ apiKey });

  const messages: Anthropic.MessageParam[] = [
    ...history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    { role: "user" as const, content: userMessage },
  ];

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: WHATSAPP_PLANNER_PROMPT,
    messages,
  });

  let text = response.content[0].type === "text" ? response.content[0].text.trim() : "";

  // Strip markdown fences
  if (text.startsWith("```")) {
    text = text.split("\n").slice(1).join("\n");
    text = text.replace(/```\s*$/, "");
  }

  return JSON.parse(text);
}

export async function executeAction(
  plan: AgentPlan,
  phoneNumber: string
): Promise<string> {
  switch (plan.action) {
    case "direct":
      return plan.response ?? "";

    case "add_bucket":
      return await addBucket(phoneNumber, plan.params ?? {});

    case "list_buckets":
      return await listBuckets(phoneNumber);

    case "remove_bucket":
      return await removeBucket(phoneNumber, plan.params?.bucket_name as string);

    case "stats":
      return JSON.stringify(await getStats());

    case "show":
      return JSON.stringify(await showEvent(plan.params?.id as string) ?? { error: "Event not found" });

    case "enrich_status":
      return JSON.stringify(await getEnrichStatus());

    case "query": {
      const p = plan.params ?? {};
      const result = await queryEvents({
        search: p.search as string | undefined,
        type: p.type as string | undefined,
        since: p.since as string | undefined,
        until: p.until as string | undefined,
        limit: (p.limit as number) ?? 20,
      });
      return JSON.stringify({ results: result.events, count: result.total });
    }

    default:
      return JSON.stringify({ error: `Unknown action: ${plan.action}` });
  }
}

export async function summarizeResult(
  userMessage: string,
  actionResult: string
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You are a personal media assistant responding via WhatsApp chat.
The user asked: "${userMessage}"

Database result:
${actionResult}

Summarize conversationally. Keep it short — this is a chat message.
- Use line breaks for readability
- Mention counts and what photos show (from enrichment descriptions)
- Don't include raw JSON
- Don't be overly formal`,
      },
    ],
  });

  const content = response.content[0];
  return content.type === "text" ? content.text.trim() : "Sorry, I couldn't process that.";
}

// ── Bucket management (phone-number scoped, for WhatsApp) ──────

async function addBucket(
  phoneNumber: string,
  params: Record<string, unknown>
): Promise<string> {
  const bucketName = params.bucket_name as string;
  const endpointUrl = params.endpoint_url as string;
  const region = (params.region as string) || null;
  const accessKeyId = params.access_key_id as string;
  const secretAccessKey = params.secret_access_key as string;

  if (!bucketName || !endpointUrl || !accessKeyId || !secretAccessKey) {
    return JSON.stringify({
      error: "Missing required fields: bucket_name, endpoint_url, access_key_id, secret_access_key",
    });
  }

  const encryptedSecret = await encryptSecret(secretAccessKey);
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("bucket_configs")
    .insert({
      phone_number: phoneNumber,
      bucket_name: bucketName,
      region,
      endpoint_url: endpointUrl,
      access_key_id: accessKeyId,
      secret_access_key: encryptedSecret,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return JSON.stringify({ error: `Bucket "${bucketName}" is already configured` });
    }
    console.error("Database error:", error);
    return JSON.stringify({ error: "Failed to save bucket configuration" });
  }

  return JSON.stringify({
    success: true,
    bucket: { id: data.id, bucket_name: bucketName, region, endpoint_url: endpointUrl },
  });
}

async function listBuckets(phoneNumber: string): Promise<string> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("bucket_configs")
    .select("id, bucket_name, region, endpoint_url, created_at, last_synced_key")
    .eq("phone_number", phoneNumber)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Database error:", error);
    return JSON.stringify({ error: "Failed to retrieve buckets" });
  }

  return JSON.stringify({ buckets: data ?? [], count: data?.length ?? 0 });
}

async function removeBucket(phoneNumber: string, bucketName: string): Promise<string> {
  if (!bucketName) {
    return JSON.stringify({ error: "bucket_name is required" });
  }

  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("bucket_configs")
    .delete()
    .eq("phone_number", phoneNumber)
    .eq("bucket_name", bucketName);

  if (error) {
    console.error("Database error:", error);
    return JSON.stringify({ error: "Failed to remove bucket" });
  }

  return JSON.stringify({ success: true, message: `Bucket "${bucketName}" removed` });
}

// ── Conversation history ───────────────────────────────────────

export async function getConversationHistory(phone: string): Promise<Message[]> {
  const supabase = getSupabaseClient();

  const { data } = await supabase
    .from("conversations")
    .select("history")
    .eq("phone_number", phone)
    .single();

  return (data?.history as Message[]) ?? [];
}

export async function saveConversationHistory(
  phone: string,
  history: Message[]
): Promise<void> {
  const supabase = getSupabaseClient();
  const trimmed = history.slice(-20);

  await supabase.from("conversations").upsert({
    phone_number: phone,
    history: trimmed,
    updated_at: new Date().toISOString(),
  });
}
