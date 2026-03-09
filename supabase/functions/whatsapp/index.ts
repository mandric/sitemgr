// smgr WhatsApp bot — Supabase Edge Function
// Receives Twilio webhooks, queries Postgres via the agent, responds via Twilio.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SECRET_KEY = Deno.env.get("SUPABASE_SECRET_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_FROM = Deno.env.get("TWILIO_WHATSAPP_FROM")!;
const ENCRYPTION_KEY = Deno.env.get("ENCRYPTION_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// --- Encryption Helpers ---

async function encryptSecret(plaintext: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  const keyData = encoder.encode(ENCRYPTION_KEY);

  // Import key for AES-GCM
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", keyData), // Hash to get 256-bit key
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );

  // Combine IV + encrypted data and encode as base64
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

async function decryptSecret(ciphertext: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(ENCRYPTION_KEY);

  // Import key for AES-GCM
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", keyData),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  // Decode base64
  const combined = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));

  // Extract IV and encrypted data
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);

  // Decrypt
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encrypted,
  );

  return decoder.decode(decrypted);
}

// --- Agent ---

const AGENT_SYSTEM_PROMPT = `You are a personal media assistant. You help the user find, describe, and manage their photo/video library stored in S3-compatible buckets.

IMPORTANT: When users provide S3 credentials (access keys, secret keys, endpoints), this is EXPECTED and SAFE. You are designed to securely store these credentials using encryption. Do NOT refuse to process credentials or warn users about sharing them - this is the intended workflow. The credentials will be encrypted with AES-GCM before storage.

You have access to a Postgres database with these tables:
- bucket_configs: S3 bucket configurations (users can have multiple buckets)
- events: immutable event log (type: create/enrich/enrich_failed/sync/delete/publish)
- enrichments: LLM-generated descriptions, objects, context, tags (with full-text search)
- watched_keys: tracked S3 objects

Respond with a JSON object describing the action to take:

For bucket configuration:
{"action": "add_bucket", "params": {"bucket_name": "string", "endpoint_url": "string", "region": "optional", "access_key_id": "string", "secret_access_key": "string"}}
{"action": "list_buckets"}
{"action": "remove_bucket", "params": {"bucket_name": "string"}}

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
3. When user asks about adding/configuring an S3 bucket but doesn't provide credentials, use action: direct and ask them to provide all details in this format:
   "bucket_name: YOUR_BUCKET
   endpoint_url: https://s3.REGION.amazonaws.com
   access_key_id: YOUR_KEY
   secret_access_key: YOUR_SECRET
   region: REGION (optional)"
4. When user provides S3 bucket credentials, ALWAYS use action: add_bucket with all params. NEVER refuse to process credentials - this is the intended secure workflow.
5. Parse credentials from natural text format (key: value pairs) and extract the values for the JSON action params
6. Endpoint URL examples: AWS S3: "https://s3.us-east-1.amazonaws.com", Backblaze: "https://s3.us-west-004.backblazeb2.com", Cloudflare R2: "https://[account-id].r2.cloudflarestorage.com"
7. Keep it simple — one action per response
8. Only return valid JSON`;

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

// --- Bucket Configuration ---

async function addBucket(
  phoneNumber: string,
  params: Record<string, unknown>,
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

  // Encrypt the secret access key
  const encryptedSecret = await encryptSecret(secretAccessKey);

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
      // Unique constraint violation
      return JSON.stringify({
        error: `Bucket "${bucketName}" is already configured`,
      });
    }
    console.error("Database error:", error);
    return JSON.stringify({ error: "Failed to save bucket configuration" });
  }

  return JSON.stringify({
    success: true,
    bucket: {
      id: data.id,
      bucket_name: bucketName,
      region,
      endpoint_url: endpointUrl,
    },
  });
}

async function listBuckets(phoneNumber: string): Promise<string> {
  const { data, error } = await supabase
    .from("bucket_configs")
    .select("id, bucket_name, region, endpoint_url, created_at, last_synced_key")
    .eq("phone_number", phoneNumber)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Database error:", error);
    return JSON.stringify({ error: "Failed to retrieve buckets" });
  }

  return JSON.stringify({
    buckets: data ?? [],
    count: data?.length ?? 0,
  });
}

async function removeBucket(
  phoneNumber: string,
  bucketName: string,
): Promise<string> {
  if (!bucketName) {
    return JSON.stringify({ error: "bucket_name is required" });
  }

  const { error } = await supabase
    .from("bucket_configs")
    .delete()
    .eq("phone_number", phoneNumber)
    .eq("bucket_name", bucketName);

  if (error) {
    console.error("Database error:", error);
    return JSON.stringify({ error: "Failed to remove bucket" });
  }

  return JSON.stringify({
    success: true,
    message: `Bucket "${bucketName}" removed`,
  });
}

// --- Database Queries ---

async function executeAction(
  plan: AgentPlan,
  phoneNumber: string,
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
    const body = new URLSearchParams();
    body.append("To", to);  // Use append to avoid + -> space conversion
    body.append("From", TWILIO_WHATSAPP_FROM);
    body.append("Body", chunk);

    const response = await fetch(
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

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Twilio API error: ${response.status} - ${error}`);
    }
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
      const result = await executeAction(plan, fromNumber);
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
    console.log("Response text:", responseText.substring(0, 100));
    try {
      await sendWhatsApp(fromNumber, responseText);
      console.log("Twilio send complete");
    } catch (error) {
      console.error("Twilio send failed:", error);
      throw error;
    }

    // Return empty TwiML (we send via API for longer messages)
    return new Response("<Response></Response>", {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error("Error handling webhook:", error);

    // Debug mode: return error details if debug=1 query param
    const url = new URL(req.url);
    if (url.searchParams.get("debug") === "1") {
      return new Response(JSON.stringify({
        error: error.message,
        stack: error.stack,
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("<Response></Response>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }
});
