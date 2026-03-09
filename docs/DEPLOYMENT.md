# Deployment Guide

This project uses **GitHub Flow** with automatic deployment to a test environment and manual deployment to production.

## Deployment Strategy

```
feature/xyz → PR + CI → main → auto-deploy to TEST
                              → manual deploy to PRODUCTION
```

### Key Principles

1. **main is always deployable** - All changes must pass CI before merging
2. **Feature branches for all work** - No direct commits to main
3. **Test automatically from main** - Every push to main deploys to test environment
4. **Production on-demand** - Manual approval required for production deploys
5. **Feature flags for experiments** - Use flags for experimental features in production

## Workflow

### 1. Feature Development

```bash
# Create feature branch
git checkout -b feature/add-search

# Make changes, commit
git add .
git commit -m "Add search functionality"

# Push and create PR
git push origin feature/add-search
```

### 2. Pull Request & Review

- CI runs automatically (lint + integration tests)
- Review code changes
- Merge to main when CI passes

### 3. Automatic Test Deployment

- Push to main triggers deployment to test environment
- Test the changes in the test environment
- Monitor logs in Supabase Dashboard

### 4. Manual Production Deployment

When test environment is validated:

1. Go to **Actions** tab in GitHub
2. Select **Deploy to Supabase** workflow
3. Click **Run workflow**
4. Select `production` environment
5. Click **Run workflow**

Production deployment requires manual approval (configured in GitHub Environments).

## Environments

### Test Environment

- **Deployed from:** main branch (automatic)
- **Purpose:** Integration testing, validation before production
- **Supabase Project:** Separate test project
- **GitHub Environment:** `test`

### Production Environment

- **Deployed from:** main branch (manual trigger)
- **Purpose:** Live production environment
- **Supabase Project:** Production project
- **GitHub Environment:** `production` (requires approval)

## Initial Setup

### 1. Create Supabase Projects

Create two Supabase projects at https://supabase.com/dashboard:

1. **Test project** - for testing and development
2. **Production project** - for live production use

### 2. Get Supabase Credentials

For each project, collect:

- **Project Reference ID** - From the URL: `https://supabase.com/dashboard/project/[PROJECT_REF]`
- **Access Token** - From https://supabase.com/dashboard/account/tokens (create a new token)
- **Service Role Key** - From Project Settings > API > service_role key

### 3. Get Twilio Credentials

From https://console.twilio.com:

- **Account SID**
- **Auth Token**
- **WhatsApp From Number** - Format: `whatsapp:+1234567890`

### 4. Get Anthropic API Key

From https://console.anthropic.com/settings/keys

### 5. Configure GitHub Secrets

Go to **Repository Settings > Secrets and variables > Actions** and add:

#### Supabase Secrets

| Secret | Description | Example |
|--------|-------------|---------|
| `SUPABASE_ACCESS_TOKEN` | Supabase personal access token | `sbp_abc123...` |
| `SUPABASE_PROJECT_REF_TEST` | Test project reference ID | `abcdefghij` |
| `SUPABASE_PROJECT_REF_PROD` | Production project reference ID | `klmnopqrst` |
| `SUPABASE_SECRET_KEY` | Service role key (for storage setup) | `eyJhbGc...` |

#### Application Secrets

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key for the bot |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_WHATSAPP_FROM` | WhatsApp sender number |

### 6. Configure GitHub Environments

Go to **Repository Settings > Environments**:

#### Create `test` environment:
- No protection rules (deploys automatically)

#### Create `production` environment:
- ✅ Required reviewers: Add yourself
- ✅ Wait timer: 0 minutes (optional: add delay)

### 7. Configure Branch Protection

Go to **Repository Settings > Branches** and protect `main`:

- ✅ Require a pull request before merging
- ✅ Require status checks to pass before merging
  - Select: `Lint`
  - Select: `Integration Tests (Supabase Local)`
- ✅ Require branches to be up to date before merging
- ✅ Do not allow bypassing the above settings

## Testing the Deployment

### Test Environment

After deployment to test:

1. Check deployment logs in GitHub Actions
2. View Edge Function in Supabase Dashboard
3. Test the webhook endpoint:

```bash
curl -X POST https://[PROJECT_REF].supabase.co/functions/v1/whatsapp \
  -d "From=whatsapp:+1234567890&Body=how many photos do I have?"
```

4. Configure Twilio webhook (test number) to point to test Edge Function URL
5. Send WhatsApp messages to test the bot

### Production Environment

Same process as test, but use production Supabase project and production Twilio number.

## Monitoring

### Supabase Dashboard

- **Edge Function Logs:** Project > Edge Functions > whatsapp > Logs
- **Database:** Project > Database > Tables
- **Storage:** Project > Storage > Buckets > media

### GitHub Actions

- **Deployment History:** Actions tab > Deploy to Supabase
- **CI Status:** Actions tab > CI — Build & Test

## Rollback

If production deployment has issues:

1. Identify the last known good commit on main
2. Go to Actions > Deploy to Supabase
3. Find the successful deployment from that commit
4. Click "Re-run jobs" to redeploy that version

Alternatively, create a revert PR:

```bash
git revert <bad-commit-hash>
git push origin main
```

This will auto-deploy the revert to test, then manually deploy to production.

## Feature Flags

For experimental features that you want to test in production without affecting all users, use environment variables:

```typescript
// In Edge Function
const ENABLE_NEW_SEARCH = Deno.env.get("FEATURE_NEW_SEARCH") === "true"

if (ENABLE_NEW_SEARCH) {
  // New search logic
} else {
  // Old search logic
}
```

Toggle flags using Supabase secrets:

```bash
supabase secrets set FEATURE_NEW_SEARCH=true
```

## Troubleshooting

### Deployment fails with "Project not linked"

- Check that `SUPABASE_ACCESS_TOKEN` is valid
- Verify `SUPABASE_PROJECT_REF_TEST` or `SUPABASE_PROJECT_REF_PROD` is correct

### Edge Function returns 500 error

- Check Edge Function logs in Supabase Dashboard
- Verify all secrets are set: `ANTHROPIC_API_KEY`, `TWILIO_*`
- Test locally: `supabase functions serve whatsapp`

### Database migration fails

- Check migration syntax in Supabase Dashboard > SQL Editor
- Run migration manually: `supabase db push --dry-run` to preview

### Storage bucket not created

- Check that `SUPABASE_SECRET_KEY` is set
- Create bucket manually in Supabase Dashboard > Storage

## Cost Estimates

### Supabase Free Tier (per project)

- 500 MB Postgres storage
- 1 GB file storage
- 500K Edge Function invocations/month
- 2 GB bandwidth/month

**Recommendation:** Test and production both fit in free tier for personal use.

### Paid Tier (if needed)

- Pro: $25/month per project
- Includes: 8 GB database, 100 GB storage, 2M function invocations

## Next Steps

1. ✅ Complete initial setup (Supabase projects + GitHub secrets)
2. ✅ Test deployment to test environment
3. ✅ Validate test environment works
4. ✅ Deploy to production
5. ✅ Configure Twilio webhooks
6. 🎉 Start using the bot!
