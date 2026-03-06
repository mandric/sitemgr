# sitemgr

Media management system with LLM enrichment and WhatsApp bot interface.

## Quick Start

```bash
# 1. Install uv (Python package manager)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Run setup (creates venv + installs dependencies)
./scripts/setup.sh

# 3. Activate environment
source .venv/bin/activate

# 4. Start Supabase and configure
./scripts/local-dev.sh

# 5. Load environment variables
source .env.local

# 6. Run tests
./tests/integration_test.sh

# 7. Try the CLI
python3 prototype/smgr.py stats
```

## Prerequisites

- **uv** - Fast Python package installer ([install guide](https://docs.astral.sh/uv/))
- **Supabase CLI** - Local development environment ([install guide](https://supabase.com/docs/guides/cli))
- **Docker** or **Colima** - For running Supabase locally
- **jq** - JSON processor (`brew install jq`)

## Project Structure

```
sitemgr/
├── prototype/          # Python CLI + bot
│   ├── smgr.py        # Main CLI tool
│   └── bot.py         # WhatsApp bot agent
├── supabase/          # Database + Edge Functions
│   ├── migrations/    # Database schema
│   └── functions/     # Edge Functions (TypeScript)
├── scripts/           # Development scripts
│   ├── setup.sh       # First-time setup
│   └── local-dev.sh   # Start local environment
├── tests/             # Integration tests
└── design/            # Architecture docs
```

## What It Does

1. **Watches S3 bucket** for new photos/videos
2. **Enriches media** using LLM (Claude/GPT/Gemini) - descriptions, tags, objects
3. **Indexes content** in Postgres with full-text search
4. **WhatsApp bot** - Natural language queries ("show me photos from last week")
5. **Event-driven** - Append-only event log for all actions

## Architecture

- **Event Store**: Supabase Postgres (append-only log)
- **Storage**: Supabase Storage (S3-compatible)
- **Enrichment**: BYO LLM (Anthropic/OpenAI/Gemini)
- **Query**: Postgres FTS (tsvector + GIN)
- **Bot**: Supabase Edge Function + Twilio WhatsApp

See [design/architecture.md](design/architecture.md) for details.

## Development

### Local Testing

```bash
# Start environment
source .venv/bin/activate
./scripts/local-dev.sh
source .env.local

# Run tests
./tests/integration_test.sh

# Seed test data
./tests/seed_test_data.sh

# Watch for changes
python3 prototype/smgr.py watch

# Interactive bot
python3 prototype/bot.py --stdio
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
- [tests/README.md](tests/README.md) - Test documentation

## Contributing

This is currently a prototype. See [design/vision.md](design/vision.md) for roadmap.

## License

[To be determined]
