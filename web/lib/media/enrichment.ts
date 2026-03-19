/**
 * LLM-based media enrichment via Anthropic Claude
 */

import Anthropic from "@anthropic-ai/sdk";
import pLimit from "p-limit";
import { ENRICHMENT_PROMPT } from "./constants";
import { createLogger, LogComponent } from "@/lib/logger";
import { validateImage } from "./validation";

const logger = createLogger(LogComponent.Enrichment);

export interface EnrichmentResult {
  description: string;
  objects: string[];
  context: string;
  suggested_tags: string[];
  provider: string;
  model: string;
  raw_response: string;
}

export interface BatchEnrichmentItem {
  key: string;
  imageBytes: Buffer;
  mimeType: string;
}

export interface BatchEnrichmentResult {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: Array<{ key: string; error: string }>;
}

let _client: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ maxRetries: 3 });
  }
  return _client;
}

/** Reset the singleton — for tests only */
export function _resetAnthropicClient(): void {
  _client = null;
}

function coerceToStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

function parseJsonResponse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  // 1. Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue to fence extraction
  }

  // 2. Look for markdown fence
  const fenceStart = trimmed.indexOf("```");
  if (fenceStart === -1) return null;

  const afterFence = trimmed.indexOf("\n", fenceStart);
  if (afterFence === -1) return null;

  const fenceEnd = trimmed.indexOf("```", afterFence + 1);
  if (fenceEnd === -1) return null;

  const content = trimmed.slice(afterFence + 1, fenceEnd).trim();

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function buildEmptyResult(rawResponse: string): EnrichmentResult {
  return {
    description: "",
    objects: [],
    context: "",
    suggested_tags: [],
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    raw_response: rawResponse,
  };
}

export async function enrichImage(
  imageBytes: Buffer,
  mimeType: string,
): Promise<EnrichmentResult> {
  // Normalize mime type
  const normalizedMime = mimeType === "image/jpg" ? "image/jpeg" : mimeType;

  // Pre-enrichment validation
  const validation = validateImage(imageBytes, normalizedMime);
  if (!validation.valid) {
    logger.warn("skipping enrichment: image validation failed", {
      errors: validation.errors,
      image_size_bytes: imageBytes.length,
      mime_type: mimeType,
    });
    return buildEmptyResult("");
  }

  if (validation.warnings.length > 0) {
    logger.info("image validation warnings", {
      warnings: validation.warnings,
      image_size_bytes: imageBytes.length,
    });
  }

  const client = getAnthropicClient();
  const b64 = imageBytes.toString("base64");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: normalizedMime as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: b64,
            },
          },
          { type: "text", text: ENRICHMENT_PROMPT },
        ],
      },
    ],
  });

  const rawResponse =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Token and cost logging
  if (response.usage) {
    logger.info("enrichment complete", {
      model: response.model,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      image_size_bytes: imageBytes.length,
    });
  } else {
    logger.warn("enrichment API response missing usage field", {
      model: response.model,
    });
  }

  const parsed = parseJsonResponse(rawResponse);

  if (!parsed) {
    logger.warn("enrichment response could not be parsed", {
      raw_response_preview: rawResponse.slice(0, 500),
    });
    return buildEmptyResult(rawResponse);
  }

  return {
    description: String(parsed.description ?? ""),
    objects: coerceToStringArray(parsed.objects),
    context: String(parsed.context ?? ""),
    suggested_tags: coerceToStringArray(parsed.suggested_tags),
    provider: "anthropic",
    model: response.model ?? "claude-haiku-4-5-20251001",
    raw_response: rawResponse,
  };
}

export async function batchEnrichImages(
  items: BatchEnrichmentItem[],
  options?: { concurrency?: number },
): Promise<BatchEnrichmentResult> {
  const limit = pLimit(options?.concurrency ?? 3);
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const errors: Array<{ key: string; error: string }> = [];

  const tasks = items.map((item) =>
    limit(async () => {
      try {
        const result = await enrichImage(item.imageBytes, item.mimeType);
        if (result.description === "") {
          skipped++;
        } else {
          succeeded++;
        }
        return result;
      } catch (err: unknown) {
        failed++;
        errors.push({
          key: item.key,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );

  await Promise.all(tasks);

  const result: BatchEnrichmentResult = {
    total: items.length,
    succeeded,
    failed,
    skipped,
    errors,
  };

  logger.info("batch enrichment complete", {
    total: result.total,
    succeeded: result.succeeded,
    failed: result.failed,
    skipped: result.skipped,
  });

  return result;
}
