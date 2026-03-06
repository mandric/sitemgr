# Quick Start: Deploy to Supabase

Get sitemgr deployed and running in ~10 minutes.

## Prerequisites

1. **Supabase account** - https://supabase.com (free tier is fine)
2. **Supabase CLI** - Install with `brew install supabase/tap/supabase` or `npm install -g supabase`
3. **API keys** (optional for initial deploy, required for bot functionality):
   - Anthropic API key (for Claude)
   - Twilio account (for WhatsApp)

## Step 1: Create Supabase Project (2 minutes)

1. Go to https://supabase.com/dashboard
2. Click "New project"
3. Choose:
   - Organization: (your org)
   - Name: `sitemgr` (or whatever you like)
   - Database Password: (generate strong password)
   - Region: Choose closest to you
4. Click "Create new project"
5. Wait ~2 minutes for project to provision
6. **Save the Project Reference ID** - it's in the URL: `https://supabase.com/dashboard/project/[THIS-IS-THE-REF]`

## Step 2: Configure Secrets (2 minutes)

Create your production environment file:

```bash
# Copy the template
cp .env.production.template .env.production

# Edit with your values
nano .env.production  # or use your favorite editor
```

Fill in:
- `SUPABASE_PROJECT_REF` - Your project reference ID
- `ANTHROPIC_API_KEY` - From https://console.anthropic.com/settings/keys
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` - From https://console.twilio.com
- `TWILIO_WHATSAPP_FROM` - Your WhatsApp number like `whatsapp:+1234567890`

**Don't worry** - `.env.production` is gitignored and won't be committed.

## Step 3: Deploy from Laptop (5 minutes)

```bash
# Login to Supabase CLI (first time only)
supabase login

# Run deployment script
./scripts/deploy.sh
```

The script will:
1. Load configuration from `.env.production`
2. Show your available projects
3. Ask for confirmation (uses `SUPABASE_PROJECT_REF` from .env.production)
4. Preview database migrations
5. Deploy everything and set secrets automatically

**First time without .env.production?** The script will prompt you for each value interactively.

## Step 3: Test the Deployment (1 minute)

After deployment completes, test the Edge Function:

```bash
# Copy the Function URL from the deployment output, then:
curl -X POST "https://YOUR-PROJECT-REF.supabase.co/functions/v1/whatsapp" \
  -d "From=whatsapp:+1234567890&Body=test"
```

If secrets are set, you should get a response from Claude. If not, you'll see an error about missing API keys (that's okay!).

## Step 4: Verify Secrets (if needed)

If you skipped setting secrets or need to update them:

```bash
# Link to your project first
supabase link --project-ref YOUR-PROJECT-REF

# Set secrets manually
supabase secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  TWILIO_ACCOUNT_SID=AC... \
  TWILIO_AUTH_TOKEN=... \
  TWILIO_WHATSAPP_FROM=whatsapp:+1234567890
```

Or update `.env.production` and run `./scripts/deploy.sh` again.

## Step 5: Configure GitHub Actions (optional, 2 minutes)

To enable automatic deployment from GitHub:

1. Go to **Repository Settings > Environments**
2. Click "New environment"
3. Name it `production`
4. (Optional) Add yourself as required reviewer for extra safety

5. Go to **Repository Settings > Secrets and variables > Actions**
6. Add repository secrets:
   - `SUPABASE_ACCESS_TOKEN` - Get from https://supabase.com/dashboard/account/tokens
   - `SUPABASE_PROJECT_REF` - Your project reference ID
   - `SUPABASE_SERVICE_ROLE_KEY` - From Project Settings > API > service_role
   - `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`

Now every push to `main` will auto-deploy!

## Step 6: Test End-to-End with WhatsApp (2 minutes)

1. Go to Twilio Console: https://console.twilio.com
2. Navigate to **Messaging > Try it out > Send a WhatsApp message**
3. Configure webhook:
   - When a message comes in: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/whatsapp`
   - Method: POST
4. Send a test message to your Twilio WhatsApp number
5. You should get a response from the bot!

## Next Steps

- **Upload photos**: Use the `smgr` CLI to upload media to Supabase Storage
- **Query via WhatsApp**: "show me my photos", "how many photos do I have?"
- **View in Dashboard**: Check Supabase Dashboard to see events, storage, and logs
- **Monitor**: Edge Functions > whatsapp > Logs to see bot conversations

## Troubleshooting

### "supabase: command not found"

Install the CLI:
```bash
brew install supabase/tap/supabase
# or
npm install -g supabase
```

### "Not logged in to Supabase"

```bash
supabase login
```

This opens a browser to authenticate.

### Edge Function returns 500 error

Check the logs:
1. Go to Supabase Dashboard
2. Edge Functions > whatsapp > Logs
3. Look for error messages

Common issues:
- Missing secrets (ANTHROPIC_API_KEY, TWILIO_*)
- Invalid API keys
- Twilio signature validation (check TWILIO_AUTH_TOKEN)

### Database migration fails

View the error in the deployment output. Usually:
- Syntax error in SQL
- Conflicting schema change

Fix the migration file in `supabase/migrations/` and redeploy.

## Deploy Again

```bash
./scripts/deploy.sh
```

It's safe to run multiple times - it will:
- Update migrations (only apply new ones)
- Redeploy Edge Functions (zero downtime)
- Update secrets (only if you choose to)

## Local Development

```bash
# Start local Supabase
./scripts/local-dev.sh

# Run tests
./tests/integration_test.sh

# Test bot locally
uv run python prototype/bot.py --stdio
```

See [WORKFLOW.md](./WORKFLOW.md) for the full development workflow.
