diff --git a/scripts/deploy.sh b/scripts/deploy.sh
index ea6f454..b8d1cc0 100755
--- a/scripts/deploy.sh
+++ b/scripts/deploy.sh
@@ -33,7 +33,7 @@ REQUIRED_VARS=(
     "TWILIO_ACCOUNT_SID"
     "TWILIO_AUTH_TOKEN"
     "TWILIO_WHATSAPP_FROM"
-    "ENCRYPTION_KEY"
+    "ENCRYPTION_KEY_CURRENT"
 )
 
 MISSING_VARS=()
@@ -136,7 +136,7 @@ supabase secrets set \
     TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
     TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
     TWILIO_WHATSAPP_FROM="$TWILIO_WHATSAPP_FROM" \
-    ENCRYPTION_KEY="$ENCRYPTION_KEY"
+    ENCRYPTION_KEY_CURRENT="$ENCRYPTION_KEY_CURRENT"
 
 echo "✅ Secrets configured"
 
