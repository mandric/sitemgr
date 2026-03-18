diff --git a/web/__tests__/encryption-lifecycle.test.ts b/web/__tests__/encryption-lifecycle.test.ts
index bf32f59..ecbe87a 100644
--- a/web/__tests__/encryption-lifecycle.test.ts
+++ b/web/__tests__/encryption-lifecycle.test.ts
@@ -25,7 +25,8 @@ vi.mock("@/lib/media/db", async (importOriginal) => {
   const actual = await importOriginal<typeof import("@/lib/media/db")>();
   return {
     ...actual,
-    getSupabaseClient: () => ({ from: mockFrom }),
+    getAdminClient: () => ({ from: mockFrom }),
+    getUserClient: () => ({ from: mockFrom }),
     getWatchedKeys: vi.fn().mockResolvedValue(new Set()),
     insertEvent: vi.fn().mockResolvedValue(undefined),
     insertEnrichment: vi.fn().mockResolvedValue(undefined),
diff --git a/web/__tests__/s3-actions.test.ts b/web/__tests__/s3-actions.test.ts
index 825fe78..4253d45 100644
--- a/web/__tests__/s3-actions.test.ts
+++ b/web/__tests__/s3-actions.test.ts
@@ -21,7 +21,8 @@ vi.mock("@/lib/media/db", async (importOriginal) => {
   const actual = await importOriginal<typeof import("@/lib/media/db")>();
   return {
     ...actual,
-    getSupabaseClient: () => ({ from: mockFrom }),
+    getAdminClient: () => ({ from: mockFrom }),
+    getUserClient: () => ({ from: mockFrom }),
     getWatchedKeys: vi.fn().mockResolvedValue(new Set()),
     insertEvent: vi.fn().mockResolvedValue(undefined),
     insertEnrichment: vi.fn().mockResolvedValue(undefined),
diff --git a/web/__tests__/supabase-client.test.ts b/web/__tests__/supabase-client.test.ts
index fa1388c..b88328b 100644
--- a/web/__tests__/supabase-client.test.ts
+++ b/web/__tests__/supabase-client.test.ts
@@ -1,6 +1,8 @@
 import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
 
-const mockCreateClient = vi.fn().mockReturnValue({ from: vi.fn() });
+const { mockCreateClient } = vi.hoisted(() => ({
+  mockCreateClient: vi.fn().mockReturnValue({ from: vi.fn() }),
+}));
 
 vi.mock("@supabase/supabase-js", () => ({
   createClient: mockCreateClient,
diff --git a/web/app/api/health/route.ts b/web/app/api/health/route.ts
index 9134df3..e9492ba 100644
--- a/web/app/api/health/route.ts
+++ b/web/app/api/health/route.ts
@@ -1,5 +1,5 @@
 import { NextResponse } from "next/server";
-import { getSupabaseClient } from "@/lib/media/db";
+import { getAdminClient } from "@/lib/media/db";
 
 // TODO: Add Anthropic API connectivity check (e.g. list models)
 // TODO: Add Twilio API connectivity check (e.g. fetch account info)
@@ -9,7 +9,7 @@ export async function GET() {
 
   // Check Supabase DB connectivity
   try {
-    const supabase = getSupabaseClient();
+    const supabase = getAdminClient();
     const { error } = await supabase
       .from("events")
       .select("id", { count: "exact", head: true })
diff --git a/web/lib/agent/core.ts b/web/lib/agent/core.ts
index 682de45..ce4be9d 100644
--- a/web/lib/agent/core.ts
+++ b/web/lib/agent/core.ts
@@ -7,7 +7,7 @@
 
 import Anthropic from "@anthropic-ai/sdk";
 import { AGENT_SYSTEM_PROMPT, WHATSAPP_PLANNER_PROMPT } from "./system-prompt";
-import { getSupabaseClient } from "@/lib/media/db";
+import { getAdminClient } from "@/lib/media/db";
 import {
   queryEvents,
   showEvent,
@@ -275,7 +275,7 @@ async function addBucket(
   // Use versioned encryption for new buckets
   const encryptedSecret = await encryptSecretVersioned(secretAccessKey);
   const keyVersion = getEncryptionVersion(encryptedSecret);
-  const supabase = getSupabaseClient();
+  const supabase = getAdminClient();
 
   const { data, error } = await supabase
     .from("bucket_configs")
@@ -313,7 +313,7 @@ async function addBucket(
 }
 
 async function listBuckets(phoneNumber: string): Promise<string> {
-  const supabase = getSupabaseClient();
+  const supabase = getAdminClient();
 
   const { data, error } = await supabase
     .from("bucket_configs")
@@ -339,7 +339,7 @@ async function removeBucket(
     return JSON.stringify({ error: "bucket_name is required" });
   }
 
-  const supabase = getSupabaseClient();
+  const supabase = getAdminClient();
 
   const { error } = await supabase
     .from("bucket_configs")
@@ -425,7 +425,7 @@ async function getBucketConfig(
   bucketName: string,
 ): Promise<BucketConfigResult> {
   if (!bucketName) return { exists: false };
-  const supabase = getSupabaseClient();
+  const supabase = getAdminClient();
   const { data, error } = await supabase
     .from("bucket_configs")
     .select("*")
@@ -705,7 +705,7 @@ async function indexBucket(
 export async function getConversationHistory(
   phone: string,
 ): Promise<Message[]> {
-  const supabase = getSupabaseClient();
+  const supabase = getAdminClient();
 
   const { data } = await supabase
     .from("conversations")
@@ -720,7 +720,7 @@ export async function saveConversationHistory(
   phone: string,
   history: Message[],
 ): Promise<void> {
-  const supabase = getSupabaseClient();
+  const supabase = getAdminClient();
   const trimmed = history.slice(-20);
 
   await supabase.from("conversations").upsert({
diff --git a/web/lib/media/db.ts b/web/lib/media/db.ts
index f2bd59c..29fdace 100644
--- a/web/lib/media/db.ts
+++ b/web/lib/media/db.ts
@@ -4,16 +4,28 @@
 
 import { createClient as createSupabaseClient } from "@supabase/supabase-js";
 
-export function getSupabaseClient() {
+/** Creates a Supabase client with the service role key (bypasses RLS). */
+export function getAdminClient() {
   const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
-  const key = (
-    process.env.SUPABASE_SECRET_KEY ??
-    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
-  )?.replace(/\s+/g, "");
-  if (!url || !key) {
-    throw new Error(
-      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)"
-    );
+  const key = process.env.SUPABASE_SECRET_KEY?.replace(/\s+/g, "");
+  if (!url) {
+    throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");
+  }
+  if (!key) {
+    throw new Error("SUPABASE_SECRET_KEY is required for admin client");
+  }
+  return createSupabaseClient(url, key);
+}
+
+/** Creates a Supabase client with the publishable key (respects RLS). */
+export function getUserClient() {
+  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
+  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.replace(/\s+/g, "");
+  if (!url) {
+    throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");
+  }
+  if (!key) {
+    throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required for user client");
   }
   return createSupabaseClient(url, key);
 }
@@ -46,7 +58,7 @@ export interface QueryOptions {
 }
 
 export async function queryEvents(opts: QueryOptions) {
-  const supabase = getSupabaseClient();
+  const supabase = getUserClient();
 
   // Full-text search via RPC
   if (opts.search) {
@@ -96,7 +108,7 @@ export async function queryEvents(opts: QueryOptions) {
 // ── Show ───────────────────────────────────────────────────────
 
 export async function showEvent(eventId: string) {
-  const supabase = getSupabaseClient();
+  const supabase = getUserClient();
 
   const { data: event, error } = await supabase
     .from("events")
@@ -124,7 +136,7 @@ export async function showEvent(eventId: string) {
 // ── Stats ──────────────────────────────────────────────────────
 
 export async function getStats() {
-  const supabase = getSupabaseClient();
+  const supabase = getUserClient();
 
   const [byContentType, byEventType, totalRes, enrichedRes, watchedRes] =
     await Promise.all([
@@ -170,7 +182,7 @@ export async function getStats() {
 // ── Enrich Status ──────────────────────────────────────────────
 
 export async function getEnrichStatus() {
-  const supabase = getSupabaseClient();
+  const supabase = getUserClient();
 
   const [totalRes, enrichedRes] = await Promise.all([
     supabase
@@ -196,7 +208,7 @@ export async function getEnrichStatus() {
 // ── Insert Event ───────────────────────────────────────────────
 
 export async function insertEvent(event: Omit<EventRow, "timestamp"> & { timestamp?: string }) {
-  const supabase = getSupabaseClient();
+  const supabase = getAdminClient();
   const { error } = await supabase.from("events").insert({
     ...event,
     timestamp: event.timestamp ?? new Date().toISOString(),
@@ -210,7 +222,7 @@ export async function insertEnrichment(
   eventId: string,
   result: { description: string; objects: string[]; context: string; suggested_tags: string[] }
 ) {
-  const supabase = getSupabaseClient();
+  const supabase = getAdminClient();
   const { error } = await supabase.from("enrichments").insert({
     event_id: eventId,
     description: result.description,
@@ -229,7 +241,7 @@ export async function upsertWatchedKey(
   etag: string,
   sizeBytes: number
 ) {
-  const supabase = getSupabaseClient();
+  const supabase = getAdminClient();
   const { error } = await supabase.from("watched_keys").upsert(
     {
       s3_key: s3Key,
@@ -246,7 +258,7 @@ export async function upsertWatchedKey(
 // ── Get Watched Keys ──────────────────────────────────────────
 
 export async function getWatchedKeys(): Promise<Set<string>> {
-  const supabase = getSupabaseClient();
+  const supabase = getAdminClient();
   const { data, error } = await supabase
     .from("watched_keys")
     .select("s3_key");
@@ -257,7 +269,7 @@ export async function getWatchedKeys(): Promise<Set<string>> {
 // ── Check Duplicate by Hash ───────────────────────────────────
 
 export async function findEventByHash(hash: string): Promise<string | null> {
-  const supabase = getSupabaseClient();
+  const supabase = getUserClient();
   const { data } = await supabase
     .from("events")
     .select("id")
@@ -271,7 +283,7 @@ export async function findEventByHash(hash: string): Promise<string | null> {
 // ── Get Pending Enrichments ───────────────────────────────────
 
 export async function getPendingEnrichments() {
-  const supabase = getSupabaseClient();
+  const supabase = getAdminClient();
 
   // Get photo events that don't have enrichments
   const { data: photos, error: photosErr } = await supabase
