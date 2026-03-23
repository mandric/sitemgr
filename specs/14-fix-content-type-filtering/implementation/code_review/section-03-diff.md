diff --git a/web/__tests__/integration/media-lifecycle.test.ts b/web/__tests__/integration/media-lifecycle.test.ts
index 8bc9778..b3bcff4 100644
--- a/web/__tests__/integration/media-lifecycle.test.ts
+++ b/web/__tests__/integration/media-lifecycle.test.ts
@@ -25,6 +25,7 @@ import {
   createS3Client,
   uploadS3Object,
 } from "../../lib/media/s3";
+import { CONTENT_TYPE_PHOTO, CONTENT_TYPE_VIDEO } from "../../lib/media/constants";
 
 let admin: SupabaseClient;
 let userId: string;
@@ -121,7 +122,7 @@ describe("when uploading and searching for media", () => {
       id: eventId,
       device_id: "test-device",
       type: "create",
-      content_type: "image/jpeg",
+      content_type: CONTENT_TYPE_PHOTO,
       content_hash: `hash-search-${Date.now()}`,
       local_path: null,
       remote_path: null,
@@ -172,7 +173,7 @@ describe("when requesting statistics", () => {
       id: evtPhoto2,
       device_id: "test-device",
       type: "create",
-      content_type: "image/jpeg",
+      content_type: CONTENT_TYPE_PHOTO,
       content_hash: `hash-stats-photo2-${Date.now()}`,
       local_path: null,
       remote_path: null,
@@ -186,7 +187,7 @@ describe("when requesting statistics", () => {
       id: evtVideo,
       device_id: "test-device",
       type: "create",
-      content_type: "video/mp4",
+      content_type: CONTENT_TYPE_VIDEO,
       content_hash: `hash-stats-video-${Date.now()}`,
       local_path: null,
       remote_path: null,
@@ -215,7 +216,7 @@ describe("when requesting statistics", () => {
     expect(error).toBeNull();
     expect(data).toBeDefined();
     expect(data!.by_content_type).toBeDefined();
-    expect(Number(data!.by_content_type["image/jpeg"])).toBeGreaterThanOrEqual(2);
+    expect(Number(data!.by_content_type[CONTENT_TYPE_PHOTO])).toBeGreaterThanOrEqual(2);
   });
 
   it("should return correct counts by event type", async () => {
@@ -233,9 +234,9 @@ describe("when checking enrichment progress", () => {
     expect(error).toBeNull();
     expect(data).toBeDefined();
 
-    // We have 3 "create" events, 2 enriched (search + photo2)
+    // We have 2 photo "create" events, both enriched
     expect(data!.enriched).toBeGreaterThanOrEqual(2);
-    expect(data!.pending).toBeGreaterThanOrEqual(1);
+    expect(data!.pending).toBe(0);
     expect(data!.total_media).toBe(data!.enriched + data!.pending);
   });
 });
diff --git a/web/__tests__/integration/setup.ts b/web/__tests__/integration/setup.ts
index 59efa72..6945519 100644
--- a/web/__tests__/integration/setup.ts
+++ b/web/__tests__/integration/setup.ts
@@ -4,6 +4,7 @@
  * Requires `supabase start` to be running locally.
  */
 import { createClient, type SupabaseClient } from "@supabase/supabase-js";
+import { CONTENT_TYPE_PHOTO } from "../../lib/media/constants";
 
 // Local Supabase defaults from `supabase start`
 const SUPABASE_URL = process.env.SMGR_API_URL ?? "http://127.0.0.1:54321";
@@ -173,7 +174,7 @@ export async function seedUserData(
         timestamp: new Date().toISOString(),
         device_id: `device-${prefix}`,
         type: "create",
-        content_type: "image/jpeg",
+        content_type: CONTENT_TYPE_PHOTO,
         content_hash: `hash-${prefix}-${i}`,
         user_id: userId,
       }),
