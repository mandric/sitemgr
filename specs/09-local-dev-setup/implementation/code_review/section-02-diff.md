diff --git a/scripts/test-integration.sh b/scripts/test-integration.sh
index 277e21d..e2b6497 100755
--- a/scripts/test-integration.sh
+++ b/scripts/test-integration.sh
@@ -54,36 +54,16 @@ else
   supabase start
 fi
 
-# Extract connection details
-STATUS_JSON=$(supabase status -o json 2>/dev/null)
-
-SMGR_API_URL=$(echo "$STATUS_JSON" | jq -r '.API_URL // "http://127.0.0.1:54321"')
-SMGR_API_KEY=$(echo "$STATUS_JSON" | jq -r '.ANON_KEY')
-SUPABASE_SECRET_KEY=$(echo "$STATUS_JSON" | jq -r '.SERVICE_ROLE_KEY')
-
-export SMGR_API_URL
-export SMGR_API_KEY
-export SUPABASE_SECRET_KEY
-
-echo "  API URL:    $SMGR_API_URL"
-echo "  API Key:    ${SMGR_API_KEY:0:20}..."
-echo "  Secret Key: ${SUPABASE_SECRET_KEY:0:20}..."
-
-# Ensure the 'media' storage bucket exists (for S3 e2e tests)
-STORAGE_ENDPOINT="$SMGR_API_URL/storage/v1"
-curl -sf -X POST "$STORAGE_ENDPOINT/bucket" \
-  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
-  -H "Content-Type: application/json" \
-  -d '{"id":"media","name":"media","public":false}' \
-  2>/dev/null || true
-
-# S3 credentials for storage tests
-STATUS_TABLE=$(supabase status 2>/dev/null)
-S3_ACCESS_KEY_ID=$(echo "$STATUS_TABLE" | grep "Access Key" | awk -F '│' '{print $3}' | tr -d ' ')
-S3_SECRET_ACCESS_KEY=$(echo "$STATUS_TABLE" | grep "Secret Key" | awk -F '│' '{print $3}' | tr -d ' ')
-# Fallback: use service key if S3 keys not found in status output
-export S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-$SUPABASE_SECRET_KEY}"
-export S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-$SUPABASE_SECRET_KEY}"
+# ── Load environment ────────────────────────────────────────────
+
+if [ ! -f ".env.local" ]; then
+  echo "ERROR: .env.local not found. Run ./scripts/local-dev.sh first:" >&2
+  echo "  ./scripts/local-dev.sh print_setup_env_vars > .env.local" >&2
+  exit 1
+fi
+set -a
+source .env.local
+set +a
 
 # ── Start Ollama ────────────────────────────────────────────────
 
