# Secret Management Strategy

## Current Problem

**You have secrets duplicated in two places:**

1. **GitHub Secrets/Variables** (for CI/CD)
   - `ENCRYPTION_KEY`
   - `ANTHROPIC_API_KEY`
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `SUPABASE_ACCESS_TOKEN`
   - `SUPABASE_SECRET_KEY`
   - `VERCEL_TOKEN`
   - Plus vars: `VERCEL_PROJECT_ID`, `VERCEL_APP_URL`, etc.

2. **Vercel Environment Variables** (for runtime)
   - `ENCRYPTION_KEY`
   - `ANTHROPIC_API_KEY`
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY`
   - `TWILIO_*` variables

**Problems with this setup:**
- ❌ Secrets in multiple places = more to manage
- ❌ Easy to get out of sync
- ❌ Security risk (more places to leak)
- ❌ Unclear which is source of truth
- ❌ Manual updates required in 2+ places

## Secret Categories

Let's classify your secrets first:

### 1. Runtime Secrets (Application needs these)
- `ENCRYPTION_KEY` - Decrypt bucket credentials
- `ANTHROPIC_API_KEY` - Call Claude API
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` - Send WhatsApp messages
- `NEXT_PUBLIC_SUPABASE_URL` - Connect to Supabase
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` - Client-side Supabase
- `SUPABASE_SECRET_KEY` - Server-side Supabase

### 2. Build/Deploy-Time Secrets (CI/CD needs these)
- `VERCEL_TOKEN` - Deploy to Vercel
- `SUPABASE_ACCESS_TOKEN` - Run migrations

### 3. Configuration (Not really secret)
- `VERCEL_PROJECT_ID` - Vercel project identifier
- `VERCEL_APP_URL` - Your app URL
- `SUPABASE_PROJECT_REF` - Supabase project identifier
- `TWILIO_WHATSAPP_FROM` - Phone number (not secret)

## Best Practice Options (Ranked)

### ⭐ Option 1: Single Source of Truth (Vercel) - RECOMMENDED

**How it works:**
- Store ALL secrets in Vercel
- CI/CD pulls secrets from Vercel at runtime
- Zero duplication

**Implementation:**

```yaml
# .github/workflows/ci.yml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      # Pull ALL env vars from Vercel
      - name: Pull environment variables from Vercel
        run: |
          npx vercel env pull .env.ci --token=${{ secrets.VERCEL_TOKEN }}
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      
      # Now use them
      - name: Run tests with Vercel env
        run: |
          source .env.ci
          cd web && npm test
```

**Secrets needed in GitHub:** Only 1!
- `VERCEL_TOKEN` (to pull others)

**Pros:**
- ✅ **Single source of truth** (Vercel)
- ✅ **Minimal GitHub secrets** (just 1)
- ✅ **Automatic sync** (always latest from Vercel)
- ✅ **Simple management** (update 1 place)

**Cons:**
- ⚠️ Vercel becomes critical dependency for CI
- ⚠️ Slower (API call to fetch env vars)
- ⚠️ CI requires network access to Vercel

**When to use:** ✅ When Vercel is your production platform

---

### ⭐⭐ Option 2: Secret Manager (1Password, Vault, AWS Secrets Manager)

**How it works:**
- Store secrets in dedicated secret manager
- Both GitHub Actions AND Vercel pull from it
- True single source of truth

**Example with 1Password:**

```yaml
# .github/workflows/ci.yml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Load secrets from 1Password
        uses: 1password/load-secrets-action@v1
        with:
          export-env: true
        env:
          OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
          ENCRYPTION_KEY: "op://Engineering/sitemgr-encryption-key/password"
          ANTHROPIC_API_KEY: "op://Engineering/sitemgr-anthropic/api-key"
          # etc.
      
      - name: Run tests
        run: cd web && npm test
        # All secrets available as env vars
```

**In Vercel:**
```bash
# Use 1Password CLI to sync secrets to Vercel
op inject -i vercel-env-template.txt | vercel env add
```

Or use Vercel's 1Password integration (if available).

**Pros:**
- ✅ **True single source of truth**
- ✅ **Audit trail** (who accessed what, when)
- ✅ **Secret rotation** (centralized)
- ✅ **Team access control** (fine-grained)
- ✅ **Secrets never in git** (even .env files)

**Cons:**
- ⚠️ Additional cost ($8-20/mo for 1Password Business)
- ⚠️ More complexity
- ⚠️ Learning curve

**When to use:** ✅ When you have a team, need audit trails, or are serious about security

---

### Option 3: Infrastructure as Code (Terraform/Pulumi)

**How it works:**
- Define all secrets in code (encrypted)
- Apply to both GitHub and Vercel via IaC

**Example with Terraform:**

```hcl
# terraform/secrets.tf
resource "github_actions_secret" "encryption_key" {
  repository       = "sitemgr"
  secret_name      = "ENCRYPTION_KEY"
  plaintext_value  = var.encryption_key  # From terraform.tfvars (gitignored)
}

resource "vercel_project_environment_variable" "encryption_key" {
  project_id = vercel_project.sitemgr.id
  key        = "ENCRYPTION_KEY"
  value      = var.encryption_key
  target     = ["production"]
}
```

**Pros:**
- ✅ **Declarative** (see all secrets in code)
- ✅ **Version controlled** (encrypted state)
- ✅ **Reproducible** (terraform apply)

**Cons:**
- ⚠️ High complexity
- ⚠️ Secrets still in tfstate (must encrypt)
- ⚠️ Overkill for solo dev

**When to use:** ✅ When you have 10+ services, infrastructure team, or enterprise requirements

---

### Option 4: Keep Current Setup (Improved)

**If you want to keep GitHub + Vercel separate, at least optimize:**

**Principle: Minimize duplication**

```
Runtime-only secrets  → Vercel ONLY
CI-only secrets      → GitHub ONLY  
Shared secrets       → Use Vercel as source, pull in CI
```

**Updated approach:**

```yaml
# .github/workflows/ci.yml

# CI-only secrets (stored in GitHub)
env:
  VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
  SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

jobs:
  test:
    steps:
      # For tests, use Vercel's production env (pull once)
      - name: Get runtime secrets from Vercel
        run: npx vercel env pull .env.test --token=${{ secrets.VERCEL_TOKEN }}
      
      - name: Run tests
        run: |
          source .env.test
          cd web && npm test

  deploy:
    steps:
      # Vercel deployment automatically uses its own env vars
      - name: Deploy
        run: vercel deploy --prod --token=${{ secrets.VERCEL_TOKEN }}
```

**Secrets in GitHub (minimal):**
- `VERCEL_TOKEN` (deploy + pull env)
- `SUPABASE_ACCESS_TOKEN` (migrations)

**Secrets in Vercel (runtime):**
- Everything else (`ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, etc.)

**Pros:**
- ✅ Minimal duplication
- ✅ No new tools
- ✅ Clear separation (CI vs runtime)

**Cons:**
- ⚠️ Still 2 places to manage
- ⚠️ Can drift if you forget to pull

---

## Recommendation for sitemgr

**Phase 1 (Now): Option 4 - Minimize duplication**

You're solo dev, pre-launch. Keep it simple:

1. **Store runtime secrets ONLY in Vercel**
   - `ENCRYPTION_KEY`
   - `ANTHROPIC_API_KEY`
   - `TWILIO_*`
   - `SUPABASE_SECRET_KEY`
   - `NEXT_PUBLIC_*`

2. **Store CI-only secrets in GitHub**
   - `VERCEL_TOKEN`
   - `SUPABASE_ACCESS_TOKEN`

3. **Pull Vercel env for tests** (avoid duplication)

**Phase 2 (When you raise funding / hire team): Option 2 - Secret Manager**

Migrate to 1Password or similar:
- Better security
- Audit trail
- Team access control
- Worth the $20/mo

---

## Implementation: Clean Up Current Setup

### Step 1: Audit what you have

```bash
# List GitHub secrets
gh secret list

# List Vercel env vars
vercel env ls

# Compare
```

### Step 2: Decide source of truth

For each secret, choose ONE place:

| Secret | Source of Truth | Why |
|--------|----------------|-----|
| `ENCRYPTION_KEY` | Vercel | Runtime secret |
| `ANTHROPIC_API_KEY` | Vercel | Runtime secret |
| `TWILIO_*` | Vercel | Runtime secret |
| `SUPABASE_SECRET_KEY` | Vercel | Runtime secret |
| `NEXT_PUBLIC_*` | Vercel | Runtime config |
| `VERCEL_TOKEN` | GitHub | CI-only |
| `SUPABASE_ACCESS_TOKEN` | GitHub | CI-only |

### Step 3: Remove duplicates

```bash
# Remove runtime secrets from GitHub (they're in Vercel)
gh secret remove ENCRYPTION_KEY
gh secret remove ANTHROPIC_API_KEY
gh secret remove TWILIO_ACCOUNT_SID
gh secret remove TWILIO_AUTH_TOKEN
gh secret remove SUPABASE_SECRET_KEY

# Keep only CI-specific ones
# VERCEL_TOKEN - needed for deploy
# SUPABASE_ACCESS_TOKEN - needed for migrations
```

### Step 4: Update CI to pull from Vercel

```yaml
# .github/workflows/ci.yml

jobs:
  integration-tests:
    steps:
      # ... existing steps ...
      
      # NEW: Pull Vercel env vars for testing
      - name: Pull production environment variables
        run: |
          npx vercel env pull .env.ci \
            --token=${{ secrets.VERCEL_TOKEN }} \
            --environment=production
      
      - name: Run web tests with real env
        run: |
          cd web
          # Load Vercel env
          export $(cat ../.env.ci | xargs)
          # Override with test-specific values
          export NEXT_PUBLIC_SUPABASE_URL=${{ env.SUPABASE_URL }}
          export SUPABASE_SECRET_KEY=${{ env.SUPABASE_SECRET_KEY }}
          npm test
```

### Step 5: Document in .env.example

```bash
# .env.example

# ── Source of Truth ───────────────────────────────────────────
# ALL secrets below are stored in Vercel (production)
# To get them locally: vercel env pull .env.local
# To get them in CI: already pulled automatically

# NEVER commit actual values to git!
# This file is just documentation of what's needed.

# ── Runtime Secrets (from Vercel) ────────────────────────────
ENCRYPTION_KEY=          # Source: Vercel env vars
ANTHROPIC_API_KEY=       # Source: Vercel env vars
TWILIO_ACCOUNT_SID=      # Source: Vercel env vars
TWILIO_AUTH_TOKEN=       # Source: Vercel env vars

# ── CI-Only Secrets (GitHub) ──────────────────────────────────
# VERCEL_TOKEN=          # Source: GitHub secrets (for deploy)
# SUPABASE_ACCESS_TOKEN= # Source: GitHub secrets (for migrations)
```

---

## Secret Rotation Procedure

### Current (Manual, Error-Prone):
```bash
# Ugh, have to update everywhere...
vercel env add ENCRYPTION_KEY production
gh secret set ENCRYPTION_KEY
# Update .env.local
# Update teammate's .env.local
# Update staging
# etc.
```

### With Option 1 (Vercel as source):
```bash
# Update in ONE place
vercel env add ENCRYPTION_KEY production

# CI automatically gets new value next run (pulls from Vercel)
# Done!
```

### With Option 2 (Secret manager):
```bash
# Update in 1Password
op item edit "sitemgr-encryption-key" password="new-key"

# Sync to Vercel
op inject -i vercel-env.txt | vercel env add

# CI pulls from 1Password (automatic)
# Done!
```

---

## Security Best Practices

### 1. Never Commit Secrets

```bash
# .gitignore (already there, but verify)
.env
.env.local
.env.*.local
.env.production
.env.ci

# Exception: .env.example (no actual values)
```

### 2. Rotate Regularly

```bash
# Schedule in calendar
# Every 90 days:
# - Rotate ENCRYPTION_KEY (use lazy migration!)
# - Rotate ANTHROPIC_API_KEY
# - Rotate SUPABASE tokens
# - Rotate Twilio tokens
```

### 3. Use Least Privilege

```bash
# Vercel env vars: scope to specific environments
vercel env add SECRET production      # Only prod
vercel env add SECRET preview,development  # Not prod

# GitHub secrets: scope to specific workflows (not possible yet, but future)
```

### 4. Audit Access

```bash
# Vercel: Check who has access
vercel teams list

# GitHub: Check who can access secrets
gh api repos/mandric/sitemgr/collaborators
```

---

## Migration Plan

### This Week: Clean Up

```bash
# 1. Audit
gh secret list > github-secrets.txt
vercel env ls > vercel-env.txt
diff github-secrets.txt vercel-env.txt

# 2. Remove duplicates from GitHub
gh secret remove ENCRYPTION_KEY
gh secret remove ANTHROPIC_API_KEY
# (keep VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN)

# 3. Update CI to pull from Vercel (see Step 4 above)

# 4. Test
git push origin main  # Trigger CI
# Verify tests still pass
```

### Next Quarter: Consider Secret Manager

When you:
- Hire team members
- Raise funding
- Need audit trails
- Want better security

Then migrate to 1Password or similar.

---

## Quick Decision Matrix

| Your Situation | Recommendation |
|---------------|---------------|
| Solo dev, pre-launch | ✅ Option 1 or 4 (Vercel as source) |
| Small team (2-5) | ✅ Option 2 (1Password) |
| Medium team (5-20) | ✅ Option 2 (Vault or AWS Secrets) |
| Enterprise | ✅ Option 3 (IaC + Secret Manager) |

---

## Bottom Line

**For sitemgr RIGHT NOW:**

1. ✅ **Use Vercel as single source of truth** for runtime secrets
2. ✅ **Keep GitHub secrets minimal** (VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN only)
3. ✅ **Pull Vercel env in CI** (avoid duplication)
4. ✅ **Document in .env.example** (which secret lives where)
5. 📅 **Migrate to secret manager later** (when you have team/funding)

This gives you:
- Simple (no new tools)
- Secure (minimal duplication)
- Scalable (easy to migrate to secret manager later)
- Clear (one source of truth)

Want me to help you implement the cleanup (remove duplicates from GitHub, update CI to pull from Vercel)?
