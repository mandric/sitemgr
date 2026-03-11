## Key Decisions

### v1 is cloud-based (not local-first)

- **Supabase Postgres** is the event store (not per-device SQLite)
- **Supabase Storage** (S3-compatible) for media (not BYO S3 — that's backlog)
- **Online required** — no offline support in v1
- **Supabase Edge Functions** for the WhatsApp bot webhook handler
- Local-first/offline with SQLite is deferred to a future version

### Environment Variables & Secrets Strategy

**Core Principle: Tests use fixtures, production uses secrets**

**Encryption Keys (Status-Based Naming):**
- `ENCRYPTION_KEY_CURRENT` - Active key for new encryptions (required in production)
- `ENCRYPTION_KEY_PREVIOUS` - Old key for decryption during rotation (optional in production)
- `ENCRYPTION_KEY_NEXT` - Future key for gradual rollout (optional in production)
- **DO NOT USE**: `ENCRYPTION_KEY`, `ENCRYPTION_KEY_V1`, `ENCRYPTION_KEY_V2`, `ENCRYPTION_KEY_V3` (legacy, removed)

**Where Secrets Live:**
- **Vercel Production**: All runtime secrets for deployed app
- **GitHub Production Environment**: Only deployment secrets (VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN)
- **NO GitHub secrets for tests**: Tests use `vi.stubEnv()` with fixture values, not real secrets
- **NO repository secrets**: GitHub repository-level secrets NOT used (only environment-level)

**Testing Pattern (IMPORTANT):**

When to use `vi.stubEnv()` (fixtures) vs setting in CI:
- **Use fixtures**: When testing logic that uses the env var internally (encryption, business logic, API clients)
  - The value doesn't need to connect to a real service
  - Example: `ENCRYPTION_KEY_CURRENT` - tests the encryption algorithm, not a remote service
- **Set in CI**: When the test connects to an actual running service
  - The value must match the service instance
  - Example: `NEXT_PUBLIC_SUPABASE_URL` - E2E test connects to real local Supabase instance

**Unit/Integration Tests:**
- Always use `vi.stubEnv()` with test fixture values
  ```typescript
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY_CURRENT", "test-fixture-key");
  });
  ```

**E2E Tests:**
- Only set env vars for services the test actually connects to
- Current: Supabase URL/key (because E2E connects to local Supabase)
- Not encryption keys (E2E doesn't exercise encryption paths)
- Not API keys (E2E doesn't call external APIs)

**Never add production secrets to GitHub for tests** - use fixtures instead

**Encryption Format:**
- Current format: `current:base64ciphertext` (label-prefixed)
- Legacy format: `base64ciphertext` (no prefix, assumed "previous")
- Lazy migration: Data auto-migrates to current key on access (non-blocking background update)

**Key Rotation Process (Production Only):**
1. Add `ENCRYPTION_KEY_NEXT` in Vercel
2. Validate NEXT key works (run tests locally with stubbed NEXT key)
3. Promote NEXT to CURRENT (save old CURRENT as PREVIOUS first)
4. Deploy and monitor logs for lazy migration messages
5. After migration completes, remove PREVIOUS from Vercel

**See `docs/ENV_VARS.md` for detailed procedures**

### Backlog items (not v1 scope)

- BYO S3-compatible storage (any provider, not just Supabase)
- Local-first / offline mode with per-device SQLite
- Enrichment metadata as sidecar files in S3 (post-prototype idea)
