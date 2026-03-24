diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 5c8e271..4671f34 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -82,16 +82,34 @@ jobs:
 
       - name: Extract Supabase connection details
         run: |
-          echo "SUPABASE_URL=$(supabase status -o json | jq -r .API_URL)" >> $GITHUB_ENV
-          echo "SUPABASE_SECRET_KEY=$(supabase status -o json | jq -r .SERVICE_ROLE_KEY)" >> $GITHUB_ENV
-          echo "SUPABASE_PUBLISHABLE_KEY=$(supabase status -o json | jq -r .ANON_KEY)" >> $GITHUB_ENV
-          echo "S3_ENDPOINT_URL=$(supabase status -o json | jq -r .S3_ENDPOINT_URL)" >> $GITHUB_ENV
+          STATUS_JSON=$(supabase status -o json)
+          echo "SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)" >> $GITHUB_ENV
+          echo "NEXT_PUBLIC_SUPABASE_URL=$(echo "$STATUS_JSON" | jq -r .API_URL)" >> $GITHUB_ENV
+          echo "SUPABASE_SECRET_KEY=$(echo "$STATUS_JSON" | jq -r .SERVICE_ROLE_KEY)" >> $GITHUB_ENV
+          echo "SUPABASE_PUBLISHABLE_KEY=$(echo "$STATUS_JSON" | jq -r .ANON_KEY)" >> $GITHUB_ENV
+          echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$(echo "$STATUS_JSON" | jq -r .ANON_KEY)" >> $GITHUB_ENV
+          echo "S3_ENDPOINT_URL=$(echo "$STATUS_JSON" | jq -r .S3_ENDPOINT_URL)" >> $GITHUB_ENV
 
           AWS_ACCESS_KEY=$(supabase status | grep "Access Key" | awk -F '│' '{print $3}' | tr -d ' ')
           AWS_SECRET_KEY=$(supabase status | grep "Secret Key" | awk -F '│' '{print $3}' | tr -d ' ')
           echo "S3_ACCESS_KEY_ID=$AWS_ACCESS_KEY" >> $GITHUB_ENV
           echo "S3_SECRET_ACCESS_KEY=$AWS_SECRET_KEY" >> $GITHUB_ENV
 
+      - name: Verify integration test env vars
+        run: |
+          missing=0
+          for var in SUPABASE_URL SUPABASE_SECRET_KEY SUPABASE_PUBLISHABLE_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; do
+            if [ -z "${!var}" ]; then
+              echo "ERROR: $var is not set"
+              missing=1
+            fi
+          done
+          if [ "$missing" -eq 1 ]; then
+            echo "::error::Required Supabase env vars are missing. DB tests would silently skip; media tests would get cryptic auth failures."
+            exit 1
+          fi
+          echo "All required env vars verified"
+
       - name: Configure environment for smgr
         run: |
           echo "SMGR_S3_ENDPOINT=${{ env.S3_ENDPOINT_URL }}" >> $GITHUB_ENV
@@ -112,6 +130,12 @@ jobs:
       - name: Install web dependencies
         run: cd web && npm ci
 
+      - name: Run DB integration tests (RLS, RPC, migrations)
+        run: cd web && npm run test:integration
+
+      - name: Run media integration tests (S3, DB, pipeline)
+        run: cd web && npm run test:media-integration
+
       - name: FTS smoke test
         run: |
           PGURL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
