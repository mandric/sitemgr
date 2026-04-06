# Development Workflow

Quick reference for the development and deployment workflow.

## Daily Development

```bash
# 1. Start from main
git checkout main
git pull

# 2. Create feature branch
git checkout -b feature/my-feature

# 3. Make changes
# ... edit files ...

# 4. Test locally
cd web && npm run start:supabase  # Start Supabase local
cd web && npm run test:integration  # Run tests

# 5. Commit and push
git add .
git commit -m "Add my feature

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
git push origin feature/my-feature

# 6. Create Pull Request on GitHub
# - CI runs automatically (lint + integration tests)
# - Review changes
# - Merge when CI passes

# 7. Automatic deployment to test
# - Merging to main triggers test deployment
# - Test at https://[TEST_PROJECT_REF].supabase.co

# 8. Manual deployment to production (when ready)
# - Go to GitHub Actions
# - Run "Deploy to Supabase" workflow
# - Select "production" environment
# - Approve deployment
```

## Branch Strategy

```
main (protected)
  └─ Always deployable
  └─ CI required to merge
  └─ Auto-deploys to TEST
  └─ Manual deploy to PRODUCTION

feature/xyz
  └─ All development happens here
  └─ Create PR to merge to main
  └─ Delete after merge
```

## CI Pipeline

Every PR and push to main runs:

1. **Lint** - Code style check (ruff)
2. **Integration Tests** - Full pipeline test with Supabase local
   - Database initialization
   - Storage operations
   - S3 watcher
   - Query functionality
   - Edge Function health check

## Deployment Pipeline

### Test Environment (Automatic)

```
Push to main → GitHub Actions
             ↓
        Link Supabase test project
             ↓
        Run database migrations
             ↓
        Create storage bucket
             ↓
        Deploy Edge Function
             ↓
        Set secrets
             ↓
        ✅ Test environment live
```

### Production Environment (Manual)

```
Manual trigger → Approval required
              ↓
         [Same steps as test]
              ↓
         ✅ Production live
```

## Quick Commands

### Local Development

```bash
# Setup (first time)
./scripts/setup.sh

# Start local environment
cd web && npm run start:supabase && npm run setup:env

# Run tests
cd web && npm run test:integration

# Check environment health
cd web && npm run setup:verify
uv run python prototype/smgr.py query --type photo
uv run python prototype/smgr.py watch --once

# Test bot locally
uv run python prototype/bot.py --stdio
```

### Supabase CLI

```bash
# Start local Supabase
supabase start

# View status
supabase status

# Stop Supabase
supabase stop

# View logs
supabase logs

# Run migrations
supabase db push

# Test Edge Function locally
supabase functions serve whatsapp
```

### Git

```bash
# Create feature branch
git checkout -b feature/name

# Update from main
git checkout main
git pull
git checkout feature/name
git rebase main

# Push and create PR
git push origin feature/name

# Clean up after merge
git checkout main
git pull
git branch -d feature/name
git remote prune origin
```

## Decision Making

### When to create a feature branch?

**Always.** Never commit directly to main.

Even for small changes:
- Typo fix → feature branch → PR
- Documentation update → feature branch → PR
- Bug fix → feature branch → PR

### When to deploy to test?

**Automatically.** Every merge to main deploys to test.

### When to deploy to production?

**Manually, when test is validated:**
- Feature works in test environment
- No errors in Edge Function logs
- Bot responds correctly to messages
- Migrations applied successfully

### When to use feature flags?

**For risky or experimental features:**
- Large refactors
- Breaking changes
- A/B testing
- Gradual rollouts

Example:
```typescript
const FEATURE_NEW_PARSER = Deno.env.get("FEATURE_NEW_PARSER") === "true"
```

## Checklist for Production Deploy

Before deploying to production:

- [ ] Changes tested in test environment
- [ ] Edge Function logs show no errors
- [ ] Database migrations applied cleanly
- [ ] Bot responds correctly to test messages
- [ ] No breaking changes (or feature flag used)
- [ ] Twilio webhook configured (if needed)
- [ ] Secrets verified in Supabase Dashboard

## Rollback Procedure

If production has issues:

1. **Quick rollback:** Re-run last known good deployment from Actions
2. **Code rollback:** Create revert PR and deploy

```bash
# Create revert commit
git revert <bad-commit>
git push origin main

# This auto-deploys to test, verify it works
# Then manually deploy to production
```

## Getting Help

- **Deployment issues:** Check [DEPLOYMENT.md](./DEPLOYMENT.md)
- **Local development:** Check [TESTING.md](./TESTING.md)
- **Architecture:** Check [design/](../design/)
- **Supabase docs:** https://supabase.com/docs
- **GitHub Actions:** Repository Actions tab
