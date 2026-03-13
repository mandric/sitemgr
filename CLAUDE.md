## Maintenance

Update this file when architectural decisions, project structure, or conventions change.

## Project Overview

Media management system with LLM enrichment. Captures photos/videos, enriches them with AI metadata (Claude vision API), and makes them searchable via WhatsApp bot, CLI (`smgr`), or web dashboard.

## Project Structure

```
web/                        # Next.js app + CLI + all TypeScript source
  bin/smgr.ts               # CLI entry point (query, stats, enrich, watch)
  lib/media/                # Core: S3 client, DB operations, enrichment pipeline
  lib/agent/                # AI agent: planAction → executeAction → summarizeResult
  app/api/whatsapp/route.ts # WhatsApp webhook (Twilio → Vercel API route)
  app/api/health/route.ts   # Health check endpoint
  __tests__/                # Vitest unit tests
  e2e/                      # Playwright E2E tests
supabase/migrations/        # Postgres schema (append-only event store)
tests/                      # Integration tests (shell scripts, need Supabase local)
scripts/                    # setup.sh, local-dev.sh, deploy.sh
```

## Common Commands

All run from `web/`:

```bash
npm test              # Unit tests (Vitest)
npm run lint          # ESLint
npm run build         # Next.js build
npm run test:e2e      # Playwright E2E
npx tsx bin/smgr.ts   # CLI (query, stats, enrich, watch)
```

## Key Decisions

### v1 is cloud-based (not local-first)

- **Supabase Postgres** is the event store (not per-device SQLite)
- **Supabase Storage** (S3-compatible) for media (not BYO S3 — that's backlog)
- **Online required** — no offline support in v1
- **Vercel API route** for the WhatsApp bot webhook handler (`web/app/api/whatsapp/route.ts`)
- Local-first/offline with SQLite is deferred to a future version

### Architectural constraints

- Event store is **append-only** — never UPDATE or DELETE events
- Content is **content-addressed** (SHA-256 hashing, no duplicates)
- Enrichment is async and retryable — `enrich_failed` events can be retried later
- Agent follows a 3-phase pattern: `planAction → executeAction → summarizeResult`
- RLS (Row Level Security) enforced — all tables have `user_id` columns

### Backlog items (not v1 scope)

- BYO S3-compatible storage (any provider, not just Supabase)
- Local-first / offline mode with per-device SQLite
- Enrichment metadata as sidecar files in S3 (post-prototype idea)

## Conventions

- All source is TypeScript. The `web/` directory is the main (and only) package.
- App env vars: `SMGR_*` prefix. Supabase client vars: `NEXT_PUBLIC_SUPABASE_*`
- Database changes go through Supabase migrations in `supabase/migrations/`
- Unit tests mock all external services (Supabase, Anthropic, S3) — never call real APIs
- Integration tests (`tests/`) are shell scripts that require `supabase start` running locally
