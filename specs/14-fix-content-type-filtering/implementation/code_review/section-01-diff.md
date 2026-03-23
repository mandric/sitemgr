diff --git a/web/lib/media/constants.ts b/web/lib/media/constants.ts
index 224c01b..9cd265f 100644
--- a/web/lib/media/constants.ts
+++ b/web/lib/media/constants.ts
@@ -12,10 +12,15 @@ export const MEDIA_EXTENSIONS = new Set([
   ".mp3", ".wav", ".ogg", ".flac", ".m4a",
 ]);
 
+export const CONTENT_TYPE_PHOTO = "photo";
+export const CONTENT_TYPE_VIDEO = "video";
+export const CONTENT_TYPE_AUDIO = "audio";
+export const CONTENT_TYPE_FILE = "file";
+
 export const CONTENT_TYPE_MAP: Record<string, string> = {
-  image: "photo",
-  video: "video",
-  audio: "audio",
+  image: CONTENT_TYPE_PHOTO,
+  video: CONTENT_TYPE_VIDEO,
+  audio: CONTENT_TYPE_AUDIO,
 };
 
 export const ENRICHMENT_PROMPT = `Analyze this image and return a JSON object with exactly these fields:
diff --git a/web/lib/media/db.ts b/web/lib/media/db.ts
index a06bbae..3ab2b45 100644
--- a/web/lib/media/db.ts
+++ b/web/lib/media/db.ts
@@ -12,6 +12,7 @@
 import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
 import { createLogger, LogComponent } from "@/lib/logger";
 import { withRetry } from "@/lib/retry";
+import { CONTENT_TYPE_PHOTO } from "@/lib/media/constants";
 
 const logger = createLogger(LogComponent.DB);
 
@@ -242,7 +243,7 @@ export async function getStats(client: SupabaseClient, opts?: { userId?: string;
   const watched = watchedRes.count ?? 0;
 
   // Count "photo" content type as media for pending enrichment calculation
-  const photoCount = contentTypeCounts["photo"] ?? 0;
+  const photoCount = contentTypeCounts[CONTENT_TYPE_PHOTO] ?? 0;
 
   return {
     data: {
@@ -402,7 +403,7 @@ export async function getPendingEnrichments(client: SupabaseClient, userId?: str
     .from("events")
     .select("id, content_hash, content_type, local_path, remote_path, metadata")
     .eq("type", "create")
-    .eq("content_type", "photo")
+    .eq("content_type", CONTENT_TYPE_PHOTO)
     .order("timestamp", { ascending: false });
   if (userId) photosQuery = photosQuery.eq("user_id", userId);
   const { data: photos, error: photosErr } = await photosQuery;
