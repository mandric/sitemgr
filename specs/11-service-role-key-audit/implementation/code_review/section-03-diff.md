diff --git a/web/__tests__/agent-actions.test.ts b/web/__tests__/agent-actions.test.ts
new file mode 100644
index 0000000..b7b54d5
--- /dev/null
+++ b/web/__tests__/agent-actions.test.ts
@@ -0,0 +1,71 @@
+import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
+
+const mockGetUser = vi.fn();
+const mockFrom = vi.fn();
+
+vi.mock("@/lib/supabase/server", () => ({
+  createClient: vi.fn().mockResolvedValue({
+    auth: { getUser: () => mockGetUser() },
+    from: (...args: unknown[]) => mockFrom(...args),
+  }),
+}));
+
+const mockGetConversationHistory = vi.fn().mockResolvedValue([]);
+const mockSendMessageToAgent = vi.fn().mockResolvedValue({ content: "reply" });
+const mockSaveConversationHistory = vi.fn().mockResolvedValue(undefined);
+
+vi.mock("@/lib/agent/core", () => ({
+  getConversationHistory: (...args: unknown[]) => mockGetConversationHistory(...args),
+  sendMessageToAgent: (...args: unknown[]) => mockSendMessageToAgent(...args),
+  saveConversationHistory: (...args: unknown[]) => mockSaveConversationHistory(...args),
+}));
+
+vi.mock("@/lib/media/db", () => ({
+  getStats: vi.fn().mockResolvedValue({ data: { total_events: 0 }, error: null }),
+}));
+
+describe("sendMessage server action", () => {
+  beforeEach(() => {
+    vi.clearAllMocks();
+    mockGetUser.mockResolvedValue({
+      data: { user: { id: "user-123" } },
+    });
+    mockFrom.mockReturnValue({
+      select: vi.fn().mockReturnValue({
+        eq: vi.fn().mockResolvedValue({ data: [] }),
+      }),
+    });
+  });
+
+  afterEach(() => {
+    vi.unstubAllEnvs();
+  });
+
+  it("passes the user's server client to getConversationHistory", async () => {
+    const { sendMessage } = await import("@/components/agent/actions");
+    await sendMessage("hello");
+
+    expect(mockGetConversationHistory).toHaveBeenCalledOnce();
+    // First arg should be the supabase client (an object with .auth and .from)
+    const client = mockGetConversationHistory.mock.calls[0][0];
+    expect(client).toHaveProperty("auth");
+    expect(client).toHaveProperty("from");
+  });
+
+  it("passes the user's server client to saveConversationHistory", async () => {
+    const { sendMessage } = await import("@/components/agent/actions");
+    await sendMessage("hello");
+
+    expect(mockSaveConversationHistory).toHaveBeenCalledOnce();
+    const client = mockSaveConversationHistory.mock.calls[0][0];
+    expect(client).toHaveProperty("auth");
+    expect(client).toHaveProperty("from");
+  });
+
+  it("does not create an admin client or reference service role key", async () => {
+    const fs = await import("fs");
+    const source = fs.readFileSync("components/agent/actions.ts", "utf-8");
+    expect(source).not.toContain("getAdminClient");
+    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
+  });
+});
diff --git a/web/__tests__/agent-core.test.ts b/web/__tests__/agent-core.test.ts
index c13fb7e..415af1f 100644
--- a/web/__tests__/agent-core.test.ts
+++ b/web/__tests__/agent-core.test.ts
@@ -13,10 +13,6 @@ vi.mock("@anthropic-ai/sdk", () => {
 const mockAdminFrom = vi.fn();
 
 vi.mock("@/lib/media/db", () => ({
-  getAdminClient: vi.fn(() => ({
-    from: (...args: unknown[]) => mockAdminFrom(...args),
-  })),
-  getUserClient: vi.fn(),
   queryEvents: vi.fn().mockResolvedValue({ data: [], count: 0, error: null }),
   showEvent: vi.fn().mockResolvedValue({ data: null, error: null }),
   getStats: vi.fn().mockResolvedValue({ data: { total_events: 0 }, error: null }),
@@ -27,6 +23,11 @@ vi.mock("@/lib/media/db", () => ({
   getWatchedKeys: vi.fn().mockResolvedValue({ data: [], error: null }),
 }));
 
+/** Create a mock SupabaseClient that delegates .from() to mockAdminFrom */
+function createMockClient() {
+  return { from: (...args: unknown[]) => mockAdminFrom(...args) } as never;
+}
+
 vi.mock("@/lib/media/s3", () => ({
   createS3Client: vi.fn(() => ({ send: vi.fn() })),
   listS3Objects: vi.fn().mockResolvedValue([]),
@@ -206,8 +207,6 @@ describe("sendMessageToAgent", () => {
 describe("executeAction — request context", () => {
   beforeEach(() => {
     vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
-    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
-    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
     vi.clearAllMocks();
     mockRunWithRequestId.mockImplementation((id: string, fn: () => unknown) => fn());
     setupAdminMock();
@@ -219,14 +218,14 @@ describe("executeAction — request context", () => {
 
   it("wraps execution in runWithRequestId", async () => {
     const { executeAction } = await import("@/lib/agent/core");
-    await executeAction({ action: "stats" }, "+1234567890", "user-123");
+    await executeAction(createMockClient(), { action: "stats" }, "+1234567890", "user-123");
 
     expect(mockRunWithRequestId).toHaveBeenCalledOnce();
   });
 
   it("request ID is a non-empty string", async () => {
     const { executeAction } = await import("@/lib/agent/core");
-    await executeAction({ action: "stats" }, "+1234567890", "user-123");
+    await executeAction(createMockClient(), { action: "stats" }, "+1234567890", "user-123");
 
     const requestId = mockRunWithRequestId.mock.calls[0][0];
     expect(typeof requestId).toBe("string");
@@ -235,8 +234,9 @@ describe("executeAction — request context", () => {
 
   it("request ID is different for two consecutive calls", async () => {
     const { executeAction } = await import("@/lib/agent/core");
-    await executeAction({ action: "stats" }, "+1234567890", "user-123");
-    await executeAction({ action: "stats" }, "+1234567890", "user-123");
+    const client = createMockClient();
+    await executeAction(client, { action: "stats" }, "+1234567890", "user-123");
+    await executeAction(client, { action: "stats" }, "+1234567890", "user-123");
 
     const id1 = mockRunWithRequestId.mock.calls[0][0];
     const id2 = mockRunWithRequestId.mock.calls[1][0];
@@ -256,7 +256,7 @@ describe("executeAction — request context", () => {
     });
 
     const { executeAction } = await import("@/lib/agent/core");
-    await executeAction({ action: "stats" }, "+1234567890", "user-123");
+    await executeAction(createMockClient(), { action: "stats" }, "+1234567890", "user-123");
 
     expect(callOrder).toEqual(["runWithRequestId", "getStats"]);
   });
@@ -267,8 +267,6 @@ describe("executeAction — request context", () => {
 describe("executeAction — error response shape", () => {
   beforeEach(() => {
     vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
-    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
-    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
     vi.clearAllMocks();
     mockRunWithRequestId.mockImplementation((id: string, fn: () => unknown) => fn());
     setupAdminMock();
@@ -281,7 +279,7 @@ describe("executeAction — error response shape", () => {
   it("unknown action returns JSON with errorType field", async () => {
     const { executeAction } = await import("@/lib/agent/core");
     const result = await executeAction(
-      { action: "unknown_action" }, "+1234567890", "user-123",
+      createMockClient(), { action: "unknown_action" }, "+1234567890", "user-123",
     );
     const parsed = JSON.parse(result);
     expect(parsed.error).toBeDefined();
@@ -292,7 +290,7 @@ describe("executeAction — error response shape", () => {
   it("missing bucket_name in remove_bucket returns errorType validation_error", async () => {
     const { executeAction } = await import("@/lib/agent/core");
     const result = await executeAction(
-      { action: "remove_bucket", params: {} }, "+1234567890", "user-123",
+      createMockClient(), { action: "remove_bucket", params: {} }, "+1234567890", "user-123",
     );
     const parsed = JSON.parse(result);
     expect(parsed.errorType).toBe("validation_error");
@@ -301,7 +299,7 @@ describe("executeAction — error response shape", () => {
   it("unresolved phone number returns errorType not_found", async () => {
     const { executeAction } = await import("@/lib/agent/core");
     const result = await executeAction(
-      { action: "stats" }, "+9999999999", null,
+      createMockClient(), { action: "stats" }, "+9999999999", null,
     );
     const parsed = JSON.parse(result);
     expect(parsed.errorType).toBe("not_found");
@@ -312,7 +310,7 @@ describe("executeAction — error response shape", () => {
 
     const { executeAction } = await import("@/lib/agent/core");
     const result = await executeAction(
-      { action: "stats" }, "+1234567890", "user-123",
+      createMockClient(), { action: "stats" }, "+1234567890", "user-123",
     );
     const parsed = JSON.parse(result);
     expect(parsed.errorType).toBe("internal");
@@ -320,16 +318,17 @@ describe("executeAction — error response shape", () => {
 
   it("error responses never include errorType undefined", async () => {
     const { executeAction } = await import("@/lib/agent/core");
+    const client = createMockClient();
 
     // Test unknown action
     const r1 = JSON.parse(await executeAction(
-      { action: "bad" }, "+1234567890", "user-123",
+      client, { action: "bad" }, "+1234567890", "user-123",
     ));
     if (r1.error) expect(r1.errorType).toBeDefined();
 
     // Test no userId
     const r2 = JSON.parse(await executeAction(
-      { action: "stats" }, "+0000000000", null,
+      client, { action: "stats" }, "+0000000000", null,
     ));
     if (r2.error) expect(r2.errorType).toBeDefined();
   });
@@ -340,8 +339,6 @@ describe("executeAction — error response shape", () => {
 describe("indexBucket — concurrency and partial failure", () => {
   beforeEach(() => {
     vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
-    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
-    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
     vi.clearAllMocks();
     mockRunWithRequestId.mockImplementation((id: string, fn: () => unknown) => fn());
     setupAdminMock();
@@ -369,7 +366,7 @@ describe("indexBucket — concurrency and partial failure", () => {
 
     const { executeAction } = await import("@/lib/agent/core");
     await executeAction(
-      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
+      createMockClient(), { action: "index_bucket", params: { bucket_name: "test-bucket" } },
       "+1234567890", "user-123",
     );
 
@@ -384,7 +381,7 @@ describe("indexBucket — concurrency and partial failure", () => {
 
     const { executeAction } = await import("@/lib/agent/core");
     await executeAction(
-      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
+      createMockClient(), { action: "index_bucket", params: { bucket_name: "test-bucket" } },
       "+1234567890", "user-123",
     );
 
@@ -405,7 +402,7 @@ describe("indexBucket — concurrency and partial failure", () => {
 
     const { executeAction } = await import("@/lib/agent/core");
     const result = JSON.parse(await executeAction(
-      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
+      createMockClient(), { action: "index_bucket", params: { bucket_name: "test-bucket" } },
       "+1234567890", "user-123",
     ));
 
@@ -427,7 +424,7 @@ describe("indexBucket — concurrency and partial failure", () => {
 
     const { executeAction } = await import("@/lib/agent/core");
     const result = JSON.parse(await executeAction(
-      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
+      createMockClient(), { action: "index_bucket", params: { bucket_name: "test-bucket" } },
       "+1234567890", "user-123",
     ));
 
@@ -453,7 +450,7 @@ describe("indexBucket — concurrency and partial failure", () => {
 
     const { executeAction } = await import("@/lib/agent/core");
     const result = JSON.parse(await executeAction(
-      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
+      createMockClient(), { action: "index_bucket", params: { bucket_name: "test-bucket" } },
       "+1234567890", "user-123",
     ));
 
@@ -469,7 +466,7 @@ describe("indexBucket — concurrency and partial failure", () => {
 
     const { executeAction } = await import("@/lib/agent/core");
     const result = JSON.parse(await executeAction(
-      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
+      createMockClient(), { action: "index_bucket", params: { bucket_name: "test-bucket" } },
       "+1234567890", "user-123",
     ));
 
@@ -484,7 +481,7 @@ describe("indexBucket — concurrency and partial failure", () => {
 
     const { executeAction } = await import("@/lib/agent/core");
     const result = JSON.parse(await executeAction(
-      { action: "index_bucket", params: { bucket_name: "test-bucket" } },
+      createMockClient(), { action: "index_bucket", params: { bucket_name: "test-bucket" } },
       "+1234567890", "user-123",
     ));
 
@@ -494,3 +491,19 @@ describe("indexBucket — concurrency and partial failure", () => {
     expect(entry.status).toBe("indexed");
   });
 });
+
+// ── Static analysis tests ──────────────────────────────────────
+
+describe("agent core — dependency injection", () => {
+  it("does NOT import getAdminClient from db.ts", async () => {
+    const fs = await import("fs");
+    const source = fs.readFileSync("lib/agent/core.ts", "utf-8");
+    expect(source).not.toContain("getAdminClient");
+  });
+
+  it("does NOT reference SUPABASE_SERVICE_ROLE_KEY", async () => {
+    const fs = await import("fs");
+    const source = fs.readFileSync("lib/agent/core.ts", "utf-8");
+    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
+  });
+});
diff --git a/web/app/api/whatsapp/route.ts b/web/app/api/whatsapp/route.ts
index 56b36e3..c769b45 100644
--- a/web/app/api/whatsapp/route.ts
+++ b/web/app/api/whatsapp/route.ts
@@ -14,6 +14,15 @@ import {
   saveConversationHistory,
   resolveUserId,
 } from "@/lib/agent/core";
+import { getAdminClient } from "@/lib/media/db";
+
+// TEMPORARY: Section 04 replaces this with webhook service account
+function createWebhookClient() {
+  return getAdminClient({
+    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
+    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
+  });
+}
 
 // ── Twilio helpers ─────────────────────────────────────────────
 
@@ -99,12 +108,14 @@ export async function POST(req: NextRequest) {
       });
     }
 
+    const client = createWebhookClient();
+
     // Resolve phone number to user_id
-    const userId = await resolveUserId(fromNumber);
+    const userId = await resolveUserId(client, fromNumber);
 
     // Get conversation history
     console.log(`[${ts()}][${reqId}] fetching conversation history`);
-    const history = await getConversationHistory(fromNumber, userId);
+    const history = await getConversationHistory(client, fromNumber, userId);
 
     // Plan
     console.log(`[${ts()}][${reqId}] planning action`);
@@ -117,7 +128,7 @@ export async function POST(req: NextRequest) {
       responseText = plan.response ?? "";
     } else {
       console.log(`[${ts()}][${reqId}] executing action: ${plan.action}`);
-      const result = await executeAction(plan, fromNumber, userId);
+      const result = await executeAction(client, plan, fromNumber, userId);
       console.log(`[${ts()}][${reqId}] summarizing result (${result.length} chars)`);
       responseText = await summarizeResult(messageBody, result);
     }
@@ -125,7 +136,7 @@ export async function POST(req: NextRequest) {
     // Persist conversation
     history.push({ role: "user", content: messageBody });
     history.push({ role: "assistant", content: responseText });
-    await saveConversationHistory(fromNumber, history, userId);
+    await saveConversationHistory(client, fromNumber, history, userId);
 
     console.log(`[${ts()}][${reqId}] sending reply (${responseText.length} chars): ${responseText.slice(0, 100)}...`);
 
diff --git a/web/components/agent/actions.ts b/web/components/agent/actions.ts
index ac22795..16264e7 100644
--- a/web/components/agent/actions.ts
+++ b/web/components/agent/actions.ts
@@ -7,7 +7,7 @@ import {
   saveConversationHistory,
   type Message,
 } from "@/lib/agent/core";
-import { getStats, getUserClient } from "@/lib/media/db";
+import { getStats } from "@/lib/media/db";
 
 export async function sendMessage(
   message: string,
@@ -22,7 +22,7 @@ export async function sendMessage(
   }
 
   // Fetch conversation history
-  const history = await getConversationHistory("web", user.id);
+  const history = await getConversationHistory(supabase, "web", user.id);
 
   // Build user context
   const { data: buckets } = await supabase
@@ -30,11 +30,7 @@ export async function sendMessage(
     .select("id, bucket_name, endpoint_url, region, created_at")
     .eq("user_id", user.id);
 
-  const statsClient = getUserClient({
-    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
-    anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
-  });
-  const { data: stats } = await getStats(statsClient, { userId: user.id });
+  const { data: stats } = await getStats(supabase, { userId: user.id });
 
   const contextPrefix = [
     `[User context]`,
@@ -59,7 +55,7 @@ export async function sendMessage(
       { role: "user", content: message },
       { role: "assistant", content: response.content },
     ];
-    await saveConversationHistory("web", updatedHistory, user.id);
+    await saveConversationHistory(supabase, "web", updatedHistory, user.id);
   }
 
   return response;
diff --git a/web/lib/agent/core.ts b/web/lib/agent/core.ts
index e97b3e2..bc7dbf4 100644
--- a/web/lib/agent/core.ts
+++ b/web/lib/agent/core.ts
@@ -6,10 +6,10 @@
  */
 
 import Anthropic from "@anthropic-ai/sdk";
+import type { SupabaseClient } from "@supabase/supabase-js";
 import pLimit from "p-limit";
 import { AGENT_SYSTEM_PROMPT, WHATSAPP_PLANNER_PROMPT } from "./system-prompt";
 import {
-  getAdminClient,
   queryEvents,
   showEvent,
   getStats,
@@ -43,14 +43,6 @@ import { createLogger, LogComponent } from "@/lib/logger";
 
 const logger = createLogger(LogComponent.Agent);
 
-/** Create an admin Supabase client from server env vars. */
-function createAdminClient() {
-  return getAdminClient({
-    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
-    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
-  });
-}
-
 // ── Types ──────────────────────────────────────────────────────
 
 export type Message = {
@@ -176,9 +168,8 @@ export async function planAction(
 }
 
 /** Resolve a phone number to a user_id via user_profiles lookup. */
-export async function resolveUserId(phoneNumber: string): Promise<string | null> {
-  const supabase = createAdminClient();
-  const { data } = await supabase
+export async function resolveUserId(client: SupabaseClient, phoneNumber: string): Promise<string | null> {
+  const { data } = await client
     .from("user_profiles")
     .select("id")
     .eq("phone_number", phoneNumber)
@@ -187,6 +178,7 @@ export async function resolveUserId(phoneNumber: string): Promise<string | null>
 }
 
 export async function executeAction(
+  client: SupabaseClient,
   plan: AgentPlan,
   phoneNumber: string,
   preResolvedUserId?: string | null,
@@ -201,7 +193,7 @@ export async function executeAction(
     });
 
     // Use pre-resolved userId if available, otherwise resolve from phone
-    const userId = preResolvedUserId !== undefined ? preResolvedUserId : await resolveUserId(phoneNumber);
+    const userId = preResolvedUserId !== undefined ? preResolvedUserId : await resolveUserId(client, phoneNumber);
 
     // All DB actions require a resolved user — reject unknown phone numbers
     if (!userId && plan.action !== "direct") {
@@ -217,15 +209,16 @@ export async function executeAction(
           break;
 
         case "add_bucket":
-          result = await addBucket(phoneNumber, plan.params ?? {}, userId);
+          result = await addBucket(client, phoneNumber, plan.params ?? {}, userId);
           break;
 
         case "list_buckets":
-          result = await listBuckets(phoneNumber, userId);
+          result = await listBuckets(client, phoneNumber, userId);
           break;
 
         case "remove_bucket":
           result = await removeBucket(
+            client,
             phoneNumber,
             plan.params?.bucket_name as string,
             userId,
@@ -233,8 +226,7 @@ export async function executeAction(
           break;
 
         case "stats": {
-          const statsClient = createAdminClient();
-          const statsResult = await getStats(statsClient, { userId: userId ?? undefined });
+          const statsResult = await getStats(client, { userId: userId ?? undefined });
           if (statsResult.error) {
             result = errorResponse(`Stats query failed: ${(statsResult.error as Error).message ?? statsResult.error}`, "internal");
           } else {
@@ -244,8 +236,7 @@ export async function executeAction(
         }
 
         case "show": {
-          const showClient = createAdminClient();
-          const showResult = await showEvent(showClient, plan.params?.id as string, userId ?? undefined);
+          const showResult = await showEvent(client, plan.params?.id as string, userId ?? undefined);
           if (showResult.error) {
             result = errorResponse(`Show query failed: ${(showResult.error as Error).message ?? showResult.error}`, "internal");
           } else {
@@ -255,8 +246,7 @@ export async function executeAction(
         }
 
         case "enrich_status": {
-          const enrichClient = createAdminClient();
-          const enrichResult = await getEnrichStatus(enrichClient, userId ?? undefined);
+          const enrichResult = await getEnrichStatus(client, userId ?? undefined);
           if (enrichResult.error) {
             result = errorResponse(`Enrich status query failed: ${(enrichResult.error as Error).message ?? enrichResult.error}`, "internal");
           } else {
@@ -267,8 +257,7 @@ export async function executeAction(
 
         case "query": {
           const p = plan.params ?? {};
-          const queryClient = createAdminClient();
-          const queryResult = await queryEvents(queryClient, {
+          const queryResult = await queryEvents(client, {
             userId: userId ?? undefined,
             search: p.search as string | undefined,
             type: p.type as string | undefined,
@@ -286,6 +275,7 @@ export async function executeAction(
 
         case "test_bucket":
           result = await verifyBucketConfig(
+            client,
             phoneNumber,
             plan.params?.bucket_name as string,
             userId,
@@ -294,6 +284,7 @@ export async function executeAction(
 
         case "list_objects":
           result = await listObjects(
+            client,
             phoneNumber,
             plan.params?.bucket_name as string,
             plan.params?.prefix as string | undefined,
@@ -304,6 +295,7 @@ export async function executeAction(
 
         case "count_objects":
           result = await countObjects(
+            client,
             phoneNumber,
             plan.params?.bucket_name as string,
             plan.params?.prefix as string | undefined,
@@ -313,6 +305,7 @@ export async function executeAction(
 
         case "index_bucket":
           result = await indexBucket(
+            client,
             phoneNumber,
             plan.params?.bucket_name as string,
             plan.params?.prefix as string | undefined,
@@ -385,6 +378,7 @@ Summarize conversationally. Keep it short — this is a chat message.
 // ── Bucket management (phone-number scoped, for WhatsApp) ──────
 
 async function addBucket(
+  client: SupabaseClient,
   phoneNumber: string,
   params: Record<string, unknown>,
   userId: string | null,
@@ -409,9 +403,8 @@ async function addBucket(
   // Use versioned encryption for new buckets
   const encryptedSecret = await encryptSecretVersioned(secretAccessKey);
   const keyVersion = getEncryptionVersion(encryptedSecret);
-  const supabase = createAdminClient();
 
-  const { data, error } = await supabase
+  const { data, error } = await client
     .from("bucket_configs")
     .insert({
       user_id: userId,
@@ -447,14 +440,12 @@ async function addBucket(
   });
 }
 
-async function listBuckets(phoneNumber: string, userId: string | null): Promise<string> {
+async function listBuckets(client: SupabaseClient, phoneNumber: string, userId: string | null): Promise<string> {
   if (!userId) {
     return errorResponse("Could not resolve user for this phone number", "not_found");
   }
 
-  const supabase = createAdminClient();
-
-  const { data, error } = await supabase
+  const { data, error } = await client
     .from("bucket_configs")
     .select(
       "id, bucket_name, region, endpoint_url, created_at, last_synced_key",
@@ -471,6 +462,7 @@ async function listBuckets(phoneNumber: string, userId: string | null): Promise<
 }
 
 async function removeBucket(
+  client: SupabaseClient,
   phoneNumber: string,
   bucketName: string,
   userId: string | null,
@@ -483,9 +475,7 @@ async function removeBucket(
     return errorResponse("Could not resolve user for this phone number", "not_found");
   }
 
-  const supabase = createAdminClient();
-
-  const { error } = await supabase
+  const { error } = await client
     .from("bucket_configs")
     .delete()
     .eq("user_id", userId)
@@ -527,6 +517,7 @@ type S3ClientResult =
   | { ok: false; errorJson: string };
 
 async function requireS3Client(
+  client: SupabaseClient,
   phoneNumber: string,
   bucketName: string,
   userId?: string | null,
@@ -537,7 +528,7 @@ async function requireS3Client(
       errorJson: errorResponse("bucket_name is required", "validation_error"),
     };
 
-  const result = await getBucketConfig(phoneNumber, bucketName, userId);
+  const result = await getBucketConfig(client, phoneNumber, bucketName, userId);
   if (!result.exists)
     return {
       ok: false,
@@ -555,27 +546,27 @@ async function requireS3Client(
   }
 
   const config = result.config!;
-  const client = createS3Client({
+  const s3client = createS3Client({
     endpoint: config.endpoint_url,
     region: config.region ?? undefined,
     accessKeyId: config.access_key_id,
     secretAccessKey: config.secret_access_key,
   });
 
-  return { ok: true, client, config };
+  return { ok: true, client: s3client, config };
 }
 
 async function getBucketConfig(
+  client: SupabaseClient,
   phoneNumber: string,
   bucketName: string,
   userId?: string | null,
 ): Promise<BucketConfigResult> {
   if (!bucketName) return { exists: false };
-  const supabase = createAdminClient();
 
   if (!userId) return { exists: false };
 
-  const { data, error } = await supabase
+  const { data, error } = await client
     .from("bucket_configs")
     .select("*")
     .eq("bucket_name", bucketName)
@@ -598,7 +589,7 @@ async function getBucketConfig(
       // Update in background (non-blocking, fire-and-forget)
       void (async () => {
         try {
-          const { error } = await supabase
+          const { error } = await client
             .from("bucket_configs")
             .update({
               secret_access_key: newCiphertext,
@@ -645,11 +636,12 @@ async function getBucketConfig(
 }
 
 async function verifyBucketConfig(
+  client: SupabaseClient,
   phoneNumber: string,
   bucketName: string,
   userId?: string | null,
 ): Promise<string> {
-  const s3 = await requireS3Client(phoneNumber, bucketName, userId);
+  const s3 = await requireS3Client(client, phoneNumber, bucketName, userId);
   if (!s3.ok) return s3.errorJson;
 
   try {
@@ -689,13 +681,14 @@ async function verifyBucketConfig(
 }
 
 async function listObjects(
+  client: SupabaseClient,
   phoneNumber: string,
   bucketName: string,
   prefix?: string,
   limit = 100,
   userId?: string | null,
 ): Promise<string> {
-  const s3 = await requireS3Client(phoneNumber, bucketName, userId);
+  const s3 = await requireS3Client(client, phoneNumber, bucketName, userId);
   if (!s3.ok) return s3.errorJson;
 
   try {
@@ -722,12 +715,13 @@ async function listObjects(
 }
 
 async function countObjects(
+  client: SupabaseClient,
   phoneNumber: string,
   bucketName: string,
   prefix?: string,
   userId?: string | null,
 ): Promise<string> {
-  const s3 = await requireS3Client(phoneNumber, bucketName, userId);
+  const s3 = await requireS3Client(client, phoneNumber, bucketName, userId);
   if (!s3.ok) return s3.errorJson;
 
   try {
@@ -775,13 +769,14 @@ interface IndexBucketResult {
 }
 
 async function indexBucket(
+  client: SupabaseClient,
   phoneNumber: string,
   bucketName: string,
   prefix?: string,
   batchSize = 10,
   userId?: string | null,
 ): Promise<string> {
-  const s3 = await requireS3Client(phoneNumber, bucketName, userId);
+  const s3 = await requireS3Client(client, phoneNumber, bucketName, userId);
   if (!s3.ok) return s3.errorJson;
 
   try {
@@ -789,8 +784,7 @@ async function indexBucket(
     const allObjects = await listS3Objects(s3.client, bucketName, prefix ?? "");
 
     // Get already-watched keys to find new ones
-    const indexClient = createAdminClient();
-    const watchedResult = await getWatchedKeys(indexClient, userId ?? undefined);
+    const watchedResult = await getWatchedKeys(client, userId ?? undefined);
     if (watchedResult.error) {
       return errorResponse(`Failed to fetch watched keys: ${(watchedResult.error as Error).message ?? watchedResult.error}`, "internal");
     }
@@ -811,7 +805,7 @@ async function indexBucket(
             const mimeType = getMimeType(obj.key);
 
             // Create event
-            const insertResult = await insertEvent(indexClient, {
+            const insertResult = await insertEvent(client, {
               id: eventId,
               device_id: `whatsapp:${phoneNumber}`,
               type: "create",
@@ -827,7 +821,7 @@ async function indexBucket(
             if (insertResult.error) throw insertResult.error;
 
             // Track watched key
-            const upsertResult = await upsertWatchedKey(indexClient, obj.key, eventId, obj.etag, obj.size, userId ?? undefined, s3.config.id);
+            const upsertResult = await upsertWatchedKey(client, obj.key, eventId, obj.etag, obj.size, userId ?? undefined, s3.config.id);
             if (upsertResult.error) {
               logger.warn("upsertWatchedKey failed", {
                 key: obj.key,
@@ -844,7 +838,7 @@ async function indexBucket(
                   obj.key,
                 );
                 const result = await enrichImage(imageBytes, mimeType);
-                const enrichInsert = await insertEnrichment(indexClient, eventId, result, userId ?? undefined);
+                const enrichInsert = await insertEnrichment(client, eventId, result, userId ?? undefined);
                 if (enrichInsert.error) throw enrichInsert.error;
                 return { key: obj.key, status: "enriched" };
               } catch (enrichErr) {
@@ -907,13 +901,12 @@ async function indexBucket(
 // ── Conversation history ───────────────────────────────────────
 
 export async function getConversationHistory(
+  client: SupabaseClient,
   phone: string,
   userId?: string | null,
 ): Promise<Message[]> {
-  const supabase = createAdminClient();
-
   if (userId) {
-    const { data } = await supabase
+    const { data } = await client
       .from("conversations")
       .select("history")
       .eq("user_id", userId)
@@ -922,7 +915,7 @@ export async function getConversationHistory(
   }
 
   // Fallback to phone_number for legacy callers
-  const { data } = await supabase
+  const { data } = await client
     .from("conversations")
     .select("history")
     .eq("phone_number", phone)
@@ -932,15 +925,15 @@ export async function getConversationHistory(
 }
 
 export async function saveConversationHistory(
+  client: SupabaseClient,
   phone: string,
   history: Message[],
   userId?: string | null,
 ): Promise<void> {
-  const supabase = createAdminClient();
   const trimmed = history.slice(-20);
 
   if (userId) {
-    await supabase.from("conversations").upsert(
+    await client.from("conversations").upsert(
       {
         user_id: userId,
         phone_number: phone,
@@ -953,7 +946,7 @@ export async function saveConversationHistory(
   }
 
   // Fallback to phone_number for legacy callers
-  await supabase.from("conversations").upsert({
+  await client.from("conversations").upsert({
     phone_number: phone,
     history: trimmed,
     updated_at: new Date().toISOString(),
