# Secret Management - Quick Reference

## TL;DR

**Vercel = Source of Truth for Runtime Secrets**

```bash
# Local dev: Pull secrets from Vercel
vercel env pull .env.local

# CI: Automatically pulls from Vercel
# (see .github/workflows/ci.yml)
```

## Where Secrets Live

| Secret | Location | Purpose |
|--------|----------|---------|
| `ENCRYPTION_KEY` | Vercel | Runtime - decrypt S3 credentials |
| `ANTHROPIC_API_KEY` | Vercel | Runtime - Claude API |
| `TWILIO_*` | Vercel | Runtime - WhatsApp bot |
| `SUPABASE_SECRET_KEY` | Vercel + GitHub | Runtime + deploy-time bucket creation |
| `NEXT_PUBLIC_*` | Vercel | Runtime - public config |
| `VERCEL_TOKEN` | GitHub | CI - deploy & pull env vars |
| `SUPABASE_ACCESS_TOKEN` | GitHub | CI - run migrations |

## Quick Actions

### Add a New Secret

```bash
# 1. Add to Vercel (source of truth)
vercel env add NEW_SECRET production

# 2. Pull locally
vercel env pull .env.local

# 3. CI automatically gets it on next run
# No GitHub changes needed!
```

### Rotate a Secret

```bash
# 1. Update in Vercel
vercel env rm ENCRYPTION_KEY production
vercel env add ENCRYPTION_KEY production
# (paste new value)

# 2. Pull locally
vercel env pull .env.local

# 3. Redeploy (triggers new env)
git commit --allow-empty -m "Trigger redeploy for secret rotation"
git push
```

### New Team Member Setup

```bash
git clone https://github.com/mandric/sitemgr.git
cd sitemgr/web
npm install
vercel link  # One-time: link to Vercel project
vercel env pull .env.local  # Get all secrets
npm run dev  # Ready!
```

## Full Documentation

- **Implementation Guide**: [SECRET_MANAGEMENT_IMPLEMENTATION.md](./SECRET_MANAGEMENT_IMPLEMENTATION.md)
- **Cleanup Plan**: [SECRET_CLEANUP_PLAN.md](./SECRET_CLEANUP_PLAN.md)
- **Strategy & Options**: [SECRET_MANAGEMENT_STRATEGY.md](./SECRET_MANAGEMENT_STRATEGY.md)

## Current Status

✅ CI workflow updated to pull from Vercel  
⏳ Pending: Remove duplicate secrets from GitHub  
⏳ Pending: Test with a PR

## Next Steps

See [SECRET_CLEANUP_PLAN.md](./SECRET_CLEANUP_PLAN.md) Steps 3-7
