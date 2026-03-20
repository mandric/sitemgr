# Combined Spec: smgr Integration Testing

## Goal

Build an end-to-end integration test that exercises the full smgr CLI pipeline: **upload images to S3 → discover via watch → enrich with a real vision model → query results with semantic search assertions**. This validates that all layers (S3, DB, CLI, enrichment) work together, catching regressions that isolated tests miss.

## Architecture Decisions

### Model Configuration: DB-stored in `model_configs` table

Instead of env vars, model configuration lives in a new `model_configs` table with `user_id` FK. The CLI loads config once at startup and passes it through to enrichment calls. This is the same code path production users will use.

**Fallback:** When no `model_configs` row exists for a user, fall back to the current Anthropic Claude Haiku default. This maintains backward compatibility.

### Test Fixtures: Real photos committed to repo

Three small JPEGs (~10-50KB each) from open-license sources:
- **pineapple.jpg** — clearly identifiable fruit
- **dog.jpg** — clearly identifiable animal
- **beach.jpg** — clearly identifiable water/beach scene

These are committed to `web/__tests__/integration/fixtures/`.

### Ollama: Always required, added to docker-compose.yml

The test always requires Ollama with a vision model. Fail fast if unavailable. Ollama is added as a service to the existing `docker-compose.yml`, making it available for both dev and CI.

### Error Handling: Retry then fail

When the model endpoint is unreachable, retry 2-3 times with backoff per image, then fail with exit code 2 (service error).

## Test Flow

### Prerequisites
- Supabase running (local)
- Ollama running with a vision model (moondream or llava)
- S3 storage accessible (Supabase Storage)

### Steps

1. **Setup**
   - Create test user via `createTestUser()`
   - Insert `model_configs` row pointing enrichment at local Ollama (`http://localhost:11434/v1`, model `moondream`)
   - Create S3 bucket, upload 3 fixture images (pineapple, dog, beach)

2. **`smgr watch --once`**
   - Run with `SMGR_S3_BUCKET` pointing at test bucket, `SMGR_AUTO_ENRICH=false`
   - Discovers 3 images, creates event records and watched_keys

3. **Verify indexing**
   - `smgr stats` → assert `total_events` = 3, `pending_enrichment` = 3

4. **`smgr enrich --dry-run`**
   - Assert pending list contains all 3 event IDs

5. **`smgr enrich --pending`**
   - Run against local Ollama via model_configs
   - Model generates descriptions for each image

6. **Semantic search assertions**
   ```typescript
   // Positive assertions
   "fruit" search → includes pineapple event
   "animal" or "dog" search → includes dog event
   "water" or "beach" search → includes beach event

   // Negative assertions
   "animal" search → does NOT include pineapple event
   "fruit" search → does NOT include dog event
   "snow" search → does NOT include beach event
   ```

7. **Final stats verification**
   - `smgr stats` → `enriched` = 3, `pending_enrichment` = 0

8. **Cleanup**
   - Delete uploaded S3 objects
   - `cleanupUserData()` removes all DB records

## Database Migration: `model_configs` table

```sql
CREATE TABLE model_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'anthropic',
  base_url text,           -- NULL means use provider default
  model text NOT NULL,     -- e.g. 'claude-haiku-4-5-20251001', 'moondream'
  api_key_encrypted text,  -- encrypted API key (NULL for local models)
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Only one active config per user per provider
CREATE UNIQUE INDEX model_configs_user_provider_active
  ON model_configs (user_id, provider)
  WHERE is_active = true;

-- RLS
ALTER TABLE model_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own model configs"
  ON model_configs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own model configs"
  ON model_configs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own model configs"
  ON model_configs FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own model configs"
  ON model_configs FOR DELETE
  USING (auth.uid() = user_id);

-- Service role bypass for CLI operations
CREATE POLICY "Service role full access"
  ON model_configs FOR ALL
  USING (auth.role() = 'service_role');
```

## Docker Compose Addition

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  ollama-data:
```

After Ollama starts, pull the model: `docker exec ollama ollama pull moondream`

## CI Pipeline Changes

Add to `.github/workflows/ci.yml`:
1. Start Ollama service (via docker-compose or direct install)
2. Pull moondream model (cache `~/.ollama/models/` between runs)
3. Wait for Ollama health check
4. Set `SMGR_OLLAMA_URL=http://localhost:11434` for tests

## Enrichment Code Changes

### `web/lib/media/enrichment.ts` modifications:

1. **New function:** `loadModelConfig(userId: string): Promise<ModelConfig | null>`
   - Reads from `model_configs` table where `is_active = true`
   - Returns `{ provider, baseUrl, model, apiKey }` or null (use defaults)

2. **Modified:** `enrichImage()` accepts optional `ModelConfig` parameter
   - When config has `baseUrl` set, use OpenAI-compatible client pointed at that URL
   - When config is null/undefined, use current Anthropic default
   - Image data must be formatted as `data:image/{type};base64,{base64}` for OpenAI-compatible endpoints

3. **CLI startup:** `smgr` main reads model config once, passes to enrichment calls

## Files to Create/Modify

### New files:
- `web/__tests__/integration/smgr-e2e.test.ts` — the integration test
- `web/__tests__/integration/fixtures/pineapple.jpg` — test image
- `web/__tests__/integration/fixtures/dog.jpg` — test image
- `web/__tests__/integration/fixtures/beach.jpg` — test image
- `supabase/migrations/XXXXXX_create_model_configs.sql` — DB migration

### Modified files:
- `web/lib/media/enrichment.ts` — configurable model endpoint
- `web/lib/media/db.ts` — add `getModelConfig()` query function
- `web/bin/smgr.ts` — load model config at startup
- `docker-compose.yml` — add Ollama service
- `.github/workflows/ci.yml` — add Ollama to CI

## Existing Infrastructure to Reuse

- `createTestUser()`, `cleanupUserData()` from `setup.ts`
- `getS3Config()`, `createS3Client()`, `uploadS3Object()` from `setup.ts`
- `runCli()` + `cliEnv()` pattern from `smgr-cli.test.ts`
- Vitest integration project config (sequential, 60s timeout)
- `getAdminClient()` for service-role DB operations (insert model_configs)

## Not in Scope

- Testing `add-bucket` / `test-bucket` / `index-bucket` (agent actions, not CLI)
- Chat agent layer testing
- Embedding-based semantic similarity (overkill; Postgres full-text search suffices)
- Model benchmarking (we test the pipeline, not model quality)
