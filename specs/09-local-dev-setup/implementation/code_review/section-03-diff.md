diff --git a/scripts/setup.sh b/scripts/setup.sh
index 90014b2..c9d7d09 100755
--- a/scripts/setup.sh
+++ b/scripts/setup.sh
@@ -1,37 +1,56 @@
 #!/bin/bash
 # First-time setup script for sitemgr development environment
-# Requires: Node.js 20+, npm
+# Requires: supabase CLI, docker, node 20+, npm, jq
 
-set -e
+set -euo pipefail
+IFS=$'\n\t'
 
 echo "================================================"
 echo "  sitemgr Development Environment Setup"
 echo "================================================"
 echo ""
 
-# Check for Node.js
-if ! command -v node &> /dev/null; then
-    echo "Error: Node.js not found"
-    echo ""
-    echo "Install Node.js 20+:"
-    echo "  https://nodejs.org/"
-    exit 1
-fi
+check_prerequisites() {
+  local missing=()
 
-NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
-if [ "$NODE_VERSION" -lt 20 ]; then
-    echo "Error: Node.js 20+ required (found $(node -v))"
-    exit 1
-fi
+  if ! command -v supabase &>/dev/null; then
+    missing+=("  supabase — install: brew install supabase/tap/supabase")
+  fi
 
-echo "Found Node.js $(node -v)"
+  if ! command -v docker &>/dev/null; then
+    missing+=("  docker   — install: https://docs.docker.com/get-docker/")
+  fi
+
+  if ! command -v node &>/dev/null; then
+    missing+=("  node     — install: https://nodejs.org/ (Node.js 20+ required)")
+  else
+    local node_major
+    node_major=$(node -v | sed 's/v//' | cut -d. -f1)
+    if [ "$node_major" -lt 20 ]; then
+      missing+=("  node     — version 20+ required (found $(node -v))")
+    fi
+  fi
+
+  if ! command -v npm &>/dev/null; then
+    missing+=("  npm      — install Node.js from https://nodejs.org/ (npm is included)")
+  fi
 
-# Check for npm
-if ! command -v npm &> /dev/null; then
-    echo "Error: npm not found"
-    exit 1
-fi
+  if ! command -v jq &>/dev/null; then
+    missing+=("  jq       — install: brew install jq")
+  fi
 
+  if [ ${#missing[@]} -gt 0 ]; then
+    echo "Error: The following required tools are missing:" >&2
+    for item in "${missing[@]}"; do
+      echo "$item" >&2
+    done
+    return 1
+  fi
+}
+
+check_prerequisites
+
+echo "Found Node.js $(node -v)"
 echo "Found npm $(npm -v)"
 
 # Install web dependencies
@@ -48,11 +67,12 @@ echo "================================================"
 echo ""
 echo "Next steps:"
 echo ""
-echo "1. Start Supabase and configure environment:"
+echo "1. Start Supabase and generate environment variables:"
 echo "   ./scripts/local-dev.sh"
+echo "   ./scripts/local-dev.sh print_setup_env_vars > .env.local"
 echo ""
-echo "2. Run the CLI:"
-echo "   cd web && npm run smgr stats"
+echo "2. Verify the environment:"
+echo "   ./scripts/setup/verify.sh"
 echo ""
 echo "3. Run tests:"
 echo "   cd web && npm test"
