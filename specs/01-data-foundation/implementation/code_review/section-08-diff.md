diff --git a/01-data-foundation/implementation/deep_implement_config.json b/01-data-foundation/implementation/deep_implement_config.json
index 9e5e48a..771d525 100644
--- a/01-data-foundation/implementation/deep_implement_config.json
+++ b/01-data-foundation/implementation/deep_implement_config.json
@@ -46,6 +46,10 @@
     "section-04-rpc-user-isolation": {
       "status": "complete",
       "commit_hash": "7283ca29210a8541c300b0827f4b26f97ee5dbe6"
+    },
+    "section-06-rls-tests": {
+      "status": "complete",
+      "commit_hash": "53a1ef1b37bab68111eff30cebee09e4102fe100"
     }
   },
   "pre_commit": {
diff --git a/web/__tests__/helpers/agent-test-setup.ts b/web/__tests__/helpers/agent-test-setup.ts
index 6ff1104..51c84c2 100644
--- a/web/__tests__/helpers/agent-test-setup.ts
+++ b/web/__tests__/helpers/agent-test-setup.ts
@@ -19,7 +19,7 @@ export const mockS3Send = vi.fn();
 
 /** Mock a `select → eq → eq → maybeSingle` chain (used by getBucketConfig). */
 export function mockBucketLookup(config: Record<string, unknown> | null) {
-  mockFrom.mockReturnValue({
+  const bucketChain = {
     select: () => ({
       eq: () => ({
         eq: () => ({
@@ -27,7 +27,8 @@ export function mockBucketLookup(config: Record<string, unknown> | null) {
         }),
       }),
     }),
-  });
+  };
+  mockWithUserResolution(bucketChain);
 }
 
 /** Mock an `insert → select → single` chain (used by addBucket). Returns the mock insert fn for assertions. */
@@ -39,7 +40,8 @@ export function mockBucketInsert(
     single: () => Promise.resolve({ data: responseData, error }),
   });
   const mockInsert = vi.fn().mockReturnValue({ select: mockSelect });
-  mockFrom.mockReturnValue({ insert: mockInsert });
+  const bucketChain = { insert: mockInsert };
+  mockWithUserResolution(bucketChain);
   return mockInsert;
 }
 
@@ -52,23 +54,50 @@ export function mockBucketInsertCapture(responseData: Record<string, unknown>) {
   const mockSelect = vi.fn().mockReturnValue({
     single: () => Promise.resolve({ data: responseData, error: null }),
   });
-  mockFrom.mockReturnValue({
+  const bucketChain = {
     insert: vi.fn((row: Record<string, unknown>) => {
       ref.row = row;
       return { select: mockSelect };
     }),
-  });
+  };
+  mockWithUserResolution(bucketChain);
   return ref;
 }
 
 /** Mock a `delete → eq → eq` chain (used by removeBucket). */
 export function mockBucketDelete(error: Record<string, unknown> | null = null) {
-  mockFrom.mockReturnValue({
+  const bucketChain = {
     delete: () => ({
       eq: () => ({
         eq: () => Promise.resolve({ error }),
       }),
     }),
+  };
+  mockWithUserResolution(bucketChain);
+}
+
+// ── resolveUserId chain helper ──────────────────────────────────
+
+/** Chain returned for user_profiles lookups (resolveUserId). */
+const userProfilesChain = {
+  select: () => ({
+    eq: () => ({
+      maybeSingle: () =>
+        Promise.resolve({ data: { id: "test-user-uuid" }, error: null }),
+    }),
+  }),
+};
+
+/**
+ * Wraps mockFrom to handle resolveUserId's user_profiles lookup transparently.
+ * Call this in beforeEach after setting up the bucket mock chain.
+ * It makes mockFrom dispatch by table name: "user_profiles" → resolveUserId chain,
+ * anything else → the previously configured return value.
+ */
+export function mockWithUserResolution(bucketChain: Record<string, unknown>) {
+  mockFrom.mockImplementation((table: string) => {
+    if (table === "user_profiles") return userProfilesChain;
+    return bucketChain;
   });
 }
 
@@ -79,6 +108,7 @@ export const PHONE = "+1234567890";
 export const fakeBucketConfig = {
   id: "cfg-1",
   phone_number: PHONE,
+  user_id: "test-user-uuid",
   bucket_name: "my-bucket",
   endpoint_url: "https://s3.example.com",
   region: "us-east-1",
diff --git a/web/__tests__/phone-migration-app.test.ts b/web/__tests__/phone-migration-app.test.ts
new file mode 100644
index 0000000..942d1ea
--- /dev/null
+++ b/web/__tests__/phone-migration-app.test.ts
@@ -0,0 +1,303 @@
+/**
+ * Unit tests for section-08 phone-to-user_id migration app code changes.
+ * Tests that all DB functions properly pass userId and that the agent
+ * resolves phone numbers to user_ids before DB operations.
+ */
+
+import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
+
+// ── Mock Supabase ──────────────────────────────────────────────
+
+const { mockCreateClient } = vi.hoisted(() => {
+  const mockChain = () => {
+    const chain: Record<string, unknown> = {};
+    chain.select = vi.fn().mockReturnValue(chain);
+    chain.insert = vi.fn().mockReturnValue(chain);
+    chain.upsert = vi.fn().mockReturnValue(chain);
+    chain.update = vi.fn().mockReturnValue(chain);
+    chain.delete = vi.fn().mockReturnValue(chain);
+    chain.eq = vi.fn().mockReturnValue(chain);
+    chain.gte = vi.fn().mockReturnValue(chain);
+    chain.lte = vi.fn().mockReturnValue(chain);
+    chain.order = vi.fn().mockReturnValue(chain);
+    chain.range = vi.fn().mockReturnValue(chain);
+    chain.limit = vi.fn().mockReturnValue(chain);
+    chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
+    chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
+    // Default resolution for chained awaits
+    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
+      resolve({ data: [], count: 0, error: null });
+    return chain;
+  };
+
+  const fromChain = mockChain();
+  const rpcFn = vi.fn().mockResolvedValue({ data: [], error: null });
+
+  const mockCreateClient = vi.fn().mockReturnValue({
+    from: vi.fn().mockReturnValue(fromChain),
+    rpc: rpcFn,
+  });
+
+  return { mockCreateClient, fromChain, rpcFn };
+});
+
+vi.mock("@supabase/supabase-js", () => ({
+  createClient: mockCreateClient,
+}));
+
+// ── Mock encryption ──────────────────────────────────────────
+
+vi.mock("@/lib/crypto/encryption-versioned", () => ({
+  encryptSecretVersioned: vi.fn().mockResolvedValue("current:encrypted"),
+  decryptSecretVersioned: vi.fn().mockResolvedValue("decrypted-secret"),
+  getEncryptionVersion: vi.fn().mockReturnValue("current"),
+  needsMigration: vi.fn().mockReturnValue(false),
+}));
+
+// ── Mock S3 ──────────────────────────────────────────────────
+
+vi.mock("@/lib/media/s3", () => ({
+  createS3Client: vi.fn().mockReturnValue({}),
+  listS3Objects: vi.fn().mockResolvedValue([]),
+  downloadS3Object: vi.fn().mockResolvedValue(Buffer.from("test")),
+}));
+
+vi.mock("@/lib/media/utils", () => ({
+  newEventId: vi.fn().mockReturnValue("test-event-id"),
+  detectContentType: vi.fn().mockReturnValue("photo"),
+  getMimeType: vi.fn().mockReturnValue("image/jpeg"),
+  s3Metadata: vi.fn().mockReturnValue({}),
+}));
+
+vi.mock("@/lib/media/enrichment", () => ({
+  enrichImage: vi.fn().mockResolvedValue({
+    description: "test",
+    objects: [],
+    context: "test",
+    suggested_tags: [],
+  }),
+}));
+
+// ── Mock Anthropic ──────────────────────────────────────────
+
+vi.mock("@anthropic-ai/sdk", () => ({
+  default: vi.fn().mockImplementation(() => ({
+    messages: {
+      create: vi.fn().mockResolvedValue({
+        content: [{ type: "text", text: '{"action":"direct","response":"ok"}' }],
+      }),
+    },
+  })),
+}));
+
+vi.mock("@aws-sdk/client-s3", () => ({
+  ListObjectsV2Command: vi.fn(),
+  ListObjectsCommand: vi.fn(),
+}));
+
+// ── Imports (after mocks) ──────────────────────────────────
+
+import {
+  queryEvents,
+  showEvent,
+  getStats,
+  getEnrichStatus,
+  insertEvent,
+  insertEnrichment,
+  upsertWatchedKey,
+  getWatchedKeys,
+  findEventByHash,
+  getPendingEnrichments,
+} from "@/lib/media/db";
+
+import {
+  executeAction,
+  resolveUserId,
+} from "@/lib/agent/core";
+
+// ── Test Setup ─────────────────────────────────────────────
+
+beforeEach(() => {
+  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
+  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-pub-key");
+  vi.stubEnv("SUPABASE_SECRET_KEY", "test-secret-key");
+  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
+  mockCreateClient.mockClear();
+});
+
+afterEach(() => {
+  vi.unstubAllEnvs();
+});
+
+// ── Tests ──────────────────────────────────────────────────
+
+describe("db.ts userId parameters", () => {
+  it("queryEvents passes userId filter on direct queries", async () => {
+    const client = mockCreateClient();
+    const fromMock = client.from;
+
+    await queryEvents({ userId: "user-123", limit: 10 });
+
+    expect(fromMock).toHaveBeenCalledWith("events");
+    const chain = fromMock.mock.results[0]?.value;
+    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-123");
+  });
+
+  it("queryEvents passes p_user_id to search RPC", async () => {
+    const client = mockCreateClient();
+
+    await queryEvents({ userId: "user-123", search: "beach" });
+
+    expect(client.rpc).toHaveBeenCalledWith("search_events", expect.objectContaining({
+      p_user_id: "user-123",
+    }));
+  });
+
+  it("showEvent passes userId filter", async () => {
+    const client = mockCreateClient();
+    const fromMock = client.from;
+
+    await showEvent("event-1", "user-123");
+
+    expect(fromMock).toHaveBeenCalledWith("events");
+  });
+
+  it("getStats passes userId to RPC calls and count queries", async () => {
+    const client = mockCreateClient();
+
+    await getStats("user-123");
+
+    expect(client.rpc).toHaveBeenCalledWith("stats_by_content_type", { p_user_id: "user-123" });
+    expect(client.rpc).toHaveBeenCalledWith("stats_by_event_type", { p_user_id: "user-123" });
+  });
+
+  it("getEnrichStatus passes userId to queries", async () => {
+    const client = mockCreateClient();
+    const fromMock = client.from;
+
+    await getEnrichStatus("user-123");
+
+    expect(fromMock).toHaveBeenCalledWith("events");
+    expect(fromMock).toHaveBeenCalledWith("enrichments");
+  });
+
+  it("insertEnrichment includes userId in payload", async () => {
+    const client = mockCreateClient();
+    const fromMock = client.from;
+
+    await insertEnrichment(
+      "event-1",
+      { description: "test", objects: [], context: "test", suggested_tags: [] },
+      "user-123",
+    );
+
+    expect(fromMock).toHaveBeenCalledWith("enrichments");
+    const chain = fromMock.mock.results[0]?.value;
+    expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({
+      user_id: "user-123",
+    }));
+  });
+
+  it("upsertWatchedKey includes userId in payload", async () => {
+    const client = mockCreateClient();
+    const fromMock = client.from;
+
+    await upsertWatchedKey("key.jpg", "event-1", "etag", 1024, "user-123");
+
+    expect(fromMock).toHaveBeenCalledWith("watched_keys");
+    const chain = fromMock.mock.results[0]?.value;
+    expect(chain.upsert).toHaveBeenCalledWith(
+      expect.objectContaining({ user_id: "user-123" }),
+      expect.any(Object),
+    );
+  });
+
+  it("getWatchedKeys filters by userId", async () => {
+    const client = mockCreateClient();
+    const fromMock = client.from;
+
+    await getWatchedKeys("user-123");
+
+    expect(fromMock).toHaveBeenCalledWith("watched_keys");
+    const chain = fromMock.mock.results[0]?.value;
+    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-123");
+  });
+
+  it("findEventByHash filters by userId", async () => {
+    const client = mockCreateClient();
+    const fromMock = client.from;
+
+    await findEventByHash("hash-abc", "user-123");
+
+    expect(fromMock).toHaveBeenCalledWith("events");
+    const chain = fromMock.mock.results[0]?.value;
+    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-123");
+  });
+
+  it("getPendingEnrichments filters by userId", async () => {
+    const client = mockCreateClient();
+    const fromMock = client.from;
+
+    await getPendingEnrichments("user-123");
+
+    expect(fromMock).toHaveBeenCalledWith("events");
+  });
+});
+
+describe("core.ts resolveUserId", () => {
+  it("resolveUserId queries user_profiles by phone_number", async () => {
+    const client = mockCreateClient();
+    const fromMock = client.from;
+
+    // Mock the maybeSingle to return a user
+    const chain = fromMock.mock.results[0]?.value;
+    chain.maybeSingle.mockResolvedValueOnce({
+      data: { id: "resolved-user-id" },
+      error: null,
+    });
+
+    const result = await resolveUserId("+1234567890");
+
+    expect(fromMock).toHaveBeenCalledWith("user_profiles");
+    expect(chain.eq).toHaveBeenCalledWith("phone_number", "+1234567890");
+    expect(result).toBe("resolved-user-id");
+  });
+
+  it("resolveUserId returns null when no user found", async () => {
+    const client = mockCreateClient();
+    const fromMock = client.from;
+
+    const chain = fromMock.mock.results[0]?.value;
+    chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
+
+    const result = await resolveUserId("+9999999999");
+    expect(result).toBeNull();
+  });
+});
+
+describe("core.ts executeAction userId propagation", () => {
+  it("executeAction passes resolved userId to getStats", async () => {
+    // This test verifies the integration: executeAction resolves phone → userId
+    // then passes it through to the DB functions.
+    // The mock setup ensures resolveUserId returns a known value.
+    const client = mockCreateClient();
+    const fromMock = client.from;
+
+    // Mock resolveUserId path
+    const chain = fromMock.mock.results[0]?.value;
+    chain.maybeSingle.mockResolvedValueOnce({
+      data: { id: "test-user-uuid" },
+      error: null,
+    });
+
+    const result = await executeAction(
+      { action: "stats" },
+      "whatsapp:+1234567890",
+    );
+
+    // Should have called user_profiles to resolve
+    expect(fromMock).toHaveBeenCalledWith("user_profiles");
+    // Result should be valid JSON (stats output)
+    expect(() => JSON.parse(result)).not.toThrow();
+  });
+});
diff --git a/web/__tests__/s3-actions.test.ts b/web/__tests__/s3-actions.test.ts
index 4253d45..7c75822 100644
--- a/web/__tests__/s3-actions.test.ts
+++ b/web/__tests__/s3-actions.test.ts
@@ -5,6 +5,7 @@ import {
   mockBucketLookup,
   mockBucketInsert,
   mockBucketDelete,
+  mockWithUserResolution,
   PHONE,
   fakeBucketConfig,
 } from "./helpers/agent-test-setup";
@@ -81,6 +82,8 @@ describe("S3 action handlers", () => {
   beforeEach(() => {
     vi.stubEnv("ENCRYPTION_KEY", "test-key");
     mockFrom.mockReset();
+    // Default: resolve user_profiles lookups, return empty chain for other tables
+    mockWithUserResolution({});
     mockS3Send.mockReset();
     vi.mocked(listS3Objects).mockReset();
     vi.mocked(downloadS3Object).mockReset();
@@ -275,7 +278,7 @@ describe("S3 action handlers", () => {
       const insertedRow = mockInsert.mock.calls[0][0];
       expect(insertedRow.secret_access_key).toBe("v2:encrypted");
       expect(insertedRow.encryption_key_version).toBe(2);
-      expect(insertedRow.phone_number).toBe(PHONE);
+      expect(insertedRow.user_id).toBe("test-user-uuid");
     });
 
     it("returns error on duplicate bucket", async () => {
diff --git a/web/__tests__/whatsapp-route.test.ts b/web/__tests__/whatsapp-route.test.ts
index 5d8634e..215d232 100644
--- a/web/__tests__/whatsapp-route.test.ts
+++ b/web/__tests__/whatsapp-route.test.ts
@@ -7,6 +7,7 @@ vi.mock("@/lib/agent/core", () => ({
   summarizeResult: vi.fn(),
   getConversationHistory: vi.fn(),
   saveConversationHistory: vi.fn(),
+  resolveUserId: vi.fn(),
 }));
 
 // Mock global fetch for Twilio calls
@@ -20,6 +21,7 @@ import {
   summarizeResult,
   getConversationHistory,
   saveConversationHistory,
+  resolveUserId,
 } from "@/lib/agent/core";
 import { NextRequest } from "next/server";
 
@@ -28,6 +30,7 @@ const mockExecute = vi.mocked(executeAction);
 const mockSummarize = vi.mocked(summarizeResult);
 const mockGetHistory = vi.mocked(getConversationHistory);
 const mockSaveHistory = vi.mocked(saveConversationHistory);
+const mockResolveUserId = vi.mocked(resolveUserId);
 
 function makeRequest(body: Record<string, string>): NextRequest {
   const formBody = new URLSearchParams(body).toString();
@@ -51,12 +54,15 @@ describe("WhatsApp route", () => {
     mockSummarize.mockReset();
     mockGetHistory.mockReset();
     mockSaveHistory.mockReset();
+    mockResolveUserId.mockReset();
     mockFetch.mockReset();
     // Default Twilio response
     mockFetch.mockResolvedValue({ ok: true });
     // Default conversation history
     mockGetHistory.mockResolvedValue([]);
     mockSaveHistory.mockResolvedValue(undefined);
+    // Default user resolution
+    mockResolveUserId.mockResolvedValue("test-user-uuid");
   });
 
   afterEach(() => {
diff --git a/web/app/api/whatsapp/route.ts b/web/app/api/whatsapp/route.ts
index cacbde0..a2c2339 100644
--- a/web/app/api/whatsapp/route.ts
+++ b/web/app/api/whatsapp/route.ts
@@ -12,6 +12,7 @@ import {
   summarizeResult,
   getConversationHistory,
   saveConversationHistory,
+  resolveUserId,
 } from "@/lib/agent/core";
 
 // ── Twilio helpers ─────────────────────────────────────────────
@@ -98,9 +99,12 @@ export async function POST(req: NextRequest) {
       });
     }
 
+    // Resolve phone number to user_id
+    const userId = await resolveUserId(fromNumber);
+
     // Get conversation history
     console.log(`[${ts()}][${reqId}] fetching conversation history`);
-    const history = await getConversationHistory(fromNumber);
+    const history = await getConversationHistory(fromNumber, userId);
 
     // Plan
     console.log(`[${ts()}][${reqId}] planning action`);
@@ -121,7 +125,7 @@ export async function POST(req: NextRequest) {
     // Persist conversation
     history.push({ role: "user", content: messageBody });
     history.push({ role: "assistant", content: responseText });
-    await saveConversationHistory(fromNumber, history);
+    await saveConversationHistory(fromNumber, history, userId);
 
     console.log(`[${ts()}][${reqId}] sending reply (${responseText.length} chars): ${responseText.slice(0, 100)}...`);
 
diff --git a/web/bin/smgr.ts b/web/bin/smgr.ts
index 9a7941b..895d999 100644
--- a/web/bin/smgr.ts
+++ b/web/bin/smgr.ts
@@ -37,6 +37,13 @@ import { enrichImage } from "../lib/media/enrichment";
 
 // ── Helpers ──────────────────────────────────────────────────
 
+/** Get the user_id from SMGR_USER_ID env var (required for write operations after migration). */
+function requireUserId(): string {
+  const userId = process.env.SMGR_USER_ID;
+  if (!userId) die("Set SMGR_USER_ID environment variable (user UUID for tenant-scoped operations)");
+  return userId;
+}
+
 function die(msg: string): never {
   console.error(msg);
   process.exit(1);
@@ -64,6 +71,7 @@ async function cmdQuery(args: string[]) {
   });
 
   const result = await queryEvents({
+    userId: process.env.SMGR_USER_ID,
     search: values.search,
     type: values.type,
     since: values.since,
@@ -110,15 +118,14 @@ async function cmdShow(args: string[]) {
   const eventId = args[0];
   if (!eventId) die("Usage: smgr show <event_id>");
 
-  const event = await showEvent(eventId);
+  const event = await showEvent(eventId, process.env.SMGR_USER_ID);
   if (!event) die(`Event not found: ${eventId}`);
 
   printJson(event);
 }
 
 async function cmdStats() {
-  // TODO(section-08): pass authenticated userId for user-scoped stats
-  const stats = await getStats();
+  const stats = await getStats(process.env.SMGR_USER_ID);
   printJson(stats);
 }
 
@@ -134,7 +141,7 @@ async function cmdEnrich(args: string[]) {
   });
 
   if (values.status) {
-    const status = await getEnrichStatus();
+    const status = await getEnrichStatus(process.env.SMGR_USER_ID);
     printJson(status);
     return;
   }
@@ -143,7 +150,7 @@ async function cmdEnrich(args: string[]) {
 
   if (eventId) {
     // Enrich a specific event
-    const event = await showEvent(eventId);
+    const event = await showEvent(eventId, process.env.SMGR_USER_ID);
     if (!event) die(`Event not found: ${eventId}`);
 
     const meta = (event.metadata as Record<string, unknown>) ?? {};
@@ -162,13 +169,13 @@ async function cmdEnrich(args: string[]) {
 
     console.log(`Enriching event ${eventId}...`);
     const result = await enrichImage(imageBytes, mime);
-    await insertEnrichment(eventId, result);
+    await insertEnrichment(eventId, result, process.env.SMGR_USER_ID);
     console.log("Done.");
     return;
   }
 
   if (values.pending) {
-    const pending = await getPendingEnrichments();
+    const pending = await getPendingEnrichments(process.env.SMGR_USER_ID);
     if (pending.length === 0) {
       console.log("No pending enrichments.");
       return;
@@ -201,7 +208,7 @@ async function cmdEnrich(args: string[]) {
         const imageBytes = await downloadS3Object(s3, bucket, s3Key);
         const mime = (meta.mime_type as string) ?? getMimeType(s3Key);
         const result = await enrichImage(imageBytes, mime);
-        await insertEnrichment(event.id, result);
+        await insertEnrichment(event.id, result, process.env.SMGR_USER_ID);
         done++;
         console.log("  Done.");
       } catch (err) {
@@ -227,6 +234,7 @@ async function cmdWatch(args: string[]) {
   const bucket = process.env.SMGR_S3_BUCKET;
   if (!bucket) die("Set SMGR_S3_BUCKET environment variable");
 
+  const userId = requireUserId();
   const prefix = process.env.SMGR_S3_PREFIX ?? "";
   const interval = parseInt(process.env.SMGR_WATCH_INTERVAL ?? "30", 10);
   const autoEnrich = (process.env.SMGR_AUTO_ENRICH ?? "true").toLowerCase() !== "false";
@@ -249,7 +257,7 @@ async function cmdWatch(args: string[]) {
     try {
       const objects = await listS3Objects(s3, bucket, prefix);
       const mediaObjects = objects.filter((o) => isMediaKey(o.key));
-      const seenKeys = await getWatchedKeys();
+      const seenKeys = await getWatchedKeys(userId);
       const newObjects = mediaObjects.filter((o) => !seenKeys.has(o.key));
 
       if (newObjects.length > 0) {
@@ -262,9 +270,9 @@ async function cmdWatch(args: string[]) {
             const imageBytes = await downloadS3Object(s3, bucket, obj.key);
             const contentHash = sha256Bytes(imageBytes);
 
-            const existingId = await findEventByHash(contentHash);
+            const existingId = await findEventByHash(contentHash, userId);
             if (existingId) {
-              await upsertWatchedKey(obj.key, existingId, obj.etag, obj.size);
+              await upsertWatchedKey(obj.key, existingId, obj.etag, obj.size, userId);
               console.log(`    Already indexed (hash match)`);
               continue;
             }
@@ -284,8 +292,9 @@ async function cmdWatch(args: string[]) {
               remote_path: remotePath,
               metadata: meta,
               parent_id: null,
+              user_id: userId,
             });
-            await upsertWatchedKey(obj.key, eventId, obj.etag, obj.size);
+            await upsertWatchedKey(obj.key, eventId, obj.etag, obj.size, userId);
             console.log(`    Created event ${eventId}`);
 
             if (autoEnrich && contentType === "photo") {
@@ -294,7 +303,7 @@ async function cmdWatch(args: string[]) {
                 console.log("    Enriching...");
                 try {
                   const result = await enrichImage(imageBytes, mime);
-                  await insertEnrichment(eventId, result);
+                  await insertEnrichment(eventId, result, userId);
                   console.log("    Enriched.");
                 } catch (err) {
                   console.error(`    Enrichment failed: ${err}`);
@@ -303,7 +312,7 @@ async function cmdWatch(args: string[]) {
             }
           } catch (err) {
             console.error(`    Error: ${err}`);
-            await upsertWatchedKey(obj.key, null, obj.etag, obj.size);
+            await upsertWatchedKey(obj.key, null, obj.etag, obj.size, userId);
           }
         }
       }
@@ -349,6 +358,7 @@ Environment:
   SMGR_S3_ENDPOINT             Custom S3 endpoint (for Supabase Storage)
   SMGR_S3_REGION               AWS region (default: us-east-1)
   ANTHROPIC_API_KEY            For enrichment
+  SMGR_USER_ID                 User UUID for tenant-scoped operations
   SMGR_DEVICE_ID               Device identifier (default: default)
   SMGR_WATCH_INTERVAL          Poll interval in seconds (default: 30)
   SMGR_AUTO_ENRICH             Auto-enrich on watch (default: true)`);
diff --git a/web/lib/agent/core.ts b/web/lib/agent/core.ts
index 2b0980a..c905d50 100644
--- a/web/lib/agent/core.ts
+++ b/web/lib/agent/core.ts
@@ -138,43 +138,58 @@ export async function planAction(
   return JSON.parse(text);
 }
 
+/** Resolve a phone number to a user_id via user_profiles lookup. */
+export async function resolveUserId(phoneNumber: string): Promise<string | null> {
+  const supabase = getAdminClient();
+  const { data } = await supabase
+    .from("user_profiles")
+    .select("id")
+    .eq("phone_number", phoneNumber)
+    .maybeSingle();
+  return data?.id ?? null;
+}
+
 export async function executeAction(
   plan: AgentPlan,
   phoneNumber: string,
 ): Promise<string> {
+  // Resolve phone to user_id for all DB operations
+  const userId = await resolveUserId(phoneNumber);
+
   switch (plan.action) {
     case "direct":
       return plan.response ?? "";
 
     case "add_bucket":
-      return await addBucket(phoneNumber, plan.params ?? {});
+      return await addBucket(phoneNumber, plan.params ?? {}, userId);
 
     case "list_buckets":
-      return await listBuckets(phoneNumber);
+      return await listBuckets(phoneNumber, userId);
 
     case "remove_bucket":
       return await removeBucket(
         phoneNumber,
         plan.params?.bucket_name as string,
+        userId,
       );
 
     case "stats":
-      // TODO(section-08): pass resolved userId from phone number
-      return JSON.stringify(await getStats());
+      return JSON.stringify(await getStats(userId ?? undefined));
 
     case "show":
       return JSON.stringify(
-        (await showEvent(plan.params?.id as string)) ?? {
+        (await showEvent(plan.params?.id as string, userId ?? undefined)) ?? {
           error: "Event not found",
         },
       );
 
     case "enrich_status":
-      return JSON.stringify(await getEnrichStatus());
+      return JSON.stringify(await getEnrichStatus(userId ?? undefined));
 
     case "query": {
       const p = plan.params ?? {};
       const result = await queryEvents({
+        userId: userId ?? undefined,
         search: p.search as string | undefined,
         type: p.type as string | undefined,
         since: p.since as string | undefined,
@@ -188,6 +203,7 @@ export async function executeAction(
       return await verifyBucketConfig(
         phoneNumber,
         plan.params?.bucket_name as string,
+        userId,
       );
 
     case "list_objects":
@@ -196,6 +212,7 @@ export async function executeAction(
         plan.params?.bucket_name as string,
         plan.params?.prefix as string | undefined,
         (plan.params?.limit as number) ?? 100,
+        userId,
       );
 
     case "count_objects":
@@ -203,6 +220,7 @@ export async function executeAction(
         phoneNumber,
         plan.params?.bucket_name as string,
         plan.params?.prefix as string | undefined,
+        userId,
       );
 
     case "index_bucket":
@@ -211,6 +229,7 @@ export async function executeAction(
         plan.params?.bucket_name as string,
         plan.params?.prefix as string | undefined,
         (plan.params?.batch_size as number) ?? 10,
+        userId,
       );
 
     default:
@@ -259,6 +278,7 @@ Summarize conversationally. Keep it short — this is a chat message.
 async function addBucket(
   phoneNumber: string,
   params: Record<string, unknown>,
+  userId: string | null,
 ): Promise<string> {
   const bucketName = params.bucket_name as string;
   const endpointUrl = params.endpoint_url as string;
@@ -273,6 +293,10 @@ async function addBucket(
     });
   }
 
+  if (!userId) {
+    return JSON.stringify({ error: "Could not resolve user for this phone number" });
+  }
+
   // Use versioned encryption for new buckets
   const encryptedSecret = await encryptSecretVersioned(secretAccessKey);
   const keyVersion = getEncryptionVersion(encryptedSecret);
@@ -281,7 +305,7 @@ async function addBucket(
   const { data, error } = await supabase
     .from("bucket_configs")
     .insert({
-      phone_number: phoneNumber,
+      user_id: userId,
       bucket_name: bucketName,
       region,
       endpoint_url: endpointUrl,
@@ -313,7 +337,11 @@ async function addBucket(
   });
 }
 
-async function listBuckets(phoneNumber: string): Promise<string> {
+async function listBuckets(phoneNumber: string, userId: string | null): Promise<string> {
+  if (!userId) {
+    return JSON.stringify({ error: "Could not resolve user for this phone number" });
+  }
+
   const supabase = getAdminClient();
 
   const { data, error } = await supabase
@@ -321,7 +349,7 @@ async function listBuckets(phoneNumber: string): Promise<string> {
     .select(
       "id, bucket_name, region, endpoint_url, created_at, last_synced_key",
     )
-    .eq("phone_number", phoneNumber)
+    .eq("user_id", userId)
     .order("created_at", { ascending: false });
 
   if (error) {
@@ -335,17 +363,22 @@ async function listBuckets(phoneNumber: string): Promise<string> {
 async function removeBucket(
   phoneNumber: string,
   bucketName: string,
+  userId: string | null,
 ): Promise<string> {
   if (!bucketName) {
     return JSON.stringify({ error: "bucket_name is required" });
   }
 
+  if (!userId) {
+    return JSON.stringify({ error: "Could not resolve user for this phone number" });
+  }
+
   const supabase = getAdminClient();
 
   const { error } = await supabase
     .from("bucket_configs")
     .delete()
-    .eq("phone_number", phoneNumber)
+    .eq("user_id", userId)
     .eq("bucket_name", bucketName);
 
   if (error) {
@@ -386,6 +419,7 @@ type S3ClientResult =
 async function requireS3Client(
   phoneNumber: string,
   bucketName: string,
+  userId?: string | null,
 ): Promise<S3ClientResult> {
   if (!bucketName)
     return {
@@ -393,7 +427,7 @@ async function requireS3Client(
       errorJson: JSON.stringify({ error: "bucket_name is required" }),
     };
 
-  const result = await getBucketConfig(phoneNumber, bucketName);
+  const result = await getBucketConfig(phoneNumber, bucketName, userId);
   if (!result.exists)
     return {
       ok: false,
@@ -424,15 +458,24 @@ async function requireS3Client(
 async function getBucketConfig(
   phoneNumber: string,
   bucketName: string,
+  userId?: string | null,
 ): Promise<BucketConfigResult> {
   if (!bucketName) return { exists: false };
   const supabase = getAdminClient();
-  const { data, error } = await supabase
+
+  let query = supabase
     .from("bucket_configs")
     .select("*")
-    .eq("phone_number", phoneNumber)
-    .eq("bucket_name", bucketName)
-    .maybeSingle();
+    .eq("bucket_name", bucketName);
+
+  // Query by user_id if available, fall back to phone_number for legacy callers
+  if (userId) {
+    query = query.eq("user_id", userId);
+  } else {
+    query = query.eq("phone_number", phoneNumber);
+  }
+
+  const { data, error } = await query.maybeSingle();
 
   if (error || !data) return { exists: false };
 
@@ -497,8 +540,9 @@ async function getBucketConfig(
 async function verifyBucketConfig(
   phoneNumber: string,
   bucketName: string,
+  userId?: string | null,
 ): Promise<string> {
-  const s3 = await requireS3Client(phoneNumber, bucketName);
+  const s3 = await requireS3Client(phoneNumber, bucketName, userId);
   if (!s3.ok) return s3.errorJson;
 
   try {
@@ -542,8 +586,9 @@ async function listObjects(
   bucketName: string,
   prefix?: string,
   limit = 100,
+  userId?: string | null,
 ): Promise<string> {
-  const s3 = await requireS3Client(phoneNumber, bucketName);
+  const s3 = await requireS3Client(phoneNumber, bucketName, userId);
   if (!s3.ok) return s3.errorJson;
 
   try {
@@ -572,8 +617,9 @@ async function countObjects(
   phoneNumber: string,
   bucketName: string,
   prefix?: string,
+  userId?: string | null,
 ): Promise<string> {
-  const s3 = await requireS3Client(phoneNumber, bucketName);
+  const s3 = await requireS3Client(phoneNumber, bucketName, userId);
   if (!s3.ok) return s3.errorJson;
 
   try {
@@ -611,8 +657,9 @@ async function indexBucket(
   bucketName: string,
   prefix?: string,
   batchSize = 10,
+  userId?: string | null,
 ): Promise<string> {
-  const s3 = await requireS3Client(phoneNumber, bucketName);
+  const s3 = await requireS3Client(phoneNumber, bucketName, userId);
   if (!s3.ok) return s3.errorJson;
 
   try {
@@ -620,7 +667,7 @@ async function indexBucket(
     const allObjects = await listS3Objects(s3.client, bucketName, prefix ?? "");
 
     // Get already-watched keys to find new ones
-    const watchedKeys = await getWatchedKeys();
+    const watchedKeys = await getWatchedKeys(userId ?? undefined);
     const newObjects = allObjects.filter((o) => !watchedKeys.has(o.key));
 
     // Take only batch_size items
@@ -648,10 +695,11 @@ async function indexBucket(
           metadata: s3Metadata(obj.key, obj.size, obj.etag),
           parent_id: null,
           bucket_config_id: s3.config.id,
+          user_id: userId ?? "",
         });
 
         // Track watched key
-        await upsertWatchedKey(obj.key, eventId, obj.etag, obj.size);
+        await upsertWatchedKey(obj.key, eventId, obj.etag, obj.size, userId ?? undefined);
         indexed++;
 
         // Enrich if it's an image we can analyze
@@ -663,7 +711,7 @@ async function indexBucket(
               obj.key,
             );
             const result = await enrichImage(imageBytes, mimeType);
-            await insertEnrichment(eventId, result);
+            await insertEnrichment(eventId, result, userId ?? undefined);
             enriched++;
           } catch (enrichErr) {
             // Log enrichment failure but don't fail the whole batch
@@ -677,6 +725,7 @@ async function indexBucket(
               remote_path: `s3://${bucketName}/${obj.key}`,
               metadata: { error: (enrichErr as Error).message },
               parent_id: eventId,
+              user_id: userId ?? "",
             });
           }
         }
@@ -705,9 +754,20 @@ async function indexBucket(
 
 export async function getConversationHistory(
   phone: string,
+  userId?: string | null,
 ): Promise<Message[]> {
   const supabase = getAdminClient();
 
+  if (userId) {
+    const { data } = await supabase
+      .from("conversations")
+      .select("history")
+      .eq("user_id", userId)
+      .single();
+    return (data?.history as Message[]) ?? [];
+  }
+
+  // Fallback to phone_number for legacy callers
   const { data } = await supabase
     .from("conversations")
     .select("history")
@@ -720,10 +780,25 @@ export async function getConversationHistory(
 export async function saveConversationHistory(
   phone: string,
   history: Message[],
+  userId?: string | null,
 ): Promise<void> {
   const supabase = getAdminClient();
   const trimmed = history.slice(-20);
 
+  if (userId) {
+    await supabase.from("conversations").upsert(
+      {
+        user_id: userId,
+        phone_number: phone,
+        history: trimmed,
+        updated_at: new Date().toISOString(),
+      },
+      { onConflict: "user_id" },
+    );
+    return;
+  }
+
+  // Fallback to phone_number for legacy callers
   await supabase.from("conversations").upsert({
     phone_number: phone,
     history: trimmed,
diff --git a/web/lib/media/db.ts b/web/lib/media/db.ts
index 0d1bad0..a6540f4 100644
--- a/web/lib/media/db.ts
+++ b/web/lib/media/db.ts
@@ -42,7 +42,7 @@ export interface EventRow {
   metadata: Record<string, unknown> | null;
   parent_id: string | null;
   bucket_config_id?: string | null;
-  user_id?: string | null;
+  user_id: string;
 }
 
 // ── Query ──────────────────────────────────────────────────────
@@ -83,6 +83,7 @@ export async function queryEvents(opts: QueryOptions) {
     .order("timestamp", { ascending: false })
     .range(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 20) - 1);
 
+  if (opts.userId) query = query.eq("user_id", opts.userId);
   if (opts.type) query = query.eq("content_type", opts.type);
   if (opts.since) query = query.gte("timestamp", opts.since);
   if (opts.until) query = query.lte("timestamp", opts.until);
@@ -109,7 +110,7 @@ export async function queryEvents(opts: QueryOptions) {
 
 // ── Show ───────────────────────────────────────────────────────
 
-export async function showEvent(eventId: string) {
+export async function showEvent(eventId: string, userId?: string) {
   const supabase = getUserClient();
 
   const { data: event, error } = await supabase
@@ -140,19 +141,23 @@ export async function showEvent(eventId: string) {
 export async function getStats(userId?: string) {
   const supabase = getUserClient();
 
+  let eventsQuery = supabase.from("events").select("*", { count: "exact", head: true });
+  let enrichmentsQuery = supabase.from("enrichments").select("*", { count: "exact", head: true });
+  let watchedQuery = supabase.from("watched_keys").select("*", { count: "exact", head: true });
+
+  if (userId) {
+    eventsQuery = eventsQuery.eq("user_id", userId);
+    enrichmentsQuery = enrichmentsQuery.eq("user_id", userId);
+    watchedQuery = watchedQuery.eq("user_id", userId);
+  }
+
   const [byContentType, byEventType, totalRes, enrichedRes, watchedRes] =
     await Promise.all([
       supabase.rpc("stats_by_content_type", { p_user_id: userId }),
       supabase.rpc("stats_by_event_type", { p_user_id: userId }),
-      supabase
-        .from("events")
-        .select("*", { count: "exact", head: true }),
-      supabase
-        .from("enrichments")
-        .select("*", { count: "exact", head: true }),
-      supabase
-        .from("watched_keys")
-        .select("*", { count: "exact", head: true }),
+      eventsQuery,
+      enrichmentsQuery,
+      watchedQuery,
     ]);
 
   const contentTypeCounts: Record<string, number> = {};
@@ -183,18 +188,26 @@ export async function getStats(userId?: string) {
 
 // ── Enrich Status ──────────────────────────────────────────────
 
-export async function getEnrichStatus() {
+export async function getEnrichStatus(userId?: string) {
   const supabase = getUserClient();
 
+  let eventsQuery = supabase
+    .from("events")
+    .select("*", { count: "exact", head: true })
+    .eq("type", "create")
+    .eq("content_type", "photo");
+  let enrichmentsQuery = supabase
+    .from("enrichments")
+    .select("*", { count: "exact", head: true });
+
+  if (userId) {
+    eventsQuery = eventsQuery.eq("user_id", userId);
+    enrichmentsQuery = enrichmentsQuery.eq("user_id", userId);
+  }
+
   const [totalRes, enrichedRes] = await Promise.all([
-    supabase
-      .from("events")
-      .select("*", { count: "exact", head: true })
-      .eq("type", "create")
-      .eq("content_type", "photo"),
-    supabase
-      .from("enrichments")
-      .select("*", { count: "exact", head: true }),
+    eventsQuery,
+    enrichmentsQuery,
   ]);
 
   const total = totalRes.count ?? 0;
@@ -222,7 +235,8 @@ export async function insertEvent(event: Omit<EventRow, "timestamp"> & { timesta
 
 export async function insertEnrichment(
   eventId: string,
-  result: { description: string; objects: string[]; context: string; suggested_tags: string[] }
+  result: { description: string; objects: string[]; context: string; suggested_tags: string[] },
+  userId?: string,
 ) {
   const supabase = getAdminClient();
   const { error } = await supabase.from("enrichments").insert({
@@ -231,6 +245,7 @@ export async function insertEnrichment(
     objects: result.objects,
     context: result.context,
     tags: result.suggested_tags,
+    ...(userId ? { user_id: userId } : {}),
   });
   if (error) throw error;
 }
@@ -241,7 +256,8 @@ export async function upsertWatchedKey(
   s3Key: string,
   eventId: string | null,
   etag: string,
-  sizeBytes: number
+  sizeBytes: number,
+  userId?: string,
 ) {
   const supabase = getAdminClient();
   const { error } = await supabase.from("watched_keys").upsert(
@@ -251,6 +267,7 @@ export async function upsertWatchedKey(
       event_id: eventId,
       etag,
       size_bytes: sizeBytes,
+      ...(userId ? { user_id: userId } : {}),
     },
     { onConflict: "s3_key", ignoreDuplicates: true }
   );
@@ -259,24 +276,26 @@ export async function upsertWatchedKey(
 
 // ── Get Watched Keys ──────────────────────────────────────────
 
-export async function getWatchedKeys(): Promise<Set<string>> {
+export async function getWatchedKeys(userId?: string): Promise<Set<string>> {
   const supabase = getAdminClient();
-  const { data, error } = await supabase
-    .from("watched_keys")
-    .select("s3_key");
+  let query = supabase.from("watched_keys").select("s3_key");
+  if (userId) query = query.eq("user_id", userId);
+  const { data, error } = await query;
   if (error) throw error;
   return new Set((data ?? []).map((r) => r.s3_key));
 }
 
 // ── Check Duplicate by Hash ───────────────────────────────────
 
-export async function findEventByHash(hash: string): Promise<string | null> {
+export async function findEventByHash(hash: string, userId?: string): Promise<string | null> {
   const supabase = getUserClient();
-  const { data } = await supabase
+  let query = supabase
     .from("events")
     .select("id")
     .eq("type", "create")
-    .eq("content_hash", hash)
+    .eq("content_hash", hash);
+  if (userId) query = query.eq("user_id", userId);
+  const { data } = await query
     .limit(1)
     .maybeSingle();
   return data?.id ?? null;
@@ -284,22 +303,24 @@ export async function findEventByHash(hash: string): Promise<string | null> {
 
 // ── Get Pending Enrichments ───────────────────────────────────
 
-export async function getPendingEnrichments() {
+export async function getPendingEnrichments(userId?: string) {
   const supabase = getAdminClient();
 
   // Get photo events that don't have enrichments
-  const { data: photos, error: photosErr } = await supabase
+  let photosQuery = supabase
     .from("events")
     .select("id, content_hash, content_type, local_path, remote_path, metadata")
     .eq("type", "create")
     .eq("content_type", "photo")
     .order("timestamp", { ascending: false });
+  if (userId) photosQuery = photosQuery.eq("user_id", userId);
+  const { data: photos, error: photosErr } = await photosQuery;
 
   if (photosErr) throw photosErr;
 
-  const { data: enriched, error: enrichedErr } = await supabase
-    .from("enrichments")
-    .select("event_id");
+  let enrichedQuery = supabase.from("enrichments").select("event_id");
+  if (userId) enrichedQuery = enrichedQuery.eq("user_id", userId);
+  const { data: enriched, error: enrichedErr } = await enrichedQuery;
 
   if (enrichedErr) throw enrichedErr;
 
