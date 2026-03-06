#!/bin/bash
# Deploy to Supabase from local machine
# This does the same thing as the GitHub Action workflow

set -e

echo "================================================"
echo "  Deploy to Supabase"
echo "================================================"
echo ""

# Require .env.production
if [ ! -f .env.production ]; then
    echo "❌ .env.production not found"
    echo ""
    echo "Create it from the example:"
    echo "  cp .env.example .env.production"
    echo "  # Then edit .env.production with your values"
    echo ""
    exit 1
fi

# Load .env.production
echo "Loading configuration from .env.production..."
source .env.production

# Validate required variables
REQUIRED_VARS=(
    "SUPABASE_ACCESS_TOKEN"
    "SUPABASE_PROJECT_REF"
    "ANTHROPIC_API_KEY"
    "TWILIO_ACCOUNT_SID"
    "TWILIO_AUTH_TOKEN"
    "TWILIO_WHATSAPP_FROM"
)

MISSING_VARS=()
for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        MISSING_VARS+=("$var")
    fi
done

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    echo ""
    echo "❌ Missing required environment variables in .env.production:"
    for var in "${MISSING_VARS[@]}"; do
        echo "  - $var"
    done
    echo ""
    echo "Edit .env.production and set all required values."
    echo "See .env.example for reference."
    echo ""
    exit 1
fi

echo "✓ All required variables set"
echo ""

# Export SUPABASE_ACCESS_TOKEN for CLI authentication
export SUPABASE_ACCESS_TOKEN

# Check if supabase CLI is installed
if ! command -v supabase &> /dev/null; then
    echo "❌ Supabase CLI not found"
    echo ""
    echo "Install it with:"
    echo "  brew install supabase/tap/supabase"
    echo "  # or"
    echo "  npm install -g supabase"
    exit 1
fi

# Verify access token works
if ! supabase projects list &> /dev/null; then
    echo "❌ Failed to authenticate with Supabase"
    echo ""
    echo "Check that SUPABASE_ACCESS_TOKEN in .env.production is valid."
    echo "Get a new token from: https://supabase.com/dashboard/account/tokens"
    exit 1
fi

echo "🚀 Deploying to: $SUPABASE_PROJECT_REF"
echo ""

# Link to project
echo "→ Linking to Supabase project..."
supabase link --project-ref "$SUPABASE_PROJECT_REF"

# Run migrations
echo ""
echo "→ Running database migrations..."
echo "   Dry run first to preview changes:"
supabase db push --dry-run
echo ""
read -p "Apply these migrations? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Deployment cancelled"
    exit 1
fi

supabase db push

# Create storage bucket
echo ""
echo "→ Creating media storage bucket..."
SUPABASE_URL="https://${SUPABASE_PROJECT_REF}.supabase.co"

# Get service role key from the linked project
SERVICE_ROLE_KEY=$(supabase status -o json 2>/dev/null | jq -r '.SERVICE_ROLE_KEY // empty')
if [ -z "$SERVICE_ROLE_KEY" ]; then
    echo "⚠️  Could not get service role key from local status"
    echo "   You may need to create the 'media' bucket manually in Supabase Dashboard"
else
    curl -sf -X POST "${SUPABASE_URL}/storage/v1/bucket" \
      -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
      -H "Content-Type: application/json" \
      -d '{"id":"media","name":"media","public":false}' \
      && echo "✓ Bucket created" \
      || echo "✓ Bucket already exists"
fi

# Deploy Edge Functions
echo ""
echo "→ Deploying Edge Function: whatsapp..."
supabase functions deploy whatsapp --no-verify-jwt

# Set secrets
echo ""
echo "→ Setting Edge Function secrets..."
supabase secrets set \
    ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
    TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
    TWILIO_WHATSAPP_FROM="$TWILIO_WHATSAPP_FROM"

echo "✅ Secrets configured"

# Summary
FUNCTION_URL="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/whatsapp"

echo ""
echo "================================================"
echo "  ✅ Deployment Complete"
echo "================================================"
echo ""
echo "Edge Function URL:"
echo "  $FUNCTION_URL"
echo ""
echo "Supabase Dashboard:"
echo "  https://supabase.com/dashboard/project/${SUPABASE_PROJECT_REF}"
echo ""
echo "Next steps:"
echo "  1. Test the Edge Function:"
echo "     curl -X POST \"$FUNCTION_URL\" \\"
echo "       -d \"From=whatsapp:+1234567890&Body=test\""
echo ""
echo "  2. Configure Twilio webhook to point to:"
echo "     $FUNCTION_URL"
echo ""
echo "  3. Send a WhatsApp message to test end-to-end"
echo ""
echo "🎉 Ready to use!"
echo ""
