// smgr WhatsApp bot — Supabase Edge Function
// Receives Twilio webhooks, queries Postgres via the agent, responds via Twilio.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_FROM = Deno.env.get("TWILIO_WHATSAPP_FROM")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Agent ---

const AGENT_SYSTEM_PROMPT = `You are a personal media assistant. You help the user find, describe, and manage their photo/video library.

You have access to a Postgres database with these tables:
- events: immutable event log (type: create/enrich/enrich_failed/sync/delete/publish)
- enrichments: LLM-generated descriptions, objects, context, tags (with full-text search)
- watched_keys: tracked S3 objects

Respond with a JSON object describing the action to take:

For queries:
{"action": "query", "params": {"search": "optional text", "type": "photo|video|audio", "since": "ISO date", "until": "ISO date", "limit": 10}}

For a specific event:
{"action": "show", "params": {"id": "event_id"}}

For stats:
{"action": "stats"}

For enrichment status:
{"action": "enrich_status"}

If no database action is needed (greeting, clarification):
{"action": "direct", "response": "your response text"}

Rules:
1. For vague queries like "what photos do I have?", use stats
2. For search queries, use action: query with search param
3. Keep it simple — one action per response
4. Only return valid JSON`;

interface AgentPlan {
  action: string;
  params?: Record<string, unknown>;
  response?: string;
}

async function agentPlan(
  userMessage: string,
  history: Array<{ role: string; content: string }>,
): Promise<AgentPlan> {
  const messages = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: AGENT_SYSTEM_PROMPT,
      messages,
    }),
  });

  const data = await res.json();
  let text = data.content[0].text.trim();

  // Strip markdown fences
  if (text.startsWith("```")) {
    text = text.split("\n").slice(1).join("\n");
    text = text.replace(/```\s*$/, "");
  }

  return JSON.parse(text);
}

// --- Database Queries ---

async function executeAction(plan: AgentPlan): Promise<string> {
  switch (plan.action) {
    case "direct":
      return plan.response ?? "";

    case "stats":
      return await queryStats();

    case "show":
      return await queryShow(plan.params?.id as string);

    case "enrich_status":
      return await queryEnrichStatus();

    case "query":
      return await queryEvents(plan.params ?? {});

    default:
      return JSON.stringify({ error: `Unknown action: ${plan.action}` });
  }
}

async function queryStats(): Promise<string> {
  const { count: totalEvents } = await supabase
    .from("events")
    .select("*", { count: "exact", head: true });

  const { data: byType } = await supabase.rpc("stats_by_content_type");
  const { data: byEventType } = await supabase.rpc("stats_by_event_type");
  const { count: enriched } = await supabase
    .from("enrichments")
    .select("*", { count: "exact", head: true });

  const { count: totalCreate } = await supabase
    .from("events")
    .select("*", { count: "exact", head: true })
    .eq("type", "create");

  return JSON.stringify({
    total_events: totalEvents,
    total_media: totalCreate,
    enriched,
    pending_enrichment: (totalCreate ?? 0) - (enriched ?? 0),
    by_content_type: byType,
    by_event_type: byEventType,
  });
}

async function queryShow(eventId: string): Promise<string> {
  const { data: event } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .single();

  if (!event) return JSON.stringify({ error: "Event not found" });

  const { data: enrichment } = await supabase
    .from("enrichments")
    .select("description, objects, context, tags")
    .eq("event_id", eventId)
    .single();

  return JSON.stringify({ ...event, enrichment });
}

async function queryEnrichStatus(): Promise<string> {
  const { count: totalPhotos } = await supabase
    .from("events")
    .select("*", { count: "exact", head: true })
    .eq("type", "create")
    .eq("content_type", "photo");

  const { count: enriched } = await supabase
    .from("enrichments")
    .select("*", { count: "exact", head: true });

  return JSON.stringify({
    total_photos: totalPhotos,
    enriched,
    pending: (totalPhotos ?? 0) - (enriched ?? 0),
  });
}

async function queryEvents(
  params: Record<string, unknown>,
): Promise<string> {
  const search = params.search as string | undefined;
  const contentType = params.type as string | undefined;
  const since = params.since as string | undefined;
  const until = params.until as string | undefined;
  const limit = (params.limit as number) ?? 20;

  // Full-text search path
  if (search) {
    const { data, error } = await supabase.rpc("search_events", {
      query_text: search,
      content_type_filter: contentType ?? null,
      since_filter: since ?? null,
      until_filter: until ?? null,
      result_limit: limit,
    });

    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify({ results: data, count: data?.length ?? 0 });
  }

  // Standard filtered query
  let query = supabase
    .from("events")
    .select("*")
    .eq("type", "create")
    .order("timestamp", { ascending: false })
    .limit(limit);

  if (contentType) query = query.eq("content_type", contentType);
  if (since) query = query.gte("timestamp", since);
  if (until) query = query.lte("timestamp", until);

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });

  // Fetch enrichments for results
  const eventIds = (data ?? []).map((e: { id: string }) => e.id);
  const { data: enrichments } = await supabase
    .from("enrichments")
    .select("*")
    .in("event_id", eventIds);

  const enrichMap = new Map(
    (enrichments ?? []).map((e: { event_id: string }) => [e.event_id, e]),
  );

  const results = (data ?? []).map((e: { id: string }) => ({
    ...e,
    enrichment: enrichMap.get(e.id) ?? null,
  }));

  return JSON.stringify({ results, count: results.length });
}

// --- Summarizer ---

async function agentSummarize(
  userMessage: string,
  actionResult: string,
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
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
    }),
  });

  const data = await res.json();
  return data.content[0].text.trim();
}

// --- Conversation History ---

async function getHistory(
  phone: string,
): Promise<Array<{ role: string; content: string }>> {
  const { data } = await supabase
    .from("conversations")
    .select("history")
    .eq("phone_number", phone)
    .single();

  return (data?.history as Array<{ role: string; content: string }>) ?? [];
}

async function saveHistory(
  phone: string,
  history: Array<{ role: string; content: string }>,
): Promise<void> {
  // Keep last 20 messages
  const trimmed = history.slice(-20);

  await supabase.from("conversations").upsert({
    phone_number: phone,
    history: trimmed,
    updated_at: new Date().toISOString(),
  });
}

// --- Twilio ---

async function sendWhatsApp(to: string, message: string): Promise<void> {
  const chunks = splitMessage(message, 1500);

  for (const chunk of chunks) {
    const body = new URLSearchParams({
      To: to,
      From: TWILIO_WHATSAPP_FROM,
      Body: chunk,
    });

    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      },
    );
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// --- Handler ---

Deno.serve(async (req: Request) => {
  // Health check
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({ status: "ok", service: "smgr-whatsapp-bot" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    console.log("=== Webhook received ===");

    const formData = await req.text();
    console.log("Form data:", formData.substring(0, 200));

    const params = new URLSearchParams(formData);

    const fromNumber = params.get("From") ?? "";
    const messageBody = params.get("Body") ?? "";

    console.log("From:", fromNumber);
    console.log("Body:", messageBody);

    if (!messageBody) {
      console.log("No message body, returning early");
      return new Response("<Response></Response>", {
        headers: { "Content-Type": "text/xml" },
      });
    }

    console.log(`[${new Date().toISOString()}] ${fromNumber}: ${messageBody}`);

    // Get conversation history
    const history = await getHistory(fromNumber);

    // Agent: plan
    const plan = await agentPlan(messageBody, history);

    let responseText: string;
    if (plan.action === "direct") {
      responseText = plan.response ?? "";
    } else {
      // Execute database action
      const result = await executeAction(plan);
      // Summarize
      responseText = await agentSummarize(messageBody, result);
    }

    // Update history
    history.push({ role: "user", content: messageBody });
    history.push({ role: "assistant", content: responseText });
    await saveHistory(fromNumber, history);

    console.log(
      `[${new Date().toISOString()}] → ${responseText.slice(0, 100)}...`,
    );

    // Send via Twilio
    console.log("Sending to Twilio:", fromNumber);
    await sendWhatsApp(fromNumber, responseText);
    console.log("Twilio send complete");

    // Return empty TwiML (we send via API for longer messages)
    return new Response("<Response></Response>", {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error("Error handling webhook:", error);
    return new Response("<Response></Response>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }
});
