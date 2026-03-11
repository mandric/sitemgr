# Secret Management Implementation Guide

## What Was Changed

✅ Updated CI workflow to pull runtime secrets from Vercel
✅ Documented which secrets belong where
✅ Created cleanup plan

## New Secret Architecture

### Secrets in GitHub (CI-Only - 2 secrets)

1. **`VERCEL_TOKEN`** - Deploy to Vercel & pull env vars
   - Used to: Deploy app, pull production env variables
   - Scope: CI/CD only
   
2. **`SUPABASE_ACCESS_TOKEN`** - Run database migrations
   - Used to: Link to Supabase project, run migrations
   - Scope: CI/CD only

**Optional (3rd secret for storage bucket creation):**
3. **`SUPABASE_SECRET_KEY`** - Create storage buckets (deploy-time)
   - Used to: Create storage buckets via API
   - Alternative: Get from Supabase CLI during deploy
   - Recommendation: Keep in GitHub for now (deploy-time secret)

### Secrets in Vercel (Runtime - ~10 secrets)

All of these are needed by your running application:

1. **`ENCRYPTION_KEY`** - Decrypt S3 bucket credentials
2. **`ENCRYPTION_KEY_V1`** - Old key (for lazy migration)
3. **`ENCRYPTION_KEY_V2`** - New key (for lazy migration)
4. **`ANTHROPIC_API_KEY`** - Call Claude API
5. **`TWILIO_ACCOUNT_SID`** - WhatsApp integration
6. **`TWILIO_AUTH_TOKEN`** - WhatsApp integration
7. **`TWILIO_WHATSAPP_FROM`** - WhatsApp phone number
8. **`NEXT_PUBLIC_SUPABASE_URL`** - Supabase project URL
9. **`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`** - Supabase anon key
10. **`SUPABASE_SECRET_KEY`** - Supabase service role key (server-side only)

### Variables in GitHub (Config - 4 variables)

These are not secret, just configuration:

1. **`VERCEL_PROJECT_ID`** - Your Vercel project ID
2. **`VERCEL_TEAM_ID`** - Your Vercel team ID (if applicable)
3. **`SUPABASE_PROJECT_REF`** - Your Supabase project reference
4. **`VERCEL_APP_URL`** - Your production URL (e.g., https://sitemgr-nine.vercel.app)

## How It Works Now

### E2E Tests (Most Complex)

**Old way:**
```yaml
- name: Set up environment
  run: |
    cat > .env.local <<EOF
    ENCRYPTION_KEY=${{ secrets.ENCRYPTION_KEY }}
    ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }}
    # ... 5 more secrets manually copied
    EOF
```

**New way:**
```yaml
- name: Pull runtime secrets from Vercel
  run: |
    npx vercel env pull .env.ci \
      --token=${{ secrets.VERCEL_TOKEN }} \
      --environment=production

- name: Set up environment (merge configs)
  run: |
    # Start with Vercel env (has all runtime secrets)
    cp .env.ci .env.local
    
    # Override only test-specific values
    cat >> .env.local <<EOF
    NEXT_PUBLIC_SUPABASE_URL=${{ env.SUPABASE_URL }}
    EOF
```

**Benefits:**
- ✅ Single source of truth (Vercel)
- ✅ No duplicate secrets in GitHub
- ✅ Auto-sync (always latest from Vercel)
- ✅ Easier to add new secrets (just add to Vercel)

### Local Development

**Old way:**
```bash
# Manually copy secrets from GitHub/Vercel to .env.local
# Easy to get out of sync
```

**New way:**
```bash
# Pull all secrets from Vercel
vercel env pull .env.local

# Done! Always in sync with production
```

## Step-by-Step Setup Instructions

### For You (Project Owner)

#### 1. Set Up Vercel Environment Variables

```bash
# If not already set, add all runtime secrets to Vercel:
vercel env add ENCRYPTION_KEY production
# Paste your current encryption key

vercel env add ENCRYPTION_KEY_V1 production
# Paste same key (for backward compatibility)

vercel env add ENCRYPTION_KEY_V2 production
# Paste same key (will rotate later)

vercel env add ANTHROPIC_API_KEY production
# Paste your Anthropic API key

vercel env add TWILIO_ACCOUNT_SID production
vercel env add TWILIO_AUTH_TOKEN production
vercel env add TWILIO_WHATSAPP_FROM production

vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY production
vercel env add SUPABASE_SECRET_KEY production
```

#### 2. Set Up GitHub Secrets (Minimal)

Via GitHub UI (https://github.com/mandric/sitemgr/settings/secrets/actions):

- `VERCEL_TOKEN` - Get from https://vercel.com/account/tokens
- `SUPABASE_ACCESS_TOKEN` - Get from https://supabase.com/dashboard/account/tokens
- `SUPABASE_SECRET_KEY` - Optional, for bucket creation (or remove from GitHub and get from CLI)

#### 3. Set Up GitHub Variables

Via GitHub UI (https://github.com/mandric/sitemgr/settings/variables/actions):

- `VERCEL_PROJECT_ID` - From Vercel project settings
- `VERCEL_TEAM_ID` - From Vercel team settings (if applicable)
- `SUPABASE_PROJECT_REF` - Your Supabase project reference
- `VERCEL_APP_URL` - Your production URL

#### 4. Remove Duplicate Secrets from GitHub

**⚠️ Only after confirming they're in Vercel!**

Via GitHub UI, delete these secrets (if they exist):
- ❌ `ENCRYPTION_KEY` (now in Vercel)
- ❌ `ANTHROPIC_API_KEY` (now in Vercel)
- ❌ `TWILIO_ACCOUNT_SID` (now in Vercel)
- ❌ `TWILIO_AUTH_TOKEN` (now in Vercel)

Keep these:
- ✅ `VERCEL_TOKEN` (CI needs it)
- ✅ `SUPABASE_ACCESS_TOKEN` (CI needs it)
- ✅ `SUPABASE_SECRET_KEY` (optional, for bucket creation)

#### 5. Test the New Setup

```bash
# Create a test branch
git checkout -b test-secret-management

# The CI workflow is already updated, just push
git push origin test-secret-management

# Create PR
gh pr create --title "Test: Secret management from Vercel" \
  --body "Testing that CI can pull secrets from Vercel successfully"

# Watch CI
gh pr checks --watch

# If green, merge!
gh pr merge --squash
```

### For Team Members (Future)

#### Local Development Setup

```bash
# 1. Clone repo
git clone https://github.com/mandric/sitemgr.git
cd sitemgr

# 2. Install dependencies
cd web && npm install

# 3. Link to Vercel project (one-time)
vercel link

# 4. Pull environment variables
vercel env pull .env.local

# 5. Start development
npm run dev
```

**That's it!** No need to manually copy secrets.

## Verification Checklist

Before removing secrets from GitHub:

- [ ] All runtime secrets exist in Vercel (check UI)
- [ ] `VERCEL_TOKEN` is set in GitHub
- [ ] `SUPABASE_ACCESS_TOKEN` is set in GitHub
- [ ] Can run `vercel env pull` locally successfully
- [ ] Reviewed updated CI workflow

After removing secrets from GitHub:

- [ ] CI tests pass on a test branch
- [ ] Production deployment succeeds
- [ ] App works in production
- [ ] Can add/test S3 buckets
- [ ] WhatsApp bot works

## Troubleshooting

### Error: "VERCEL_TOKEN environment variable not found"

**Solution:** Add `VERCEL_TOKEN` to GitHub secrets

### Error: "Project not found"

**Solution:** Ensure `VERCEL_PROJECT_ID` and `VERCEL_TEAM_ID` are set correctly

### Error: "Unauthorized"

**Solution:** Check that `VERCEL_TOKEN` has correct permissions

### E2E tests fail with "ENCRYPTION_KEY not set"

**Solution:** Verify Vercel env pull worked:
```yaml
- name: Debug environment
  run: |
    cd web
    cat .env.ci | grep ENCRYPTION_KEY || echo "Missing ENCRYPTION_KEY"
```

### Local development: "Error: No token found"

**Solution:**
```bash
# Login to Vercel
vercel login

# Link project
vercel link

# Try again
vercel env pull .env.local
```

## Migration Timeline

### ✅ Already Done

1. Updated `.github/workflows/ci.yml` to pull from Vercel
2. Documented secret architecture
3. Created cleanup plan

### To Do This Week

1. Verify all runtime secrets are in Vercel
2. Remove duplicate secrets from GitHub
3. Test CI with a PR
4. Merge if successful

### Future Improvements

When you have a team or need better security:

1. **Migrate to 1Password/Vault** (~$20/mo)
   - Better audit trail
   - Fine-grained access control
   - Automated rotation

2. **Add secret scanning** (GitHub Advanced Security)
   - Detect committed secrets
   - Alert before they're exposed

3. **Implement secret rotation schedule**
   - Every 90 days for critical secrets
   - Use lazy migration for ENCRYPTION_KEY

## Summary

**Before:**
- Secrets duplicated in GitHub + Vercel
- Manual sync required
- Easy to get out of sync
- 6+ secrets in GitHub

**After:**
- Vercel is single source of truth
- Auto-sync via `vercel env pull`
- Only 2-3 secrets in GitHub (CI-only)
- Runtime secrets in Vercel (where they belong)

**Key Benefit:** Update secrets once in Vercel, CI and local dev automatically get them!

