# Interview Transcript: Spec 20 — Test Suite Reorganization

## Q1: Mock-heavy test deletion strategy

**Question:** The spec lists ~18 mock-heavy unit tests to evaluate for deletion. Some mock Supabase/S3 but test logic that has NO integration test coverage yet (e.g., agent-core, agent-actions, enrichment, whatsapp-route, device-* routes). Should we write new integration tests to replace those before deleting, or just delete them and rely on existing integration + E2E coverage?

**Answer:** Replace then delete — write API route integration tests first, then delete mock-heavy tests that are now covered.

## Q2: Ollama-dependent pipeline test

**Question:** The sitemgr-e2e.test.ts pipeline test requires local Ollama with moondream:1.8b (5 min timeouts for CPU enrichment). Should this test stay in the E2E CLI tier, or should it be excluded/skipped by default since it needs Ollama?

**Answer:** Add Ollama to the test environment, or use a smaller/faster model that can be used for testing. Keep the test in the E2E CLI tier without skipping.

## Q3: API route integration test authentication pattern

**Question:** For the new API route integration tests, should they authenticate via the existing createTestUser() + user.client pattern, or should they use raw fetch() with Bearer tokens against the running Next.js dev server?

**Answer:** fetch() with Bearer tokens — more realistic, tests auth middleware too. Use createTestUser() for setup, then extract the token for fetch().
