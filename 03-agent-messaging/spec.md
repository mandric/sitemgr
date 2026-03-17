# 03-agent-messaging — Spec

## Overview

Claude-powered agent with plan/execute/summarize flow for natural language media queries. Exposed via WhatsApp bot (Twilio webhook) and web chat interface. Manages multi-turn conversation history.

## Requirements Reference

See `REQUIREMENTS.md` sections: Core Features §5 (WhatsApp Bot).

## Scope

### Agent Core
- **Plan** — Claude analyzes user message, returns structured JSON action (search, stats, show, etc.)
- **Execute** — Dispatch action to database/S3 operations (search_events, stats queries, etc.)
- **Summarize** — Claude formats execution results into human-readable response
- Natural language understanding for media queries (e.g., "what did I photograph this week?")

### WhatsApp Bot
- Twilio webhook handler as Vercel API route (`/api/whatsapp`)
- Twilio request signature validation
- Message routing and WhatsApp-formatted response
- Multi-turn conversation history stored in `conversations` table (JSONB array)

### Web Chat (agent API surface)
- Agent API consumed by web chat interface (04-web-application owns the UI)
- Server actions for sending messages

## Implementation Status

**Fully implemented** with minor gaps:
- Agent core plan/execute/summarize flow works
- WhatsApp webhook handler fully functional
- **Gap:** Web chat agent doesn't receive user context (buckets, media stats)
- **Gap:** Conversation history not fully wired for web chat userId

### Key Files
- `web/lib/agent/core.ts` — Agent plan/execute/summarize logic
- `web/app/api/whatsapp/route.ts` — Twilio webhook handler
- `web/components/agent/actions.ts` — Server actions for web chat
- `web/__tests__/agent-core.test.ts` — Agent logic tests
- `web/__tests__/whatsapp-route.test.ts` — Webhook handler tests

## Dependencies

**Depends on:**
- 01-data-foundation (conversations table, Supabase client)
- 02-media-pipeline (search_events RPC, media operations for action execution)

**Provides to:**
- 04-web-application (agent API for chat interface)

## Key Decisions
- Migrated from Supabase Edge Functions to Vercel API routes
- Plan/execute/summarize is a single-turn cycle (not streaming)
- Conversation history is per-phone-number (WhatsApp) or per-user (web)
