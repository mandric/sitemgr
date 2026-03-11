## Key Decisions

### v1 is cloud-based (not local-first)

- **Supabase Postgres** is the event store (not per-device SQLite)
- **Supabase Storage** (S3-compatible) for media (not BYO S3 — that's backlog)
- **Online required** — no offline support in v1
- **Supabase Edge Functions** for the WhatsApp bot webhook handler
- Local-first/offline with SQLite is deferred to a future version

### Environment Variables & Secrets Strategy

**Encryption Keys (Status-Based Naming):**
- `ENCRYPTION_KEY_CURRENT` - Active key for new encryptions (required)
- `ENCRYPTION_KEY_PREVIOUS` - Old key for decryption during rotation (optional)
- `ENCRYPTION_KEY_NEXT` - Future key for gradual rollout (optional)
- **DO NOT USE**: `ENCRYPTION_KEY`, `ENCRYPTION_KEY_V1`, `ENCRYPTION_KEY_V2`, `ENCRYPTION_KEY_V3` (legacy, removed)

**Where Secrets Live:**
- **Vercel Production**: All runtime secrets for deployed app
- **GitHub Production Environment**: Secrets needed for CI/CD (encryption keys, test API keys, deployment tokens)
- **Intentional mirroring**: Some secrets exist in BOTH (encryption keys, API keys used in tests)
- **Runtime-only secrets**: Only in Vercel (WhatsApp number, Supabase project config)
- **CI-only secrets**: Only in GitHub (VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN for deployment)
- **NO repository secrets**: GitHub repository-level secrets NOT used (only environment-level)

**Encryption Format:**
- Current format: `current:base64ciphertext` (label-prefixed)
- Legacy format: `base64ciphertext` (no prefix, assumed "previous")
- Lazy migration: Data auto-migrates to current key on access (non-blocking background update)

**Key Rotation Process:**
1. Add `ENCRYPTION_KEY_NEXT` in both Vercel and GitHub
2. Validate NEXT key works (run tests with it locally)
3. Promote NEXT to CURRENT (save old CURRENT as PREVIOUS first)
4. Deploy and monitor logs for lazy migration messages
5. After migration completes, remove PREVIOUS from both places

**See `docs/ENV_VARS.md` for detailed secret management procedures**

### Backlog items (not v1 scope)

- BYO S3-compatible storage (any provider, not just Supabase)
- Local-first / offline mode with per-device SQLite
- Enrichment metadata as sidecar files in S3 (post-prototype idea)
