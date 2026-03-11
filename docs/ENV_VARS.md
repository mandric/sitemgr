# Environment Variables Reference

**Last Updated:** 2026-03-11

## Encryption Keys (Status-Based)

| Variable | Required | Vercel Prod | GitHub Prod Env | Purpose |
|----------|----------|-------------|-----------------|---------|
| `ENCRYPTION_KEY_CURRENT` | ✅ Yes | ✅ | ✅ | Active key for encrypting new data |
| `ENCRYPTION_KEY_PREVIOUS` | ⚠️ During rotation | ✅ | ✅ | Old key for decrypting legacy data |
| `ENCRYPTION_KEY_NEXT` | ⚠️ Pre-rotation | ✅ | ✅ | Future key (staged before making it current) |

**Deprecated (DO NOT USE):**
- ❌ `ENCRYPTION_KEY` - Non-versioned, removed
- ❌ `ENCRYPTION_KEY_V1`, `ENCRYPTION_KEY_V2`, `ENCRYPTION_KEY_V3` - Version-based naming, replaced by status-based

## Application Secrets (Runtime + CI)

These secrets are needed for both production runtime AND CI tests:

| Variable | Vercel Prod | GitHub Prod Env | Purpose |
|----------|-------------|-----------------|---------|
| `ANTHROPIC_API_KEY` | ✅ | ✅ | Claude API access for agent |
| `TWILIO_ACCOUNT_SID` | ✅ | ✅ | Twilio account identifier |
| `TWILIO_AUTH_TOKEN` | ✅ | ✅ | Twilio authentication |

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

1. **Separation of Concerns:** Runtime secrets in Vercel, CI secrets in GitHub Production Environment
2. **Intentional Mirroring:** Some secrets exist in BOTH places (encryption keys, API keys needed for tests)
3. **No Repository Secrets:** GitHub repository-level secrets NOT used (only environment-level secrets)
4. **Sync Requirement:** When updating shared secrets (encryption, API keys), update BOTH Vercel AND GitHub
5. **Least Privilege:** CI only has access to secrets it actually uses in tests

## Encryption Data Format

- **Current:** `current:AES_GCM_BASE64_CIPHERTEXT`
- **Legacy:** `AES_GCM_BASE64_CIPHERTEXT` (no prefix, treated as "previous")
- **Migration:** Automatic on access via lazy migration (background, non-blocking)

## Key Rotation Procedure

```bash
# Step 1: Add new key as NEXT
vercel env add ENCRYPTION_KEY_NEXT production  # paste new key
gh secret set ENCRYPTION_KEY_NEXT --env Production  # paste same key

# Step 2: Validate NEXT key works (test in staging or locally)
cd web
# Temporarily test with NEXT key
ENCRYPTION_KEY_CURRENT=$(vercel env pull --environment=production | grep NEXT | cut -d= -f2) npm test
# If tests pass, NEXT key is valid

# Step 3: Promote NEXT to CURRENT (makes it active)
# Save old CURRENT as PREVIOUS first
vercel env add ENCRYPTION_KEY_PREVIOUS production  # paste old CURRENT value
gh secret set ENCRYPTION_KEY_PREVIOUS --env Production  # paste old CURRENT value

# Replace CURRENT with NEXT value
vercel env add ENCRYPTION_KEY_CURRENT production  # paste NEXT value
gh secret set ENCRYPTION_KEY_CURRENT --env Production  # paste NEXT value

# Remove NEXT (no longer needed)
vercel env rm ENCRYPTION_KEY_NEXT production
gh secret remove ENCRYPTION_KEY_NEXT --env Production

# Step 4: Deploy and monitor lazy migration
# Watch application logs for migration messages:
# "[Lazy Migration] ✅ Migrated <bucket> to encryption key current"

# Step 5: After all data migrated, clean up old PREVIOUS key
# Verify no more migration messages in logs, then:
vercel env rm ENCRYPTION_KEY_PREVIOUS production
gh secret remove ENCRYPTION_KEY_PREVIOUS --env Production
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
