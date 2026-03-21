diff --git a/web/__tests__/integration/smgr-e2e.test.ts b/web/__tests__/integration/smgr-e2e.test.ts
index c9e7980..4a42701 100644
--- a/web/__tests__/integration/smgr-e2e.test.ts
+++ b/web/__tests__/integration/smgr-e2e.test.ts
@@ -123,6 +123,14 @@ describe("smgr e2e pipeline", () => {
     // 3. Get admin client
     admin = getAdminClient();
 
+    // 3b. Ensure 'media' bucket exists (create if absent; ignore if already exists)
+    const { error: bucketErr } = await admin.storage.createBucket("media", {
+      public: false,
+    });
+    if (bucketErr && !bucketErr.message.includes("already exists")) {
+      throw new Error(`Failed to create media bucket: ${bucketErr.message}`);
+    }
+
     // 4. Insert model_configs row pointing at local Ollama
     const { error: configErr } = await admin.from("model_configs").insert({
       user_id: userId,
