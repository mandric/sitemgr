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
- **Vercel Production**: Runtime secrets for deployed app (source of truth for production)
- **GitHub Production Environment**: Secrets for CI/CD tests (mirrors Vercel for testing)
- **NO duplication**: Each secret exists in exactly two places (Vercel + GitHub env)
- **NO repository secrets**: GitHub repository-level secrets are NOT used (except `VERCEL_TOKEN` and `SUPABASE_ACCESS_TOKEN` for deployment)

**Encryption Format:**
- Current format: `current:base64ciphertext` (label-prefixed)
- Legacy format: `base64ciphertext` (no prefix, assumed "previous")
- Lazy migration: Data auto-migrates to current key on access (non-blocking background update)

**Key Rotation Process:**
1. Set `ENCRYPTION_KEY_NEXT` in both Vercel and GitHub
2. Deploy (new encryptions still use CURRENT)
3. Rename: CURRENT → PREVIOUS, NEXT → CURRENT in both places
4. Lazy migration handles the rest automatically
5. Remove PREVIOUS after migration completes

### Backlog items (not v1 scope)

- BYO S3-compatible storage (any provider, not just Supabase)
- Local-first / offline mode with per-device SQLite
- Enrichment metadata as sidecar files in S3 (post-prototype idea)
