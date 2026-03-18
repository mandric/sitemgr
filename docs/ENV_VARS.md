# Environment Variables Reference

**Last Updated:** 2026-03-11

## Core Principle

**Tests use fixtures, production uses secrets.**

**When to use `vi.stubEnv()` (fixtures) vs setting in CI:**
- **Use fixtures**: When testing logic that uses the env var internally
  - The value doesn't need to connect to a real service
  - Example: `ENCRYPTION_KEY_CURRENT` - tests the encryption algorithm, not a remote service
  - Example: `ANTHROPIC_API_KEY` - if test mocks the API, use fixture
- **Set in CI**: When the test connects to an actual running service
  - The value must match the service instance
  - Example: `NEXT_PUBLIC_SUPABASE_URL` - E2E test connects to real local Supabase instance

**Rules:**
- Never add production secrets to GitHub for tests
- GitHub Production Environment only contains deployment secrets

## Encryption Keys (Status-Based)

| Variable | Required | Vercel Prod | Purpose |
|----------|----------|-------------|---------|
| `ENCRYPTION_KEY_CURRENT` | ✅ Yes | ✅ | Active key for encrypting new data |
| `ENCRYPTION_KEY_PREVIOUS` | ⚠️ During rotation | ✅ | Old key for decrypting legacy data |
| `ENCRYPTION_KEY_NEXT` | ⚠️ Pre-rotation | ✅ | Future key (staged before making it current) |

**Deprecated (DO NOT USE):**
- ❌ `ENCRYPTION_KEY` - Non-versioned, removed
- ❌ `ENCRYPTION_KEY_V1`, `ENCRYPTION_KEY_V2`, `ENCRYPTION_KEY_V3` - Version-based naming, replaced by status-based

**Testing:**
- Tests use `vi.stubEnv("ENCRYPTION_KEY_CURRENT", "test-fixture-key")` - NOT production keys
- Each test file defines its own fixture keys in `beforeEach()`

## Application Secrets (Runtime Only)

These secrets are ONLY in Vercel Production for runtime use:

| Variable | Vercel Prod | Purpose |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | ✅ | Claude API access for agent |
| `TWILIO_ACCOUNT_SID` | ✅ | Twilio account identifier |
| `TWILIO_AUTH_TOKEN` | ✅ | Twilio authentication |

## Runtime-Only Secrets

These secrets are ONLY needed for production runtime (NOT in CI):

| Variable | Vercel Prod | Purpose |
|----------|-------------|---------|
| `TWILIO_WHATSAPP_FROM` | ✅ | WhatsApp sender number |
| `SUPABASE_SECRET_KEY` | ✅ | Supabase service role key |
| `SUPABASE_PROJECT_REF` | ✅ | Supabase project identifier |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase API endpoint (public) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | ✅ | Supabase anon/public key |

## CI/CD-Only Secrets

These secrets are ONLY needed for CI/CD (NOT in runtime):

| Variable | GitHub Prod Env | Purpose |
|----------|-----------------|---------|
| `VERCEL_TOKEN` | ✅ | Vercel API access for deployments |
| `SUPABASE_ACCESS_TOKEN` | ✅ | Supabase CLI access for migrations |

## Secret Management Rules

1. **Separation of Concerns:** Runtime secrets in Vercel, deployment secrets in GitHub Production Environment
2. **Tests Use Fixtures:** Never put production secrets in GitHub for tests - use `vi.stubEnv()` instead
3. **No Repository Secrets:** GitHub repository-level secrets NOT used (only environment-level secrets)
4. **No Secret Mirroring:** Each secret exists in ONE place only (either Vercel or GitHub, never both)

## Encryption Data Format

- **Current:** `current:AES_GCM_BASE64_CIPHERTEXT`
- **Legacy:** `AES_GCM_BASE64_CIPHERTEXT` (no prefix, treated as "previous")
- **Migration:** Automatic on access via lazy migration (background, non-blocking)

## Key Rotation Procedure

> **For the full operational runbook, see [`docs/KEY_ROTATION.md`](./KEY_ROTATION.md).**
> The summary below covers the basic steps; the runbook includes monitoring, verification, and rollback procedures.

```bash
# Step 1: Add new key as NEXT (Vercel only)
vercel env add ENCRYPTION_KEY_NEXT production  # paste new key

# Step 2: Validate NEXT key works (test locally with fixtures)
cd web
# In your test file, temporarily stub NEXT as CURRENT:
# vi.stubEnv("ENCRYPTION_KEY_CURRENT", "your-next-key-value");
npm test
# If tests pass, NEXT key is valid

# Step 3: Promote NEXT to CURRENT (Vercel only)
# Save old CURRENT as PREVIOUS first
vercel env add ENCRYPTION_KEY_PREVIOUS production  # paste old CURRENT value

# Replace CURRENT with NEXT value
vercel env add ENCRYPTION_KEY_CURRENT production  # paste NEXT value

# Remove NEXT (no longer needed)
vercel env rm ENCRYPTION_KEY_NEXT production

# Step 4: Deploy and monitor lazy migration
# Watch application logs for migration messages:
# "[Lazy Migration] ✅ Migrated <bucket> to encryption key current"

# Step 5: After all data migrated, clean up old PREVIOUS key
# Verify no more migration messages in logs, then:
vercel env rm ENCRYPTION_KEY_PREVIOUS production
```

## Verification Commands

```bash
# Check Vercel env vars
cd web && vercel env ls

# Check GitHub Production env secrets
gh api repos/mandric/sitemgr/environments/Production/secrets --jq '.secrets[] | .name'

# Test encryption locally
cd web
echo "ENCRYPTION_KEY_CURRENT=your-key-here" > .env.local
npm run test  # should pass
```
