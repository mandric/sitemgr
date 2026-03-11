/**
 * Core agent logic shared between web chat and WhatsApp interfaces.
 *
 * WhatsApp flow: planAction → executeAction → summarizeResult
 * Web chat flow: sendMessageToAgent (simple single-turn)
 */

import Anthropic from "@anthropic-ai/sdk";
import { AGENT_SYSTEM_PROMPT, WHATSAPP_PLANNER_PROMPT } from "./system-prompt";
import { getSupabaseClient } from "@/lib/media/db";
import {
  queryEvents,
  showEvent,
  getStats,
  getEnrichStatus,
  insertEvent,
  insertEnrichment,
  upsertWatchedKey,
  getWatchedKeys,
} from "@/lib/media/db";
import {
  encryptSecretVersioned,
  decryptSecretVersioned,
  getEncryptionVersion,
  needsMigration,
} from "@/lib/crypto/encryption-versioned";
import {
  createS3Client,
  listS3Objects,
  downloadS3Object,
} from "@/lib/media/s3";
import {
  newEventId,
  detectContentType,
  getMimeType,
  s3Metadata,
} from "@/lib/media/utils";
import { enrichImage } from "@/lib/media/enrichment";
import { ListObjectsV2Command, ListObjectsCommand } from "@aws-sdk/client-s3";

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

export async function executeAction(
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
      return await removeBucket(
        phoneNumber,
        plan.params?.bucket_name as string,
      );

    case "stats":
      return JSON.stringify(await getStats());

    case "show":
      return JSON.stringify(
        (await showEvent(plan.params?.id as string)) ?? {
          error: "Event not found",
        },
      );

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

    case "test_bucket":
      return await testBucket(phoneNumber, plan.params?.bucket_name as string);

    case "list_objects":
      return await listObjects(
        phoneNumber,
        plan.params?.bucket_name as string,
        plan.params?.prefix as string | undefined,
        (plan.params?.limit as number) ?? 100,
      );

    case "count_objects":
      return await countObjects(
        phoneNumber,
        plan.params?.bucket_name as string,
        plan.params?.prefix as string | undefined,
      );

    case "index_bucket":
      return await indexBucket(
        phoneNumber,
        plan.params?.bucket_name as string,
        plan.params?.prefix as string | undefined,
        (plan.params?.batch_size as number) ?? 10,
      );

    default:
      return JSON.stringify({ error: `Unknown action: ${plan.action}` });
  }
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
      error:
        "Missing required fields: bucket_name, endpoint_url, access_key_id, secret_access_key",
    });
  }

  // Use versioned encryption for new buckets
  const encryptedSecret = await encryptSecretVersioned(secretAccessKey);
  const keyVersion = getEncryptionVersion(encryptedSecret);
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
      encryption_key_version: keyVersion,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
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
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("bucket_configs")
    .select(
      "id, bucket_name, region, endpoint_url, created_at, last_synced_key",
    )
    .eq("phone_number", phoneNumber)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Database error:", error);
    return JSON.stringify({ error: "Failed to retrieve buckets" });
  }

  return JSON.stringify({ buckets: data ?? [], count: data?.length ?? 0 });
}

async function removeBucket(
  phoneNumber: string,
  bucketName: string,
): Promise<string> {
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

  return JSON.stringify({
    success: true,
    message: `Bucket "${bucketName}" removed`,
  });
}

// ── S3 bucket operations ────────────────────────────────────────

type BucketConfig = {
  id: string;
  endpoint_url: string;
  region?: string;
  access_key_id: string;
  secret_access_key: string;
  [key: string]: unknown;
};
type BucketConfigResult = {
  exists: boolean;
  config?: BucketConfig;
  error?: Error;
};

type S3ClientResult =
  | {
      ok: true;
      client: ReturnType<typeof createS3Client>;
      config: BucketConfig;
    }
  | { ok: false; errorJson: string };

async function requireS3Client(
  phoneNumber: string,
  bucketName: string,
): Promise<S3ClientResult> {
  if (!bucketName)
    return {
      ok: false,
      errorJson: JSON.stringify({ error: "bucket_name is required" }),
    };

  const result = await getBucketConfig(phoneNumber, bucketName);
  if (!result.exists)
    return {
      ok: false,
      errorJson: JSON.stringify({ error: `Bucket "${bucketName}" not found` }),
    };
  if (result.error)
    return {
      ok: false,
      errorJson: JSON.stringify({ error: result.error.message }),
    };

  const config = result.config!;
  const client = createS3Client({
    endpoint: config.endpoint_url,
    region: config.region ?? undefined,
    accessKeyId: config.access_key_id,
    secretAccessKey: config.secret_access_key,
  });

  return { ok: true, client, config };
}

async function getBucketConfig(
  phoneNumber: string,
  bucketName: string,
): Promise<BucketConfigResult> {
  if (!bucketName) return { exists: false };
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("phone_number", phoneNumber)
    .eq("bucket_name", bucketName)
    .maybeSingle();

  if (error || !data) return { exists: false };

  try {
    // Use versioned decryption (supports both old and new encryption keys)
    const decryptedSecret = await decryptSecretVersioned(
      data.secret_access_key,
    );

    // 🔑 Lazy migration: Re-encrypt with current version if needed
    if (needsMigration(data.secret_access_key)) {
      const newCiphertext = await encryptSecretVersioned(decryptedSecret);
      const newVersion = getEncryptionVersion(newCiphertext);

      // Update in background (non-blocking, fire-and-forget)
      supabase
        .from("bucket_configs")
        .update({
          secret_access_key: newCiphertext,
          encryption_key_version: newVersion,
        })
        .eq("id", data.id)
        .then(() => {
          console.log(
            `[Lazy Migration] ✅ Migrated "${bucketName}" to encryption key v${newVersion}`,
          );
        })
        .catch((err) => {
          console.error(
            `[Lazy Migration] ❌ Failed to migrate "${bucketName}":`,
            err,
          );
        });
    }

    return {
      exists: true,
      config: { ...data, secret_access_key: decryptedSecret },
    };
  } catch (err) {
    return {
      exists: true,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

async function testBucket(
  phoneNumber: string,
  bucketName: string,
): Promise<string> {
  const s3 = await requireS3Client(phoneNumber, bucketName);
  if (!s3.ok) return s3.errorJson;

  try {
    // Try listing up to 1 object to verify read access
    try {
      const response = await s3.client.send(
        new ListObjectsV2Command({ Bucket: bucketName, MaxKeys: 1 }),
      );
      const count = response.KeyCount ?? 0;
      return JSON.stringify({
        success: true,
        message: `Read access confirmed for "${bucketName}"`,
        has_objects: count > 0,
      });
    } catch {
      // Fallback to v1 for providers that don't support v2
      const response = await s3.client.send(
        new ListObjectsCommand({ Bucket: bucketName, MaxKeys: 1 }),
      );
      const count = (response.Contents ?? []).length;
      return JSON.stringify({
        success: true,
        message: `Read access confirmed for "${bucketName}" (v1 API)`,
        has_objects: count > 0,
      });
    }
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: `Cannot read bucket "${bucketName}": ${(err as Error).message}`,
    });
  }
}

async function listObjects(
  phoneNumber: string,
  bucketName: string,
  prefix?: string,
  limit = 100,
): Promise<string> {
  const s3 = await requireS3Client(phoneNumber, bucketName);
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
    return JSON.stringify({
      error: `Failed to list objects: ${(err as Error).message}`,
    });
  }
}

async function countObjects(
  phoneNumber: string,
  bucketName: string,
  prefix?: string,
): Promise<string> {
  const s3 = await requireS3Client(phoneNumber, bucketName);
  if (!s3.ok) return s3.errorJson;

  try {
    const allObjects = await listS3Objects(s3.client, bucketName, prefix ?? "");

    // Group by content type
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
    return JSON.stringify({
      error: `Failed to count objects: ${(err as Error).message}`,
    });
  }
}

const IMAGE_MIME_PREFIXES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

async function indexBucket(
  phoneNumber: string,
  bucketName: string,
  prefix?: string,
  batchSize = 10,
): Promise<string> {
  const s3 = await requireS3Client(phoneNumber, bucketName);
  if (!s3.ok) return s3.errorJson;

  try {
    // List all objects in bucket
    const allObjects = await listS3Objects(s3.client, bucketName, prefix ?? "");

    // Get already-watched keys to find new ones
    const watchedKeys = await getWatchedKeys();
    const newObjects = allObjects.filter((o) => !watchedKeys.has(o.key));

    // Take only batch_size items
    const batch = newObjects.slice(0, batchSize);

    let indexed = 0;
    let enriched = 0;
    const errors: string[] = [];

    for (const obj of batch) {
      try {
        const eventId = newEventId();
        const contentType = detectContentType(obj.key);
        const mimeType = getMimeType(obj.key);

        // Create event
        await insertEvent({
          id: eventId,
          device_id: `whatsapp:${phoneNumber}`,
          type: "create",
          content_type: contentType,
          content_hash: `etag:${obj.etag}`,
          local_path: null,
          remote_path: `s3://${bucketName}/${obj.key}`,
          metadata: s3Metadata(obj.key, obj.size, obj.etag),
          parent_id: null,
          bucket_config_id: s3.config.id,
        });

        // Track watched key
        await upsertWatchedKey(obj.key, eventId, obj.etag, obj.size);
        indexed++;

        // Enrich if it's an image we can analyze
        if (IMAGE_MIME_PREFIXES.includes(mimeType)) {
          try {
            const imageBytes = await downloadS3Object(
              s3.client,
              bucketName,
              obj.key,
            );
            const result = await enrichImage(imageBytes, mimeType);
            await insertEnrichment(eventId, result);
            enriched++;
          } catch (enrichErr) {
            // Log enrichment failure but don't fail the whole batch
            await insertEvent({
              id: newEventId(),
              device_id: `whatsapp:${phoneNumber}`,
              type: "enrich_failed",
              content_type: contentType,
              content_hash: null,
              local_path: null,
              remote_path: `s3://${bucketName}/${obj.key}`,
              metadata: { error: (enrichErr as Error).message },
              parent_id: eventId,
            });
          }
        }
      } catch (err) {
        errors.push(`${obj.key}: ${(err as Error).message}`);
      }
    }

    return JSON.stringify({
      bucket: bucketName,
      total_objects: allObjects.length,
      already_indexed: allObjects.length - newObjects.length,
      remaining: newObjects.length - batch.length,
      batch_indexed: indexed,
      batch_enriched: enriched,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    return JSON.stringify({
      error: `Failed to index bucket: ${(err as Error).message}`,
    });
  }
}

// ── Conversation history ───────────────────────────────────────

export async function getConversationHistory(
  phone: string,
): Promise<Message[]> {
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
  history: Message[],
): Promise<void> {
  const supabase = getSupabaseClient();
  const trimmed = history.slice(-20);

  await supabase.from("conversations").upsert({
    phone_number: phone,
    history: trimmed,
    updated_at: new Date().toISOString(),
  });
}
