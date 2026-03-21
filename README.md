# sitemgr

Media management system with LLM enrichment and WhatsApp bot interface.

## Quick Start

```bash
# 1. Run setup (installs Node.js dependencies)
./scripts/setup.sh

# 2. Start Supabase and configure
./scripts/local-dev.sh

# 3. Load environment variables
source .env.local

# 4. Run the CLI
cd web && npm run smgr stats

# 5. Run tests
cd web && npm test
```

## Prerequisites

- **Node.js 20+** - JavaScript runtime ([install guide](https://nodejs.org/))
- **Supabase CLI** - Local development environment ([install guide](https://supabase.com/docs/guides/cli))
- **Docker** or **Colima** - For running Supabase locally
- **jq** - JSON processor (`brew install jq`)

## Project Structure

```
sitemgr/
├── web/               # Next.js app + TypeScript CLI
│   ├── bin/smgr.ts   # CLI tool (query, watch, enrich, stats)
│   ├── lib/media/    # Core media processing library
│   ├── app/          # Next.js web UI
│   └── __tests__/    # Unit tests (Vitest)
├── supabase/          # Database + Edge Functions
│   ├── migrations/    # Database schema
│   └── functions/     # Edge Functions (TypeScript)
├── scripts/           # Development scripts
│   ├── setup.sh       # First-time setup
│   ├── local-dev.sh   # Start local environment
│   └── deploy.sh      # Manual deployment
├── tests/             # Integration tests
└── design/            # Architecture docs
```

## What It Does

1. **Watches S3 bucket** for new photos/videos
2. **Enriches media** using LLM (Claude) - descriptions, tags, objects
3. **Indexes content** in Postgres with full-text search
4. **WhatsApp bot** - Natural language queries ("show me photos from last week")
5. **Event-driven** - Append-only event log for all actions

## Architecture

- **Event Store**: Supabase Postgres (append-only log)
- **Storage**: Supabase Storage (S3-compatible)
- **Enrichment**: BYO LLM (Anthropic)
- **Query**: Postgres FTS (tsvector + GIN)
- **Bot**: Supabase Edge Function + Twilio WhatsApp
- **Web UI**: Next.js + Supabase Auth

See [design/architecture.md](design/architecture.md) for details.

## Development

### CLI Usage

```bash
cd web

# Check database stats
npm run smgr stats

# Query events
npm run smgr query -- --search "beach" --format json

# Watch for new S3 objects
npm run smgr watch

# Enrich pending items
npm run smgr enrich -- --pending
```

### Local Testing

```bash
# Start environment
./scripts/local-dev.sh
source .env.local

# Run unit tests
cd web && npm test

# Run E2E tests
cd web && npm run test:e2e

# Run integration tests
./scripts/test-integration.sh --skip-ollama
```

### Deployment

```bash
# Deploy to Supabase (staging)
git push origin develop

# Deploy to production
git push origin main
```

See [INTEGRATION_TESTS_SETUP.md](INTEGRATION_TESTS_SETUP.md) for complete setup guide.

## Documentation

- [INTEGRATION_TESTS_SETUP.md](INTEGRATION_TESTS_SETUP.md) - Quick start guide
- [docs/TESTING.md](docs/TESTING.md) - Testing strategy
- [design/vision.md](design/vision.md) - Project vision
- [design/architecture.md](design/architecture.md) - System architecture
- [docs/TESTING.md](docs/TESTING.md) - Testing strategy and test runner docs
