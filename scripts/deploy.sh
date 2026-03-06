#!/bin/bash
# Deploy to Supabase from local machine
# This does the same thing as the GitHub Action workflow

set -e

echo "================================================"
echo "  Deploy to Supabase"
echo "================================================"
echo ""

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

# Check if logged in
if ! supabase projects list &> /dev/null; then
    echo "❌ Not logged in to Supabase"
    echo ""
    echo "Login with:"
    echo "  supabase login"
    exit 1
fi

# List projects to help user choose
echo "Available Supabase projects:"
supabase projects list
echo ""

# Prompt for project reference if not provided
if [ -z "$SUPABASE_PROJECT_REF" ]; then
    read -p "Enter your Supabase project reference ID: " SUPABASE_PROJECT_REF
fi

if [ -z "$SUPABASE_PROJECT_REF" ]; then
    echo "❌ Project reference ID required"
    exit 1
fi

echo ""
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
echo ""
echo "You need to set the following secrets:"
echo "  - ANTHROPIC_API_KEY"
echo "  - TWILIO_ACCOUNT_SID"
echo "  - TWILIO_AUTH_TOKEN"
echo "  - TWILIO_WHATSAPP_FROM"
echo ""
read -p "Set secrets now? (y/N) " -n 1 -r
echo

if [[ $REPLY =~ ^[Yy]$ ]]; then
    if [ -f .env.production ]; then
        echo "Loading secrets from .env.production..."
        source .env.production
    fi

    # Prompt for each secret if not set
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        read -p "Enter ANTHROPIC_API_KEY: " ANTHROPIC_API_KEY
    fi
    if [ -z "$TWILIO_ACCOUNT_SID" ]; then
        read -p "Enter TWILIO_ACCOUNT_SID: " TWILIO_ACCOUNT_SID
    fi
    if [ -z "$TWILIO_AUTH_TOKEN" ]; then
        read -p "Enter TWILIO_AUTH_TOKEN: " TWILIO_AUTH_TOKEN
    fi
    if [ -z "$TWILIO_WHATSAPP_FROM" ]; then
        read -p "Enter TWILIO_WHATSAPP_FROM (e.g., whatsapp:+1234567890): " TWILIO_WHATSAPP_FROM
    fi

    # Set secrets
    supabase secrets set \
        ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
        TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
        TWILIO_WHATSAPP_FROM="$TWILIO_WHATSAPP_FROM"

    echo "✅ Secrets configured"
else
    echo "⚠️  Skipping secrets. Set them later with:"
    echo "   supabase secrets set ANTHROPIC_API_KEY=..."
fi

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
