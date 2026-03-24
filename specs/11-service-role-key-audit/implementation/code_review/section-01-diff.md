diff --git a/scripts/local-dev.sh b/scripts/local-dev.sh
index 281fc45..2d3d172 100755
--- a/scripts/local-dev.sh
+++ b/scripts/local-dev.sh
@@ -59,47 +59,31 @@ print_setup_env_vars() {
   encryption_key=$(openssl rand -base64 32)
 
   # ---------------------------------------------------------------------------
-  # Generate an ES256 service-role JWT if GoTrue is using GOTRUE_JWT_KEYS
-  # (Supabase CLI ≥ 2.78 sets up an EC key pair; HS256 service_role JWTs are
-  # rejected with "signing method HS256 is invalid" when only an EC key is
-  # configured). Fall back to the HS256 service_role_key for older CLI versions.
+  # Capability probe: verify the service role key is accepted by GoTrue.
+  # Older Supabase CLI versions may produce keys that GoTrue rejects.
   # ---------------------------------------------------------------------------
-  local supabase_secret_key="$service_role_key"
-  local auth_container
-  auth_container=$(docker ps --format '{{.Names}}' 2>/dev/null | grep '^supabase_auth_' | head -1)
-  if [ -n "$auth_container" ]; then
-    local gotrue_jwt_keys
-    gotrue_jwt_keys=$(docker exec "$auth_container" sh -c 'printf "%s" "$GOTRUE_JWT_KEYS"' 2>/dev/null || true)
-    if [ -n "$gotrue_jwt_keys" ] && [ "$gotrue_jwt_keys" != "null" ]; then
-      local es256_jwt
-      es256_jwt=$(node -e "
-const crypto = require('crypto');
-const jwks = JSON.parse(process.argv[1]);
-const jwk = jwks.find(k => k.alg === 'ES256' && k.d) || jwks.find(k => k.d);
-if (!jwk) { process.exit(1); }
-const header = Buffer.from(JSON.stringify({alg:'ES256',typ:'JWT',kid:jwk.kid})).toString('base64url');
-const payload = Buffer.from(JSON.stringify({iss:'supabase-local',role:'service_role',exp:9999999999})).toString('base64url');
-const msg = Buffer.from(header + '.' + payload);
-const privateKey = crypto.createPrivateKey({key:jwk, format:'jwk'});
-const sig = crypto.sign('SHA256', msg, {key:privateKey, dsaEncoding:'ieee-p1363'}).toString('base64url');
-console.log(header + '.' + payload + '.' + sig);
-" "$gotrue_jwt_keys" 2>/dev/null || true)
-      if [ -n "$es256_jwt" ]; then
-        supabase_secret_key="$es256_jwt"
-      fi
-    fi
+  local probe_status
+  probe_status=$(curl -s -o /dev/null -w '%{http_code}' \
+    -H "Authorization: Bearer ${service_role_key}" \
+    -H "apikey: ${service_role_key}" \
+    "${api_url}/auth/v1/admin/users?per_page=1")
+  if [ "$probe_status" -lt 200 ] || [ "$probe_status" -ge 300 ]; then
+    echo "Error: Service role key rejected by GoTrue (HTTP ${probe_status})." >&2
+    echo "Upgrade Supabase CLI to >= 2.76.4." >&2
+    exit 1
   fi
 
   cat <<EOF
-# Supabase / API
+# --- Web app (Supabase) ---
 NEXT_PUBLIC_SUPABASE_URL=${api_url}
-SMGR_API_URL=${api_url}
 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${anon_key}
-SMGR_API_KEY=${anon_key}
-SUPABASE_SECRET_KEY=${supabase_secret_key}
 DATABASE_URL=${db_url}
 
-# S3 / Storage
+# --- CLI (auth provider -- same Supabase instance in local dev) ---
+SMGR_API_URL=${api_url}
+SMGR_API_KEY=${anon_key}
+
+# --- S3 / Storage ---
 SMGR_S3_ENDPOINT=${s3_endpoint}
 S3_ENDPOINT_URL=${s3_endpoint}
 SMGR_S3_BUCKET=media
@@ -107,14 +91,17 @@ SMGR_S3_REGION=local
 S3_ACCESS_KEY_ID=${s3_key_id}
 S3_SECRET_ACCESS_KEY=${s3_key_secret}
 
-# smgr CLI
+# --- smgr CLI ---
 SMGR_DEVICE_ID=local-dev
 SMGR_AUTO_ENRICH=false
 
-# Encryption (generated fresh — local dev data is ephemeral)
+# --- Encryption (generated fresh -- local dev data is ephemeral) ---
 ENCRYPTION_KEY_CURRENT=${encryption_key}
 
-# Optional — uncomment and fill in as needed
+# --- Service role key (tests and admin scripts only -- NOT for app code) ---
+# SUPABASE_SERVICE_ROLE_KEY=${service_role_key}
+
+# --- Optional -- uncomment and fill in as needed ---
 # ANTHROPIC_API_KEY=
 # TWILIO_ACCOUNT_SID=
 # TWILIO_AUTH_TOKEN=
diff --git a/web/__tests__/integration/local-dev-output.test.ts b/web/__tests__/integration/local-dev-output.test.ts
new file mode 100644
index 0000000..511d4b4
--- /dev/null
+++ b/web/__tests__/integration/local-dev-output.test.ts
@@ -0,0 +1,64 @@
+/**
+ * Integration tests for scripts/local-dev.sh print_setup_env_vars output.
+ *
+ * Requires `supabase start` to be running locally.
+ */
+import { execFileSync } from "child_process";
+import { resolve } from "path";
+import { describe, it, expect, beforeAll } from "vitest";
+
+const SCRIPT = resolve(__dirname, "../../../scripts/local-dev.sh");
+
+let output: string;
+
+beforeAll(() => {
+  output = execFileSync("bash", [SCRIPT, "print_setup_env_vars"], {
+    encoding: "utf-8",
+    timeout: 30_000,
+  });
+});
+
+describe("print_setup_env_vars", () => {
+  it("outputs NEXT_PUBLIC_SUPABASE_URL", () => {
+    expect(output).toMatch(/^NEXT_PUBLIC_SUPABASE_URL=.+/m);
+  });
+
+  it("outputs NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", () => {
+    expect(output).toMatch(/^NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=.+/m);
+  });
+
+  it("outputs SMGR_API_URL and SMGR_API_KEY", () => {
+    expect(output).toMatch(/^SMGR_API_URL=.+/m);
+    expect(output).toMatch(/^SMGR_API_KEY=.+/m);
+  });
+
+  it("does NOT output SUPABASE_SECRET_KEY (old name)", () => {
+    // Should not appear as an active env var
+    expect(output).not.toMatch(/^SUPABASE_SECRET_KEY=/m);
+  });
+
+  it("outputs SUPABASE_SERVICE_ROLE_KEY as a comment (not active env var)", () => {
+    // Should be commented out
+    expect(output).toMatch(/^# SUPABASE_SERVICE_ROLE_KEY=.+/m);
+    // Should NOT be an active (uncommented) env var
+    expect(output).not.toMatch(/^SUPABASE_SERVICE_ROLE_KEY=/m);
+  });
+
+  it("outputs valid dotenv format (no syntax errors)", () => {
+    const lines = output.split("\n");
+    for (const line of lines) {
+      const trimmed = line.trim();
+      if (!trimmed || trimmed.startsWith("#")) continue;
+      expect(trimmed).toMatch(
+        /^[A-Z_][A-Z0-9_]*=.*/,
+        `Invalid dotenv line: "${trimmed}"`,
+      );
+    }
+  });
+
+  it("capability probe succeeds (script exits 0 with valid output)", () => {
+    // The script already ran successfully in beforeAll (exit code 0).
+    // If the probe failed, execFileSync would have thrown.
+    expect(output.length).toBeGreaterThan(0);
+  });
+});
