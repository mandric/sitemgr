# Secret Cleanup & Migration Plan

## Current State (Based on CI Workflow)

### Secrets Currently Used in GitHub Actions

From `.github/workflows/ci.yml`, we can see these secrets are referenced:

**Runtime Secrets (should be in Vercel instead):**
- `ENCRYPTION_KEY` - Used in E2E tests
- `ANTHROPIC_API_KEY` - Used in E2E tests  
- `TWILIO_ACCOUNT_SID` - Used in E2E tests
- `TWILIO_AUTH_TOKEN` - Used in E2E tests
- `SUPABASE_SECRET_KEY` - Used for smoke tests

**CI-Specific Secrets (should stay in GitHub):**
- `VERCEL_TOKEN` - Needed for Vercel deployment
- `SUPABASE_ACCESS_TOKEN` - Needed for database migrations

**Variables (not secret, but config):**
- `TWILIO_WHATSAPP_FROM` - Phone number (not sensitive)
- `VERCEL_PROJECT_ID` - Project identifier
- `VERCEL_TEAM_ID` - Team identifier
- `SUPABASE_PROJECT_REF` - Project identifier
- `VERCEL_APP_URL` - Your app URL

## Target State

### Secrets in GitHub (Minimal - only 2!)
- `VERCEL_TOKEN` - Deploy to Vercel
- `SUPABASE_ACCESS_TOKEN` - Run migrations

### Secrets in Vercel (All runtime secrets)
- `ENCRYPTION_KEY`
- `ENCRYPTION_KEY_V1` (for lazy migration)
- `ENCRYPTION_KEY_V2` (for lazy migration)
- `ANTHROPIC_API_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`

### Variables in GitHub (Config, not secret)
- `VERCEL_PROJECT_ID`
- `VERCEL_TEAM_ID`
- `SUPABASE_PROJECT_REF`
- `VERCEL_APP_URL`

## Migration Steps

### Step 1: Verify What You Have

```bash
# In GitHub UI:
# 1. Go to https://github.com/mandric/sitemgr/settings/secrets/actions
# 2. List all secrets you see
# 3. Go to https://github.com/mandric/sitemgr/settings/variables/actions
# 4. List all variables

# In Vercel UI:
# 1. Go to Vercel dashboard > sitemgr project > Settings > Environment Variables
# 2. List all variables for production
```

**Expected findings:**
- GitHub has 6-7 secrets (runtime + CI)
- Vercel has 8-10 env vars (runtime)
- Overlap: `ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, `TWILIO_*`, `SUPABASE_SECRET_KEY`

### Step 2: Ensure All Runtime Secrets Are in Vercel

**Check Vercel has these (if not, add them):**

```bash
# If not already in Vercel, add them:
vercel env add ENCRYPTION_KEY production
vercel env add ANTHROPIC_API_KEY production
vercel env add TWILIO_ACCOUNT_SID production
vercel env add TWILIO_AUTH_TOKEN production
vercel env add TWILIO_WHATSAPP_FROM production
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY production
vercel env add SUPABASE_SECRET_KEY production

# For encryption v2 (new lazy migration):
vercel env add ENCRYPTION_KEY_V1 production  # Same as current ENCRYPTION_KEY
vercel env add ENCRYPTION_KEY_V2 production  # Same as current ENCRYPTION_KEY (for now)
```

### Step 3: Remove Runtime Secrets from GitHub

**⚠️ ONLY do this AFTER confirming they're in Vercel!**

```bash
# Via GitHub UI (easier):
# Go to: https://github.com/mandric/sitemgr/settings/secrets/actions
# Delete these one by one:
# - ENCRYPTION_KEY
# - ANTHROPIC_API_KEY
# - TWILIO_ACCOUNT_SID
# - TWILIO_AUTH_TOKEN
# - SUPABASE_SECRET_KEY

# Via gh CLI (if you have permissions):
gh secret remove ENCRYPTION_KEY
gh secret remove ANTHROPIC_API_KEY
gh secret remove TWILIO_ACCOUNT_SID
gh secret remove TWILIO_AUTH_TOKEN
gh secret remove SUPABASE_SECRET_KEY
```

**Keep these in GitHub:**
- ✅ `VERCEL_TOKEN` (CI needs this)
- ✅ `SUPABASE_ACCESS_TOKEN` (CI needs this)

### Step 4: Update CI Workflow

Replace the manual secret assignment with pulling from Vercel.

**Before (current):**
```yaml
- name: Set up environment
  run: |
    cat > .env.local <<EOF
    ENCRYPTION_KEY=${{ secrets.ENCRYPTION_KEY }}
    ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }}
    # ... etc
    EOF
```

**After (pull from Vercel):**
```yaml
- name: Pull environment variables from Vercel
  run: |
    cd web
    npx vercel env pull .env.ci \
      --token=${{ secrets.VERCEL_TOKEN }} \
      --environment=production \
      --yes
  env:
    VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}

- name: Set up environment (merge local test config)
  run: |
    cd web
    # Start with Vercel env
    cp .env.ci .env.local
    
    # Override with local test values for Supabase
    cat >> .env.local <<EOF
    NEXT_PUBLIC_SUPABASE_URL=${{ env.SUPABASE_URL }}
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${{ env.SUPABASE_PUBLISHABLE_KEY }}
    EOF
```

### Step 5: Update CI Workflow File

I'll create the updated workflow in the next file.

### Step 6: Test the Changes

```bash
# 1. Create a test branch
git checkout -b secret-management-cleanup

# 2. Commit the updated workflow
git add .github/workflows/ci.yml
git commit -m "Migrate to Vercel as single source of truth for secrets"

# 3. Push and create PR
git push origin secret-management-cleanup
gh pr create --title "Secret Management Cleanup" \
  --body "Migrate to using Vercel as single source of truth for runtime secrets"

# 4. Watch CI run
gh pr checks --watch

# 5. If tests pass, merge
gh pr merge --auto --squash
```

### Step 7: Verify Production Deployment

```bash
# After merge, check production deployment
vercel logs --prod

# Test the app
curl https://your-app.vercel.app/api/health

# Test WhatsApp bot (if applicable)
# Send a test message

# Test web UI
# Login and test bucket operations
```

## Rollback Plan

If something goes wrong:

```bash
# Option 1: Revert the PR
gh pr list --state merged --limit 1
gh pr view <number>
# Copy the commit SHA
git revert <sha>
git push origin main

# Option 2: Re-add secrets to GitHub temporarily
gh secret set ENCRYPTION_KEY < .env.local
gh secret set ANTHROPIC_API_KEY < .env.local
# etc.
```

## Verification Checklist

Before removing secrets from GitHub:

- [ ] Confirm all runtime secrets exist in Vercel (check UI)
- [ ] Confirm `VERCEL_TOKEN` is set in GitHub (needed to pull env)
- [ ] Confirm `SUPABASE_ACCESS_TOKEN` is set in GitHub (needed for migrations)
- [ ] Test `vercel env pull` works locally
- [ ] Review updated CI workflow
- [ ] Create test PR to validate CI works

After removing secrets from GitHub:

- [ ] CI tests pass
- [ ] Production deployment succeeds
- [ ] App works in production
- [ ] No secrets visible in GitHub that should be in Vercel
- [ ] Only `VERCEL_TOKEN` and `SUPABASE_ACCESS_TOKEN` in GitHub

## Benefits After Migration

✅ **Single source of truth** - Vercel owns runtime secrets
✅ **Less duplication** - No secrets in 2 places
✅ **Easier rotation** - Update once in Vercel
✅ **Better security** - Fewer places secrets can leak
✅ **Clearer ownership** - CI secrets in GitHub, runtime in Vercel
✅ **Simpler onboarding** - New devs: `vercel env pull .env.local`

## Next Steps

1. Review this plan
2. Verify what secrets you currently have (GitHub UI + Vercel UI)
3. Confirm all runtime secrets are in Vercel
4. Review the updated CI workflow (next file)
5. Execute Steps 3-7 when ready

