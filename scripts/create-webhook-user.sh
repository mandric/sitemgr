#!/usr/bin/env bash
# Creates the webhook service account user via GoTrue admin API.
#
# Must run AFTER `supabase start` so GoTrue is available.
# Idempotent: skips creation if the user already exists.
#
# Usage:
#   ./scripts/create-webhook-user.sh [SUPABASE_URL] [SERVICE_ROLE_KEY]
#
# If arguments are not provided, reads from supabase status.

set -euo pipefail

WEBHOOK_UUID="00000000-0000-0000-0000-000000000001"
WEBHOOK_EMAIL="webhook@sitemgr.internal"
WEBHOOK_PASSWORD="unused-password-webhook-uses-service-token"

API_URL="${1:-}"
SERVICE_KEY="${2:-}"

if [ -z "$API_URL" ] || [ -z "$SERVICE_KEY" ]; then
  if ! command -v npx &>/dev/null; then
    echo "Error: npx not found and no API_URL/SERVICE_KEY args provided" >&2
    exit 1
  fi
  STATUS_JSON=$(npx supabase status -o json 2>/dev/null || true)
  if [ -z "$STATUS_JSON" ]; then
    echo "Error: supabase status returned nothing. Is Supabase running?" >&2
    exit 1
  fi
  API_URL=$(echo "$STATUS_JSON" | jq -r '.API_URL')
  SERVICE_KEY=$(echo "$STATUS_JSON" | jq -r '.SERVICE_ROLE_KEY')
fi

AUTH_URL="${API_URL}/auth/v1"

# Check if user already exists
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "apikey: ${SERVICE_KEY}" \
  "${AUTH_URL}/admin/users/${WEBHOOK_UUID}")

if [ "$HTTP_CODE" = "200" ]; then
  echo "Webhook service account already exists (${WEBHOOK_UUID})"
  exit 0
fi

# Create the user via GoTrue admin API
RESPONSE=$(curl -s -w '\n%{http_code}' \
  -X POST \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"${WEBHOOK_UUID}\",
    \"email\": \"${WEBHOOK_EMAIL}\",
    \"password\": \"${WEBHOOK_PASSWORD}\",
    \"email_confirm\": true,
    \"role\": \"authenticated\",
    \"app_metadata\": {\"provider\": \"email\", \"providers\": [\"email\"]}
  }" \
  "${AUTH_URL}/admin/users")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "Webhook service account created successfully (${WEBHOOK_UUID})"
else
  echo "Error creating webhook user (HTTP ${HTTP_CODE}):" >&2
  echo "$BODY" >&2
  exit 1
fi
