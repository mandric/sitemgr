## Summary

We have no single integration test that exercises the full CLI pipeline: upload files to S3 → discover them → enrich → query results. The pieces are tested in isolation (`media-storage.test.ts` for S3, `smgr-cli.test.ts` for CLI commands against seeded data, `media-lifecycle.test.ts` for DB operations) but nothing validates they work together end-to-end.

## Test Flow

The real user path is **chat agent → CLI skill → smgr API → S3 + DB**. This test covers the bottom two layers (CLI → smgr API), which is where the data operations happen.

### Steps

1. **Setup**: Create an S3 bucket and upload known test images using the S3 client (reuse `createS3Client` + `uploadS3Object` from `media-storage.test.ts` helpers)
2. **`smgr watch --once`**: Run with `SMGR_S3_BUCKET` pointing at the test bucket, `SMGR_AUTO_ENRICH=false` to skip enrichment during discovery
3. **Verify indexing**: Run `smgr stats` → assert `total_events` matches uploaded file count, `pending_enrichment` equals total
4. **`smgr enrich --dry-run`**: Assert pending list contains the expected event IDs
5. **`smgr enrich --pending`**: Run against a local lightweight model (see enrichment strategy below)
6. **Semantic search assertions**: Verify enrichment quality with known test images (see test fixtures below)
7. **`smgr stats`**: Verify `enriched` count updated, `pending_enrichment` is 0
8. **Cleanup**: Delete uploaded objects and test bucket

### Test fixtures: known images with semantic assertions

Use a small set of visually unambiguous images as test fixtures. These let us assert that the model's enrichment is directionally correct, not just structurally valid.

| Fixture | Search should match | Search should NOT match |
|---------|-------------------|----------------------|
| Pineapple photo | `fruit` | `animal`, `car` |
| Dog photo | `animal`, `dog` | `fruit`, `building` |
| Beach/ocean photo | `water`, `beach` | `snow`, `forest` |

**Assertion style:**
```typescript
// Positive: pineapple should be findable by "fruit"
const fruitResults = JSON.parse((await runCli(["query", "--search", "fruit", "--format", "json"])).stdout);
expect(fruitResults.length).toBeGreaterThanOrEqual(1);
expect(fruitResults.some(e => e.id === pineappleEventId)).toBe(true);

// Negative: pineapple should NOT appear in "animal" search
const animalResults = JSON.parse((await runCli(["query", "--search", "animal", "--format", "json"])).stdout);
expect(animalResults.some(e => e.id === pineappleEventId)).toBe(false);
```

This validates the full pipeline: S3 upload → watch → enrich (real model sees real image) → search (Postgres full-text search over enrichment descriptions).

If a tiny model can't reliably distinguish a pineapple from a dog, we pick a bigger model or simpler contrasts — the point is the test catches regressions in the pipeline, not just structural correctness.

### Enrichment strategy: local model in CI

Instead of mocking the Anthropic API (brittle, doesn't test real code paths), run a small vision-capable model locally via Ollama.

**Why a real model instead of mocks:**
- Tests the full `enrichImage` pipeline: image validation, base64 encoding, API client construction, response parsing
- No mock drift — exercises the actual API shape
- When user model config is added (see below), the test naturally exercises that config path
- Semantic assertions (above) are only possible with a real model

**Implementation:**
- Use Ollama with a tiny vision model (e.g., `moondream` ~1.8B, runs on CPU)
- CI starts Ollama + pulls model (cacheable across runs)
- User model config points enrichment at `http://localhost:11434/v1`
- If a model is too unreliable for semantic assertions, size up (e.g., `llava` ~4B) — CI cost is acceptable for confidence

**Future: user model config**

Similar to how we manage S3 bucket config in our API, we'll also manage a user's model config for enrichment. This test will be an early consumer of that config path — the test user's model config will point to the local Ollama instance, exercising the same code path that production users will use when configuring their preferred model.

## Files to create/modify

- **New**: `web/__tests__/integration/smgr-e2e.test.ts` — the end-to-end test
- **New**: `web/__tests__/integration/fixtures/` — known test images (pineapple, dog, beach — small JPEGs, a few KB each)
- **Maybe modify**: `web/__tests__/integration/setup.ts` — if shared helpers need extraction (S3 bucket setup/teardown)
- **Maybe modify**: `web/lib/media/enrichment.ts` — to support user model config (endpoint + model name) instead of hardcoded Anthropic

## Existing infrastructure to reuse

- `createTestUser()`, `cleanupUserData()` from `setup.ts`
- `getS3Config()`, `createS3Client()`, `uploadS3Object()`, `listS3Objects()` from `setup.ts` / `media-storage.test.ts`
- `runCli()` pattern from `smgr-cli.test.ts` (spawn `tsx bin/smgr.ts` with env vars)

## Not in scope

- Testing `add-bucket` / `test-bucket` / `index-bucket` (these are agent actions, not CLI commands yet)
- Chat agent layer testing
