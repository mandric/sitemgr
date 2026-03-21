diff --git a/scripts/local-dev.sh b/scripts/local-dev.sh
index ad1677e..dcfa439 100755
--- a/scripts/local-dev.sh
+++ b/scripts/local-dev.sh
@@ -2,150 +2,155 @@
 # Local development environment setup using Supabase CLI
 # This script starts a full local Supabase environment (Postgres + Storage + Edge Functions)
 
-set -e
-
-echo "================================================"
-echo "  Starting Supabase Local Development Environment"
-echo "================================================"
-echo ""
-
-# Check if Supabase CLI is installed
-if ! command -v supabase &> /dev/null; then
-    echo "Error: Supabase CLI not found. Install it first:"
-    echo "  brew install supabase/tap/supabase (macOS)"
-    echo "  https://supabase.com/docs/guides/cli/getting-started"
+set -euo pipefail
+IFS=$'\n\t'
+
+# ---------------------------------------------------------------------------
+# print_setup_env_vars — prints all required local env vars to stdout in
+# dotenv format (KEY=value). Redirect to .env.local to save them:
+#   ./scripts/local-dev.sh print_setup_env_vars > .env.local
+# ---------------------------------------------------------------------------
+print_setup_env_vars() {
+  local status_json
+  status_json=$(supabase status -o json 2>/dev/null) || true
+
+  if [ -z "$status_json" ]; then
+    echo "Error: 'supabase status -o json' returned no output." >&2
+    echo "Make sure Supabase is running: ./scripts/local-dev.sh" >&2
     exit 1
-fi
-
-# Check for Node.js
-if ! command -v node &> /dev/null; then
-    echo "Error: Node.js not found. Install Node.js 20+:"
-    echo "  https://nodejs.org/"
+  fi
+
+  local api_url anon_key service_role_key db_url s3_key_id s3_key_secret
+  api_url=$(echo "$status_json" | jq -r '.API_URL')
+  anon_key=$(echo "$status_json" | jq -r '.ANON_KEY')
+  service_role_key=$(echo "$status_json" | jq -r '.SERVICE_ROLE_KEY')
+  db_url=$(echo "$status_json" | jq -r '.DB_URL')
+  s3_key_id=$(echo "$status_json" | jq -r '.S3_PROTOCOL_ACCESS_KEY_ID')
+  s3_key_secret=$(echo "$status_json" | jq -r '.S3_PROTOCOL_ACCESS_KEY_SECRET')
+
+  local s3_endpoint
+  s3_endpoint="${api_url}/storage/v1/s3"
+
+  local encryption_key
+  encryption_key=$(openssl rand -base64 32)
+
+  # Validate required fields are non-empty
+  local missing=()
+  [ -z "$api_url" ] || [ "$api_url" = "null" ] && missing+=("API_URL")
+  [ -z "$anon_key" ] || [ "$anon_key" = "null" ] && missing+=("ANON_KEY")
+  [ -z "$service_role_key" ] || [ "$service_role_key" = "null" ] && missing+=("SERVICE_ROLE_KEY")
+  [ -z "$s3_key_id" ] || [ "$s3_key_id" = "null" ] && missing+=("S3_PROTOCOL_ACCESS_KEY_ID")
+  [ -z "$s3_key_secret" ] || [ "$s3_key_secret" = "null" ] && missing+=("S3_PROTOCOL_ACCESS_KEY_SECRET")
+
+  if [ ${#missing[@]} -gt 0 ]; then
+    echo "Error: The following fields were missing from 'supabase status -o json':" >&2
+    for f in "${missing[@]}"; do
+      echo "  - $f" >&2
+    done
+    echo "Try restarting Supabase: supabase stop && supabase start" >&2
     exit 1
-fi
-
-# Check if web dependencies are installed
-if [ ! -d "web/node_modules" ]; then
-    echo "Installing web dependencies..."
-    cd web && npm install && cd ..
-fi
-
-# Start Supabase (Postgres + Storage + Edge Functions + Studio)
-echo "Starting Supabase services..."
-supabase start
-
-echo ""
-echo "Extracting environment variables..."
-
-# Get Supabase connection details (keys are UPPERCASE in JSON)
-STATUS_JSON=$(supabase status -o json 2>/dev/null)
-
-if [ -n "$STATUS_JSON" ]; then
-    SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r '.API_URL // "http://localhost:54321"')
-    SUPABASE_ANON_KEY=$(echo "$STATUS_JSON" | jq -r '.ANON_KEY')
-    SUPABASE_SECRET_KEY=$(echo "$STATUS_JSON" | jq -r '.SERVICE_ROLE_KEY')
-    DB_URL=$(echo "$STATUS_JSON" | jq -r '.DB_URL')
-    STORAGE_S3_URL=$(echo "$STATUS_JSON" | jq -r '.STORAGE_S3_URL // .API_URL + "/storage/v1/s3"')
-
-    # Extract S3 credentials from table output (not in JSON)
-    STATUS_TABLE=$(supabase status 2>/dev/null)
-    AWS_ACCESS_KEY_ID=$(echo "$STATUS_TABLE" | grep "Access Key" | awk -F '│' '{print $3}' | tr -d ' ')
-    AWS_SECRET_ACCESS_KEY=$(echo "$STATUS_TABLE" | grep "Secret Key" | awk -F '│' '{print $3}' | tr -d ' ')
-else
-    echo "Warning: Could not get supabase status, using defaults"
-    SUPABASE_URL="http://localhost:54321"
-    SUPABASE_ANON_KEY=""
-    SUPABASE_SECRET_KEY=""
-    DB_URL=""
-    STORAGE_S3_URL="http://localhost:54321/storage/v1/s3"
-    AWS_ACCESS_KEY_ID="local-access-key"
-    AWS_SECRET_ACCESS_KEY="local-secret-key"
-fi
-
-STORAGE_ENDPOINT="$SUPABASE_URL/storage/v1"
-
-# Create storage bucket for media
-echo ""
-echo "Creating storage bucket 'media'..."
-curl -sf -X POST "$STORAGE_ENDPOINT/bucket" \
-  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
-  -H "Content-Type: application/json" \
-  -d '{"id":"media","name":"media","public":false}' \
-  2>/dev/null || echo "  (Bucket may already exist)"
-
-# Write environment file
-ENV_FILE=".env.local"
-cat > "$ENV_FILE" << EOF
-# Supabase Local Development Environment
-# Generated by scripts/local-dev.sh
-
-# Backend API (CLI + server-side)
-SMGR_API_URL=$SUPABASE_URL
-SMGR_API_KEY=$SUPABASE_ANON_KEY
-SUPABASE_SECRET_KEY=$SUPABASE_SECRET_KEY
-
-# Next.js frontend (browser-side, required by Next.js convention)
-NEXT_PUBLIC_SUPABASE_URL=$SUPABASE_URL
-NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$SUPABASE_ANON_KEY
-
-# smgr CLI configuration
-SMGR_S3_ENDPOINT=$STORAGE_S3_URL
+  fi
+
+  cat <<EOF
+# Supabase / API
+NEXT_PUBLIC_SUPABASE_URL=${api_url}
+SMGR_API_URL=${api_url}
+NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${anon_key}
+SMGR_API_KEY=${anon_key}
+SUPABASE_SECRET_KEY=${service_role_key}
+DATABASE_URL=${db_url}
+
+# S3 / Storage
+SMGR_S3_ENDPOINT=${s3_endpoint}
+AWS_ENDPOINT_URL_S3=${s3_endpoint}
 SMGR_S3_BUCKET=media
 SMGR_S3_REGION=local
+AWS_ACCESS_KEY_ID=${s3_key_id}
+AWS_SECRET_ACCESS_KEY=${s3_key_secret}
+
+# smgr CLI
 SMGR_DEVICE_ID=local-dev
 SMGR_AUTO_ENRICH=false
 
-# For S3 compatibility
-AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
-AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
-AWS_ENDPOINT_URL_S3=$STORAGE_S3_URL
-
-# Database (for direct connections if needed)
-DATABASE_URL=$DB_URL
-
-# Enrichment (set your real API key for testing)
-SMGR_ENRICHMENT_PROVIDER=anthropic
-# ANTHROPIC_API_KEY=sk-ant-...  # Uncomment and add your key
+# Encryption (generated fresh — local dev data is ephemeral)
+ENCRYPTION_KEY_CURRENT=${encryption_key}
 
-# Bot configuration (optional, for local testing)
-# TWILIO_ACCOUNT_SID=...
-# TWILIO_AUTH_TOKEN=...
-# TWILIO_WHATSAPP_FROM=whatsapp:+...
+# Optional — uncomment and fill in as needed
+# ANTHROPIC_API_KEY=
+# TWILIO_ACCOUNT_SID=
+# TWILIO_AUTH_TOKEN=
+# TWILIO_WHATSAPP_FROM=
 EOF
-
-echo ""
-echo "================================================"
-echo "  LOCAL ENVIRONMENT READY"
-echo "================================================"
-echo ""
-echo "Supabase Studio:  http://localhost:54323"
-echo "API URL:          $SUPABASE_URL"
-echo "Storage API:      $STORAGE_ENDPOINT"
-echo "Database:         $DB_URL"
-echo ""
-echo "Environment variables saved to: $ENV_FILE"
-echo "Load them with: source $ENV_FILE"
-echo ""
-echo "------------------------------------------------"
-echo "  Quick Start Commands"
-echo "------------------------------------------------"
-echo ""
-echo "1. Load environment:"
-echo "   source $ENV_FILE"
-echo ""
-echo "2. Check status:"
-echo "   cd web && npm run smgr stats"
-echo ""
-echo "3. Watch for S3 changes:"
-echo "   cd web && npm run smgr watch"
-echo ""
-echo "4. Run unit tests:"
-echo "   cd web && npm test"
-echo ""
-echo "5. Run integration tests:"
-echo "   ./tests/integration_test.sh"
-echo ""
-echo "------------------------------------------------"
-echo "To stop Supabase: supabase stop"
-echo "To view logs:     supabase logs"
-echo ""
+}
+
+# ---------------------------------------------------------------------------
+# start_supabase — idempotent: skips start if already running
+# ---------------------------------------------------------------------------
+start_supabase() {
+  # Check for Supabase CLI
+  if ! command -v supabase &> /dev/null; then
+    echo "Error: Supabase CLI not found. Install it first:" >&2
+    echo "  brew install supabase/tap/supabase (macOS)" >&2
+    echo "  https://supabase.com/docs/guides/cli/getting-started" >&2
+    exit 1
+  fi
+
+  echo "================================================"
+  echo "  Starting Supabase Local Development Environment"
+  echo "================================================"
+  echo ""
+
+  if supabase status > /dev/null 2>&1; then
+    echo "Supabase already running, skipping start."
+    supabase status
+  else
+    echo "Starting Supabase services..."
+    supabase start
+  fi
+
+  echo ""
+  echo "================================================"
+  echo "  LOCAL ENVIRONMENT READY"
+  echo "================================================"
+  echo ""
+  echo "Supabase Studio:  http://localhost:54323"
+  echo ""
+  echo "------------------------------------------------"
+  echo "  Quick Start Commands"
+  echo "------------------------------------------------"
+  echo ""
+  echo "Save environment variables:"
+  echo "  ./scripts/local-dev.sh print_setup_env_vars > .env.local"
+  echo ""
+  echo "Verify setup:"
+  echo "  ./scripts/setup/verify.sh"
+  echo ""
+  echo "Run unit tests:"
+  echo "  cd web && npm test"
+  echo ""
+  echo "Run integration tests:"
+  echo "  ./scripts/test-integration.sh"
+  echo ""
+  echo "------------------------------------------------"
+  echo "To stop Supabase: supabase stop"
+  echo "To view logs:     supabase logs"
+  echo ""
+}
+
+# ---------------------------------------------------------------------------
+# Subcommand dispatch
+# ---------------------------------------------------------------------------
+COMMAND="${1:-}"
+case "$COMMAND" in
+  print_setup_env_vars)
+    print_setup_env_vars
+    ;;
+  "")
+    start_supabase
+    ;;
+  *)
+    echo "Unknown command: $COMMAND" >&2
+    echo "Usage: $0 [print_setup_env_vars]" >&2
+    exit 1
+    ;;
+esac
