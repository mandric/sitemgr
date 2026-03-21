# Interview Transcript: smgr Integration Testing

## Q1: Model Configuration Approach

**Q:** The enrichment code currently hardcodes Anthropic Claude Haiku. For the integration test (and future user config), should we make enrichment configurable by adding env vars like SMGR_ENRICH_BASE_URL and SMGR_ENRICH_MODEL, or do you have a different approach in mind for user model config?

**A:** DB-stored config — Store model config in user_profiles or a new table, loaded at runtime.

## Q2: Test Fixture Images

**Q:** For test fixture images, should we use real photos (downloaded from an open-license source like Unsplash) or generate minimal synthetic test images programmatically?

**A:** Real photos (Recommended) — Small JPEGs (~10-50KB each) from open-license sources, committed to repo.

## Q3: Test Scope / Ollama Requirement

**Q:** Should this integration test ONLY run in CI with Ollama available, or should it also work locally? If local, should developers be expected to have Ollama running, or should the test gracefully skip enrichment steps when no model is available?

**A:** Always require Ollama — Test always requires Ollama, fail fast if not available.

## Q4: DB Config Table Design

**Q:** For DB-stored model config: should this be a new table (e.g. model_configs) or fields on the existing user_profiles table?

**A:** New model_configs table — Separate table with user_id FK, supports multiple providers/configs.

## Q5: Config Loading Strategy

**Q:** Should the enrichment code look up the user's config at enrichment time (DB read per enrich call), or should it be loaded once at CLI startup and passed through?

**A:** Load once at startup — CLI reads model_configs at start, passes config through. Fast, no per-call DB hit.

## Q6: Error Handling for Unreachable Model

**Q:** What should happen when Ollama/the configured model endpoint is unreachable during `smgr enrich --pending`?

**A:** Retry then fail — Retry 2-3 times with backoff per image, then fail if still unreachable.

## Q7: Migration SQL in Spec

**Q:** Should this test spec include the migration SQL, or just reference what columns are needed?

**A:** Include migration SQL — Spec includes the exact CREATE TABLE + RLS policies.

## Q8: Docker Compose Strategy

**Q:** Should the integration test add Ollama to the existing docker-compose.yml, or create a separate one?

**A:** Add to existing docker-compose.yml — Single file, Ollama available for dev and test.
