# sitemgr

[![CI](https://github.com/mandric/sitemgr/actions/workflows/ci.yml/badge.svg)](https://github.com/mandric/sitemgr/actions/workflows/ci.yml)

Media management system with LLM enrichment and WhatsApp bot interface.

## Prerequisites

- **Node.js 20+** — [nodejs.org](https://nodejs.org/)
- **Docker** or **Colima** — for running Supabase locally
- **Supabase CLI** — `brew install supabase/tap/supabase`
- **Ollama** — [ollama.com](https://ollama.com)
- **jq** — `brew install jq`

## Getting Started

```bash
cd web
npm install
npm run setup   # check prereqs, start Supabase, pull Ollama model, generate .env.local
```

Then in separate terminals:

```bash
npm run start:supabase   # Supabase (start + migrations + log tail)
npm run start:ollama     # Ollama server
npm run dev              # Next.js dev server
```

## Running Tests

```bash
cd web
npm test                  # unit tests (no services required)
npm run test:integration  # integration tests (requires npm run setup first)
npm run test:e2e          # E2E browser tests (requires all services running)
```

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run setup` | Full setup: Supabase + Ollama + `.env.local` (run once, returns) |
| `npm run setup:supabase` | Check prereqs, start Supabase, apply migrations |
| `npm run setup:ollama` | Pull Ollama model (moondream:1.8b) |
| `npm run setup:env` | Regenerate `.env.local` from running Supabase instance |
| `npm run start:supabase` | Setup + tail Supabase container logs (foreground) |
| `npm run start:ollama` | Start Ollama server (foreground) |
| `npm run dev` | Start Next.js dev server (foreground) |

## Resetting

```bash
supabase db reset       # wipe local DB and replay migrations
npm run setup:env       # regenerate .env.local after reset
```

## Project Structure

```
sitemgr/
├── web/                  # Next.js app + TypeScript CLI
│   ├── bin/sitemgr.ts    # CLI tool (query, watch, enrich, stats)
│   ├── lib/              # Core library (db, crypto, media, s3)
│   ├── app/              # Next.js web UI + API routes
│   └── __tests__/        # Tests (unit, integration, e2e)
├── supabase/             # Local Supabase config + migrations
│   └── migrations/       # Database schema
└── scripts/              # Dev and CI shell helpers (lib.sh, init.sh)
```

## Documentation

- [docs/TESTING.md](docs/TESTING.md) — Testing strategy and test tiers
- [docs/WORKFLOW.md](docs/WORKFLOW.md) — Development and deployment workflow
- [docs/ENV_VARS.md](docs/ENV_VARS.md) — Environment variables and key rotation
