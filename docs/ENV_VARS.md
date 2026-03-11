# Environment Variables Reference

**Last Updated:** 2026-03-11

## Encryption Keys (Status-Based)

| Variable | Required | Purpose | Where |
|----------|----------|---------|-------|
| `ENCRYPTION_KEY_CURRENT` | ✅ Yes | Active key for encrypting new data | Vercel Prod, GitHub Prod Env |
| `ENCRYPTION_KEY_PREVIOUS` | ⚠️ During rotation | Old key for decrypting legacy data | Vercel Prod, GitHub Prod Env |
| `ENCRYPTION_KEY_NEXT` | ⚠️ Pre-rotation | Future key (staged before making it current) | Vercel Prod, GitHub Prod Env |

**Deprecated (DO NOT USE):**
- ❌ `ENCRYPTION_KEY` - Non-versioned, removed
- ❌ `ENCRYPTION_KEY_V1`, `ENCRYPTION_KEY_V2`, `ENCRYPTION_KEY_V3` - Version-based naming, replaced by status-based

## Application Secrets

| Variable | Purpose | Where |
|----------|---------|-------|
| `ANTHROPIC_API_KEY` | Claude API access | Vercel Prod, GitHub Prod Env |
| `TWILIO_ACCOUNT_SID` | Twilio account identifier | Vercel Prod, GitHub Prod Env |
| `TWILIO_AUTH_TOKEN` | Twilio authentication | Vercel Prod, GitHub Prod Env |
| `TWILIO_WHATSAPP_FROM` | WhatsApp sender number | Vercel Prod |
| `SUPABASE_SECRET_KEY` | Supabase service role key | Vercel Prod |
| `SUPABASE_PROJECT_REF` | Supabase project identifier | Vercel Prod |

## Public Environment Variables

| Variable | Purpose | Where |
|----------|---------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API endpoint | Vercel Prod |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase anon/public key | Vercel Prod |

## CI/CD Only Secrets

| Variable | Purpose | Where |
|----------|---------|-------|
| `VERCEL_TOKEN` | Vercel API access for deployments | GitHub Prod Env |
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI access for migrations | GitHub Prod Env |

## Secret Management Rules

1. **Single Source of Truth:** Vercel Production for runtime, GitHub Production Environment for CI
2. **No Duplication:** Each secret exists in exactly two places (Vercel + GitHub env)
3. **No Repository Secrets:** GitHub repository-level secrets NOT used (except deployment tokens)
4. **Sync Requirement:** When updating encryption keys, update BOTH Vercel AND GitHub

## Encryption Data Format

- **Current:** `current:AES_GCM_BASE64_CIPHERTEXT`
- **Legacy:** `AES_GCM_BASE64_CIPHERTEXT` (no prefix, treated as "previous")
- **Migration:** Automatic on access via lazy migration (background, non-blocking)

## Key Rotation Procedure

```bash
# Step 1: Add new key as NEXT
vercel env add ENCRYPTION_KEY_NEXT production  # paste new key
gh secret set ENCRYPTION_KEY_NEXT --env Production  # paste same key

# Step 2: Deploy (validates NEXT key works)

# Step 3: Promote NEXT to CURRENT
vercel env add ENCRYPTION_KEY_PREVIOUS production  # paste old CURRENT value
gh secret set ENCRYPTION_KEY_PREVIOUS --env Production  # paste old CURRENT value

vercel env add ENCRYPTION_KEY_CURRENT production  # paste NEXT value
gh secret set ENCRYPTION_KEY_CURRENT --env Production  # paste NEXT value

vercel env rm ENCRYPTION_KEY_NEXT production
gh secret remove ENCRYPTION_KEY_NEXT --env Production

# Step 4: Wait for lazy migration (monitor logs)

# Step 5: Clean up old key
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
