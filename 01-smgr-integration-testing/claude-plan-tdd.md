# TDD Plan: smgr Integration Testing

This companion document defines what tests to write BEFORE implementing each section of the plan.

**Testing framework:** Vitest (integration project)
**Test location:** `web/__tests__/integration/`
**Existing patterns:** `smgr-cli.test.ts` (runCli, cliEnv), `setup.ts` (helpers)
**Config:** Sequential execution, 60s test timeout (overridable per-test), 30s hook timeout

---

## Section 1: Database Migration — `model_configs` Table

### Tests to write before migration

```
# Test: model_configs table exists after migration
# Test: can insert a row with all required fields (user_id, provider, model)
# Test: can insert a row with nullable fields (base_url, api_key_encrypted) as NULL
# Test: unique index prevents two active configs for same user+provider
# Test: unique index allows inactive + active config for same user+provider
# Test: ON DELETE CASCADE removes config when auth user is deleted
# Test: RLS prevents user A from reading user B's config (using user client, not admin)
# Test: service role can read/write all configs
```

These can be added to the existing `schema-contract.test.ts` or a new `model-configs.test.ts`.

---

## Section 2: Enrichment Code — Configurable Model Endpoint

### Tests to write before enrichment changes

```
# Test: enrichImage() with no config calls Anthropic path (existing behavior unchanged)
# Test: enrichImage() with config.baseUrl calls fetch to that URL
# Test: enrichImage() with config formats image as data:image/{mime};base64,{data} in request
# Test: enrichImage() with config uses simple prompt, not structured JSON prompt
# Test: enrichImage() with config puts response text into description field
# Test: enrichImage() with config sets objects and suggested_tags to empty arrays
# Test: enrichImage() with config sets provider and model from config values
# Test: enrichImage() with config retries on 503 (up to 3 times)
# Test: enrichImage() with config does NOT retry on 400
# Test: enrichImage() with config retries on ECONNREFUSED
# Test: buildEmptyResult() with config returns correct provider/model
# Test: buildEmptyResult() without config returns "anthropic" (backward compat)
# Test: getModelConfig() returns active config for user
# Test: getModelConfig() returns null when no config exists
# Test: getModelConfig() ignores inactive configs
# Test: batchEnrichImages() passes config through to each enrichImage() call
```

For enrichImage unit tests, mock `fetch` (for OpenAI path) and the Anthropic client (for default path). For getModelConfig, use the actual DB with test user.

---

## Section 3: CLI Startup — Model Config Loading

### Tests to write before CLI changes

```
# Test: CLI loads model config at startup (verify getModelConfig called with SMGR_USER_ID)
# Test: enrich --pending passes loaded config to batchEnrichImages
# Test: enrich <event_id> passes loaded config to enrichImage
# Test: CLI works normally when no model config exists (null config, Anthropic default)
# Test: query/show/stats commands work without model config loading affecting them
```

These are integration-level tests that use `runCli()`. The model config behavior is validated indirectly through the e2e test (Section 6).

---

## Section 4: Docker Compose — Ollama Service

### Tests to write before docker changes

No automated tests for this section. Validation is manual:
```
# Manual: docker-compose up -d ollama ollama-setup starts Ollama
# Manual: curl http://localhost:11434/api/tags returns 200
# Manual: ollama-setup pulls moondream:1.8b successfully
# Manual: health check passes within 60 seconds
```

---

## Section 5: Test Fixture Images

### Tests to write before adding fixtures

No automated tests. Validation:
```
# Manual: each image is < 50KB
# Manual: each image is valid JPEG (opens in viewer)
# Manual: moondream correctly identifies each image's subject (run manually)
```

---

## Section 6: Integration Test — `smgr-e2e.test.ts`

### Tests to write (this IS the test)

This section is the test itself. The test stubs are:

```
# describe("smgr e2e: watch → enrich → search")
#
#   beforeAll:
#     # Ollama health check (fail fast with clear message)
#     # Create test user
#     # Insert model_configs row pointing at local Ollama
#     # Upload 3 fixture images to S3
#     # Verify uploads visible via listS3Objects
#
#   it("watch --once discovers uploaded images")
#     # Run smgr watch --once with SMGR_AUTO_ENRICH=false
#     # Assert exit 0
#     # Assert stats: total_events === 3, pending_enrichment === 3
#     # Extract and store event IDs
#
#   it("enrich --dry-run lists all pending")
#     # Run smgr enrich --dry-run
#     # Assert all 3 event IDs in output
#
#   it("enrich --pending processes all images", { timeout: 120_000 })
#     # Run smgr enrich --pending
#     # Assert exit 0, enriched === 3, failed === 0
#     # For each event: smgr show <id>, assert description non-empty
#
#   it("semantic search finds correct images (positive)")
#     # Search "pineapple" → includes pineapple ID
#     # Search "dog" → includes dog ID
#     # Search "beach" → includes beach ID
#
#   it("semantic search excludes wrong images (negative)")
#     # Search "car" → does NOT include pineapple ID
#     # Search "pineapple" → does NOT include dog ID
#     # Search "snow" → does NOT include beach ID
#
#   it("final stats show all enriched")
#     # Assert enriched === 3, pending_enrichment === 0
#
#   afterAll:
#     # Delete S3 objects
#     # cleanupUserData (includes model_configs)
#     # Sign out, close connections
```

---

## Section 7: CI Pipeline Changes

### Tests to write before CI changes

No automated tests. Validation is via CI run:
```
# CI: Ollama installs and starts successfully
# CI: moondream:1.8b model is cached/restored between runs
# CI: integration tests pass including smgr-e2e.test.ts
# CI: total job time stays under 10 minutes
```

---

## Test Execution Order

1. **Section 1 tests first** — validate migration creates the table correctly
2. **Section 2 unit tests** — validate enrichment code handles config (mock fetch/Anthropic)
3. **Section 6 integration test** — validates everything end-to-end (requires Sections 1-5 complete)
4. **Section 7 CI validation** — run CI to confirm everything works in pipeline

Sections 3, 4, 5 have no dedicated automated tests — they are validated through the Section 6 e2e test.
