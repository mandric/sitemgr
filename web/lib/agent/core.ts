/**
 * Core agent logic shared between web chat and WhatsApp interfaces.
 *
 * WhatsApp flow: planAction → executeAction → summarizeResult
 * Web chat flow: sendMessageToAgent (simple single-turn)
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENT_SYSTEM_PROMPT, WHATSAPP_PLANNER_PROMPT } from "./system-prompt";
import { AGENT_TOOLS, executeTool } from "./tools";
import {
  queryEvents,
  showEvent,
  getStats,
  getEnrichStatus,
} from "@/lib/media/db";
import {
  encryptSecretVersioned,
  getEncryptionVersion,
} from "@/lib/crypto/encryption-versioned";
import {
  createS3Client,
  listS3Objects,
} from "@/lib/media/s3";
import {
  detectContentType,
} from "@/lib/media/utils";
import {
  getBucketConfig,
  createS3ClientFromConfig,
  testBucketConnectivity,
  scanBucket,
} from "@/lib/media/bucket-service";
import type { BucketConfig } from "@/lib/media/bucket-service";
import { runWithRequestId } from "@/lib/request-context";
import { createLogger, LogComponent } from "@/lib/logger";

const logger = createLogger(LogComponent.Agent);

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

export type ErrorType =
  | "not_found"
  | "access_denied"
  | "validation_error"
  | "api_error"
  | "timeout"
  | "internal";

function errorResponse(
  message: string,
  errorType: ErrorType,
  details?: Record<string, unknown>,
): string {
  return JSON.stringify({
    error: message,
    errorType,
    ...(details ? { details } : {}),
  });
}

function generateRequestId(): string {
  return crypto.randomUUID();
}

// ── Web chat (tool-use loop) ───────────────────────────────────

const MAX_TOOL_ITERATIONS = 5;

/**
 * Send a message to the web chat agent with tool use enabled.
 *
 * Runs a synchronous loop: call Claude → execute any tool_use blocks →
 * feed tool_result back → repeat until Claude returns a final text response
 * (or MAX_TOOL_ITERATIONS is hit to guard against runaway chaining).
 *
 * Tools are executed with the provided Supabase client, scoped to `userId`
 * so all queries respect tenant isolation.
 */
export async function sendMessageToAgent(
  message: string,
  client: SupabaseClient,
  userId: string,
  conversationHistory?: Message[],
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

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: AGENT_SYSTEM_PROMPT,
        tools: AGENT_TOOLS,
        messages,
      });

      // Collect any tool_use blocks from this response.
      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        // Final response — extract text from content blocks.
        const textBlocks = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text);
        const text = textBlocks.join("\n").trim();
        if (text) return { content: text };
        return { error: "Empty response from model" };
      }

      // Execute all tool calls in parallel and collect results.
      const toolResults = await Promise.all(
        toolUses.map(async (toolUse) => {
          const result = await executeTool(
            toolUse.name,
            (toolUse.input as Record<string, unknown>) ?? {},
            { client, userId },
          );
          const resultBlock: Anthropic.ToolResultBlockParam = {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result,
          };
          return resultBlock;
        }),
      );

      // Append the assistant turn and the tool_result user turn, then loop.
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    }

    logger.warn("agent tool loop exceeded max iterations", {
      max: MAX_TOOL_ITERATIONS,
    });
    return {
      error: `Tool use exceeded max iterations (${MAX_TOOL_ITERATIONS})`,
    };
  } catch (error) {
    logger.error("sendMessageToAgent failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: "Failed to get response from Claude" };
  }
}

// ── WhatsApp agent (plan → execute → summarize) ────────────────

export async function planAction(
  userMessage: string,
  history: Message[],
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

  let text =
    response.content[0].type === "text" ? response.content[0].text.trim() : "";

  // Strip markdown fences
  if (text.startsWith("```")) {
    text = text.split("\n").slice(1).join("\n");
    text = text.replace(/```\s*$/, "");
  }

  return JSON.parse(text);
}

/** Resolve a phone number to a user_id via user_profiles lookup. */
export async function resolveUserId(client: SupabaseClient, phoneNumber: string): Promise<string | null> {
  const { data } = await client
    .from("user_profiles")
    .select("id")
    .eq("phone_number", phoneNumber)
    .maybeSingle();
  return data?.id ?? null;
}

export async function executeAction(
  client: SupabaseClient,
  plan: AgentPlan,
  phoneNumber: string,
  preResolvedUserId?: string | null,
): Promise<string> {
  const requestId = generateRequestId();
  return runWithRequestId(requestId, async () => {
    const startMs = Date.now();

    logger.info("action dispatch", {
      action: plan.action,
      request_id: requestId,
    });

    // Use pre-resolved userId if available, otherwise resolve from phone
    const userId = preResolvedUserId !== undefined ? preResolvedUserId : await resolveUserId(client, phoneNumber);

    // All DB actions require a resolved user — reject unknown phone numbers
    if (!userId && plan.action !== "direct") {
      return errorResponse("Unknown user — phone number not registered", "not_found");
    }

    try {
      let result: string;

      switch (plan.action) {
        case "direct":
          result = plan.response ?? "";
          break;

        case "add_bucket":
          result = await addBucket(client, phoneNumber, plan.params ?? {}, userId);
          break;

        case "list_buckets":
          result = await listBuckets(client, phoneNumber, userId);
          break;

        case "remove_bucket":
          result = await removeBucket(
            client,
            phoneNumber,
            plan.params?.bucket_name as string,
            userId,
          );
          break;

        case "stats": {
          const statsResult = await getStats(client, { userId: userId ?? undefined });
          if (statsResult.error) {
            result = errorResponse(`Stats query failed: ${(statsResult.error as Error).message ?? statsResult.error}`, "internal");
          } else {
            result = JSON.stringify(statsResult.data);
          }
          break;
        }

        case "show": {
          const showResult = await showEvent(client, plan.params?.id as string, userId ?? undefined);
          if (showResult.error) {
            result = errorResponse(`Show query failed: ${(showResult.error as Error).message ?? showResult.error}`, "internal");
          } else {
            result = JSON.stringify(showResult.data ?? { error: "Event not found" });
          }
          break;
        }

        case "enrich_status": {
          const enrichResult = await getEnrichStatus(client, userId ?? undefined);
          if (enrichResult.error) {
            result = errorResponse(`Enrich status query failed: ${(enrichResult.error as Error).message ?? enrichResult.error}`, "internal");
          } else {
            result = JSON.stringify(enrichResult.data);
          }
          break;
        }

        case "query": {
          const p = plan.params ?? {};
          const queryResult = await queryEvents(client, {
            userId: userId ?? undefined,
            search: p.search as string | undefined,
            type: p.type as string | undefined,
            since: p.since as string | undefined,
            until: p.until as string | undefined,
            limit: (p.limit as number) ?? 20,
          });
          if (queryResult.error) {
            result = errorResponse(`Query failed: ${(queryResult.error as Error).message ?? queryResult.error}`, "internal");
          } else {
            result = JSON.stringify({ results: queryResult.data, count: queryResult.count });
          }
          break;
        }

        case "test_bucket":
          result = await verifyBucketConfigAction(
            client,
            phoneNumber,
            plan.params?.bucket_name as string,
            userId,
          );
          break;

        case "list_objects":
          result = await listObjects(
            client,
            phoneNumber,
            plan.params?.bucket_name as string,
            plan.params?.prefix as string | undefined,
            (plan.params?.limit as number) ?? 100,
            userId,
          );
          break;

        case "count_objects":
          result = await countObjects(
            client,
            phoneNumber,
            plan.params?.bucket_name as string,
            plan.params?.prefix as string | undefined,
            userId,
          );
          break;

        case "index_bucket":
          result = await indexBucketAction(
            client,
            phoneNumber,
            plan.params?.bucket_name as string,
            plan.params?.prefix as string | undefined,
            (plan.params?.batch_size as number) ?? 10,
            userId,
          );
          break;

        default:
          result = errorResponse(`Unknown action: ${plan.action}`, "not_found");
          break;
      }

      logger.info("action complete", {
        action: plan.action,
        duration_ms: Date.now() - startMs,
      });

      return result;
    } catch (err) {
      logger.error("action failed", {
        action: plan.action,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - startMs,
      });
      return errorResponse(
        `Action failed: ${err instanceof Error ? err.message : String(err)}`,
        "internal",
      );
    }
  });
}

export async function summarizeResult(
  userMessage: string,
  actionResult: string,
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
  return content.type === "text"
    ? content.text.trim()
    : "Sorry, I couldn't process that.";
}

// ── Bucket management (phone-number scoped, for WhatsApp) ──────

async function addBucket(
  client: SupabaseClient,
  phoneNumber: string,
  params: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  const bucketName = params.bucket_name as string;
  const endpointUrl = params.endpoint_url as string;
  const region = (params.region as string) || null;
  const accessKeyId = params.access_key_id as string;
  const secretAccessKey = params.secret_access_key as string;

  if (!bucketName || !endpointUrl || !accessKeyId || !secretAccessKey) {
    return errorResponse(
      "Missing required fields: bucket_name, endpoint_url, access_key_id, secret_access_key",
      "validation_error",
    );
  }

  if (!userId) {
    return errorResponse("Could not resolve user for this phone number", "not_found");
  }

  // Use versioned encryption for new buckets
  const encryptedSecret = await encryptSecretVersioned(secretAccessKey);
  const keyVersion = getEncryptionVersion(encryptedSecret);

  const { data, error } = await client
    .from("bucket_configs")
    .insert({
      user_id: userId,
      bucket_name: bucketName,
      region,
      endpoint_url: endpointUrl,
      access_key_id: accessKeyId,
      secret_access_key: encryptedSecret,
      encryption_key_version: keyVersion,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return errorResponse(
        `Bucket "${bucketName}" is already configured`,
        "validation_error",
      );
    }
    logger.error("database error in addBucket", { error: error.message });
    return errorResponse("Failed to save bucket configuration", "internal");
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

async function listBuckets(client: SupabaseClient, phoneNumber: string, userId: string | null): Promise<string> {
  if (!userId) {
    return errorResponse("Could not resolve user for this phone number", "not_found");
  }

  const { data, error } = await client
    .from("bucket_configs")
    .select(
      "id, bucket_name, region, endpoint_url, created_at, last_synced_key",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    logger.error("database error in listBuckets", { error: error.message });
    return errorResponse("Failed to retrieve buckets", "internal");
  }

  return JSON.stringify({ buckets: data ?? [], count: data?.length ?? 0 });
}

async function removeBucket(
  client: SupabaseClient,
  phoneNumber: string,
  bucketName: string,
  userId: string | null,
): Promise<string> {
  if (!bucketName) {
    return errorResponse("bucket_name is required", "validation_error");
  }

  if (!userId) {
    return errorResponse("Could not resolve user for this phone number", "not_found");
  }

  const { error } = await client
    .from("bucket_configs")
    .delete()
    .eq("user_id", userId)
    .eq("bucket_name", bucketName);

  if (error) {
    logger.error("database error in removeBucket", { error: error.message });
    return errorResponse("Failed to remove bucket", "internal");
  }

  return JSON.stringify({
    success: true,
    message: `Bucket "${bucketName}" removed`,
  });
}

// ── S3 bucket operations (delegated to bucket-service) ──────────

type S3ClientResult =
  | {
      ok: true;
      client: ReturnType<typeof createS3Client>;
      config: BucketConfig;
    }
  | { ok: false; errorJson: string };

async function requireS3Client(
  client: SupabaseClient,
  phoneNumber: string,
  bucketName: string,
  userId?: string | null,
): Promise<S3ClientResult> {
  if (!bucketName)
    return {
      ok: false,
      errorJson: errorResponse("bucket_name is required", "validation_error"),
    };

  if (!userId)
    return {
      ok: false,
      errorJson: errorResponse("Could not resolve user", "not_found"),
    };

  const result = await getBucketConfig(client, userId, bucketName);
  if (!result.exists)
    return {
      ok: false,
      errorJson: errorResponse(`Bucket "${bucketName}" not found`, "not_found"),
    };
  if (result.error) {
    logger.error("cannot decrypt bucket", {
      bucket: bucketName,
      error: result.error.message,
    });
    return {
      ok: false,
      errorJson: errorResponse(result.error.message, "internal"),
    };
  }

  const config = result.config!;
  const s3client = createS3ClientFromConfig(config);

  return { ok: true, client: s3client, config };
}

async function verifyBucketConfigAction(
  client: SupabaseClient,
  phoneNumber: string,
  bucketName: string,
  userId?: string | null,
): Promise<string> {
  const s3 = await requireS3Client(client, phoneNumber, bucketName, userId);
  if (!s3.ok) return s3.errorJson;

  const result = await testBucketConnectivity(s3.client, bucketName);
  return JSON.stringify(result);
}

async function listObjects(
  client: SupabaseClient,
  phoneNumber: string,
  bucketName: string,
  prefix?: string,
  limit = 100,
  userId?: string | null,
): Promise<string> {
  const s3 = await requireS3Client(client, phoneNumber, bucketName, userId);
  if (!s3.ok) return s3.errorJson;

  try {
    const allObjects = await listS3Objects(s3.client, bucketName, prefix ?? "");
    const objects = allObjects.slice(0, limit);

    return JSON.stringify({
      bucket: bucketName,
      prefix: prefix ?? "",
      objects: objects.map((o) => ({
        key: o.key,
        size: o.size,
        lastModified: o.lastModified,
      })),
      returned: objects.length,
      total: allObjects.length,
    });
  } catch (err) {
    return errorResponse(
      `Failed to list objects: ${(err as Error).message}`,
      "api_error",
    );
  }
}

async function countObjects(
  client: SupabaseClient,
  phoneNumber: string,
  bucketName: string,
  prefix?: string,
  userId?: string | null,
): Promise<string> {
  const s3 = await requireS3Client(client, phoneNumber, bucketName, userId);
  if (!s3.ok) return s3.errorJson;

  try {
    const allObjects = await listS3Objects(s3.client, bucketName, prefix ?? "");

    const byType: Record<string, number> = {};
    for (const obj of allObjects) {
      const ct = detectContentType(obj.key);
      byType[ct] = (byType[ct] ?? 0) + 1;
    }

    return JSON.stringify({
      bucket: bucketName,
      prefix: prefix ?? "",
      total: allObjects.length,
      by_type: byType,
    });
  } catch (err) {
    return errorResponse(
      `Failed to count objects: ${(err as Error).message}`,
      "api_error",
    );
  }
}

async function indexBucketAction(
  client: SupabaseClient,
  phoneNumber: string,
  bucketName: string,
  prefix?: string,
  batchSize = 10,
  userId?: string | null,
): Promise<string> {
  const s3 = await requireS3Client(client, phoneNumber, bucketName, userId);
  if (!s3.ok) return s3.errorJson;

  try {
    const result = await scanBucket(client, s3.client, s3.config, userId!, {
      prefix,
      batch_size: batchSize,
      auto_enrich: true,
      device_id: `whatsapp:${phoneNumber}`,
    });

    return JSON.stringify({
      bucket: result.bucket,
      total_objects: result.total_objects,
      already_indexed: result.already_indexed,
      remaining: Math.max(0, result.new_objects - result.per_object.length),
      batch_size: result.per_object.length,
      batch_indexed: result.created_events,
      batch_enriched: result.batch_enriched,
      per_object: result.per_object,
    });
  } catch (err) {
    return errorResponse(
      `Failed to index bucket: ${(err as Error).message}`,
      "internal",
    );
  }
}

// ── Conversation history ───────────────────────────────────────

export async function getConversationHistory(
  client: SupabaseClient,
  phone: string,
  userId?: string | null,
): Promise<Message[]> {
  if (userId) {
    const { data } = await client
      .from("conversations")
      .select("history")
      .eq("user_id", userId)
      .single();
    return (data?.history as Message[]) ?? [];
  }

  // Fallback to phone_number for legacy callers
  const { data } = await client
    .from("conversations")
    .select("history")
    .eq("phone_number", phone)
    .single();

  return (data?.history as Message[]) ?? [];
}

export async function saveConversationHistory(
  client: SupabaseClient,
  phone: string,
  history: Message[],
  userId?: string | null,
): Promise<void> {
  const trimmed = history.slice(-20);

  if (userId) {
    await client.from("conversations").upsert(
      {
        user_id: userId,
        phone_number: phone,
        history: trimmed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    return;
  }

  // Fallback to phone_number for legacy callers
  await client.from("conversations").upsert({
    phone_number: phone,
    history: trimmed,
    updated_at: new Date().toISOString(),
  });
}
