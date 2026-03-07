/**
 * LLM-based media enrichment via Anthropic Claude
 */

import Anthropic from "@anthropic-ai/sdk";
import { ENRICHMENT_PROMPT } from "./constants";

export interface EnrichmentResult {
  description: string;
  objects: string[];
  context: string;
  suggested_tags: string[];
  provider: string;
  model: string;
  raw_response: string;
}

function parseJsonResponse(text: string): Record<string, unknown> {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.split("\n", 2)[1];
    cleaned = cleaned.split("```")[0];
  }
  return JSON.parse(cleaned);
}

export async function enrichImage(
  imageBytes: Buffer,
  mimeType: string
): Promise<EnrichmentResult> {
  const client = new Anthropic();
  const b64 = imageBytes.toString("base64");

  // Normalize mime type
  const mediaType = mimeType === "image/jpg" ? "image/jpeg" : mimeType;

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
              media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
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
  const result = parseJsonResponse(rawResponse);

  return {
    description: (result.description as string) ?? "",
    objects: (result.objects as string[]) ?? [],
    context: (result.context as string) ?? "",
    suggested_tags: (result.suggested_tags as string[]) ?? [],
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    raw_response: rawResponse,
  };
}
