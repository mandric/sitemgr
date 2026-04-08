# 22-web-agent-tool-use — Spec

## Overview

Replace the web chat agent's static context injection with Anthropic native tool use. Claude decides when to call tools (`query_media`, `get_stats`, `show_media`) based on the conversation, executes real DB queries, and incorporates live results into its response. This turns the agent from a chatbot with static snapshots into a real query interface.

## Background

The current web agent (`sendMessageToAgent`) prepends a static context string (bucket count, media stats) to every user message. Claude can describe what it was told but cannot query anything. If a user asks "show me my flamingo photos", Claude can only reference the total media count — it cannot search.

The WhatsApp agent has a plan→execute→summarize flow that does execute real queries, but it uses a clunky multi-call pattern and is not exposed to the web chat.

## Requirements

### Tool Definitions

Expose the following tools to Claude via the Anthropic tool use API:

**`query_media`**
- Description: Search and filter media events
- Parameters: `search` (string, optional), `content_type` (string, optional), `since` (ISO date, optional), `until` (ISO date, optional), `limit` (integer, default 20)
- Implementation: calls `queryEvents` from `lib/media/db.ts`

**`get_stats`**
- Description: Get media library statistics (total, enriched, pending, by content type)
- Parameters: none
- Implementation: calls `getStats` from `lib/media/db.ts`

**`show_media`**
- Description: Get details for a specific media item including enrichment
- Parameters: `id` (string, required)
- Implementation: calls `showEvent` from `lib/media/db.ts`

### Agent Flow

Replace `sendMessageToAgent` with a tool-use-aware implementation:

1. Call Claude with tool definitions and conversation history
2. If Claude returns a `tool_use` block, execute the tool with the user's Supabase client
3. Send the tool result back to Claude as a `tool_result` message
4. Repeat until Claude returns a final `text` response (no more tool calls)
5. Return the final text

This is a synchronous loop (not streaming). Max iterations: 5 (guard against runaway tool chaining).

### Context

Remove the static context prefix injection from `actions.ts`. Claude will get live data via tools instead. Keep the system prompt's guidance on directing users to the UI for configuration tasks.

### Conversation History

Wire the `userId` parameter (currently unused in `ChatInterface`) through to `getConversationHistory` and `saveConversationHistory`. History should be stored and retrieved per user, not per phone number.

### Server Action

Update `components/agent/actions.ts`:
- Accept `userId` from the authenticated session (already available)
- Pass `userId` to `sendMessageToAgent` so tools can be scoped to the right user
- Remove static context prefix construction
- Keep history load/save

### System Prompt

Update `AGENT_SYSTEM_PROMPT` to:
- Remove the static context section (no longer injected)
- Tell Claude it has tools available and should use them to answer media questions
- Keep the UI-redirect guidance for configuration tasks
- Keep the markdown link examples

## Scope Boundaries

**In scope:**
- Web chat agent tool use
- `query_media`, `get_stats`, `show_media` tools
- Wire userId for conversation history
- Integration test: tool execution against real local Supabase
- E2E test: ask agent a media query, assert real results appear

**Out of scope:**
- WhatsApp agent (leave plan/execute/summarize unchanged)
- Streaming responses
- Tool use for bucket configuration (redirect to UI)
- Write tools (create, delete, update media)

## Key Files

- `web/lib/agent/core.ts` — replace `sendMessageToAgent` with tool-use loop
- `web/lib/agent/tools.ts` — new file: tool definitions and execution dispatch
- `web/lib/agent/system-prompt.ts` — update `AGENT_SYSTEM_PROMPT`
- `web/components/agent/actions.ts` — remove context injection, pass userId
- `web/components/agent/chat-interface.tsx` — pass userId to server action
- `web/__tests__/integration/agent-tools.test.ts` — new integration tests

## Dependencies

**Depends on:**
- 01-data-foundation (`queryEvents`, `getStats`, `showEvent`, `conversations` table)
- 04-web-application (chat UI already exists)

## Key Decisions

- Use Anthropic's native tool use API (not the plan/execute/summarize pattern)
- Tools are read-only — no write operations via chat
- Tool execution is server-side only (server action), tools are scoped to authenticated user
- Max 5 tool call iterations per message to prevent runaway loops
- No streaming in v1 — single response when all tool calls complete
