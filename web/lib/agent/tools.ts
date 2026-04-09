/**
 * Tool definitions and dispatch for the web chat agent.
 *
 * Tools are exposed to Claude via the Anthropic tool use API.
 * They execute against real Supabase queries scoped to the authenticated user.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { queryEvents, getStats, showEvent } from "@/lib/media/db";

// ── Tool definitions ───────────────────────────────────────────

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "query_media",
    description:
      "Search and filter the user's media events (photos, videos, audio, documents). " +
      "Use this to answer questions like 'show me my flamingo photos' or 'what did I upload last week'. " +
      "Results include enrichment data (descriptions, tags, detected objects) when available.",
    input_schema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description:
            "Optional full-text search query matched against enrichment descriptions, tags, objects, and context.",
        },
        content_type: {
          type: "string",
          description:
            "Optional content type filter (e.g. 'photo', 'video', 'audio', 'document').",
        },
        since: {
          type: "string",
          description: "Optional ISO 8601 date — return events at or after this time.",
        },
        until: {
          type: "string",
          description: "Optional ISO 8601 date — return events at or before this time.",
        },
        limit: {
          type: "integer",
          description: "Max results to return (default 20, max 100).",
        },
      },
    },
  },
  {
    name: "get_stats",
    description:
      "Get aggregate statistics for the user's media library: total event count, " +
      "enriched count, pending enrichment, and breakdown by content type. " +
      "Use this for questions like 'how many photos do I have' or 'what's in my library'.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "show_media",
    description:
      "Fetch full details for a specific media event by id, including its enrichment " +
      "(description, detected objects, context, tags). Use this after query_media to get " +
      "more detail on a particular item.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The event id to fetch.",
        },
      },
      required: ["id"],
    },
  },
];

// ── Tool dispatch ──────────────────────────────────────────────

export interface ToolContext {
  client: SupabaseClient;
  userId: string;
}

/**
 * Execute a tool call and return the result as a JSON string.
 *
 * Errors are returned as `{ error: "..." }` JSON strings rather than thrown —
 * the model should see tool failures as tool_result content so it can explain
 * them to the user.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  try {
    switch (name) {
      case "query_media": {
        const result = await queryEvents(ctx.client, {
          userId: ctx.userId,
          search: typeof input.search === "string" ? input.search : undefined,
          type:
            typeof input.content_type === "string"
              ? input.content_type
              : undefined,
          since: typeof input.since === "string" ? input.since : undefined,
          until: typeof input.until === "string" ? input.until : undefined,
          limit: typeof input.limit === "number" ? input.limit : 20,
        });
        if (result.error) {
          return JSON.stringify({
            error: (result.error as Error).message ?? String(result.error),
          });
        }
        return JSON.stringify({
          results: result.data,
          count: result.count,
        });
      }

      case "get_stats": {
        const result = await getStats(ctx.client, { userId: ctx.userId });
        if (result.error) {
          return JSON.stringify({
            error: (result.error as Error).message ?? String(result.error),
          });
        }
        return JSON.stringify(result.data);
      }

      case "show_media": {
        const id = input.id;
        if (typeof id !== "string" || !id) {
          return JSON.stringify({ error: "id is required" });
        }
        const result = await showEvent(ctx.client, id, ctx.userId);
        if (result.error) {
          return JSON.stringify({
            error: (result.error as Error).message ?? String(result.error),
          });
        }
        if (!result.data) {
          return JSON.stringify({ error: "Media item not found" });
        }
        return JSON.stringify(result.data);
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
