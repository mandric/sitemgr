diff --git a/web/__tests__/db-operations.test.ts b/web/__tests__/db-operations.test.ts
index 3e96495..2983982 100644
--- a/web/__tests__/db-operations.test.ts
+++ b/web/__tests__/db-operations.test.ts
@@ -520,6 +520,68 @@ describe("getEnrichStatus", () => {
     expect(result.data!.pending).toBe(0);
   });
 
+  it("applies content_type filter with default CONTENT_TYPE_PHOTO", async () => {
+    const headChain = chainable();
+    headChain.select = vi.fn().mockReturnValue(headChain);
+    headChain.eq = vi.fn().mockReturnValue(headChain);
+
+    Object.defineProperty(headChain, "then", {
+      // eslint-disable-next-line @typescript-eslint/no-explicit-any
+      value: (resolve: any) => resolve({ data: null, count: 5, error: null }),
+      configurable: true,
+    });
+
+    mockFrom.mockReturnValue(headChain);
+
+    const { getEnrichStatus } = await import("@/lib/media/db");
+    await getEnrichStatus(mockSupabaseClient as never);
+
+    expect(headChain.eq).toHaveBeenCalledWith("content_type", "photo");
+  });
+
+  it("applies explicit contentType parameter", async () => {
+    const headChain = chainable();
+    headChain.select = vi.fn().mockReturnValue(headChain);
+    headChain.eq = vi.fn().mockReturnValue(headChain);
+
+    Object.defineProperty(headChain, "then", {
+      // eslint-disable-next-line @typescript-eslint/no-explicit-any
+      value: (resolve: any) => resolve({ data: null, count: 5, error: null }),
+      configurable: true,
+    });
+
+    mockFrom.mockReturnValue(headChain);
+
+    const { getEnrichStatus } = await import("@/lib/media/db");
+    await getEnrichStatus(mockSupabaseClient as never, undefined, "video");
+
+    expect(headChain.eq).toHaveBeenCalledWith("content_type", "video");
+  });
+
+  it("pending never goes negative (Math.max guard)", async () => {
+    const headChain = chainable();
+    headChain.select = vi.fn().mockReturnValue(headChain);
+    headChain.eq = vi.fn().mockReturnValue(headChain);
+
+    let callCount = 0;
+    Object.defineProperty(headChain, "then", {
+      // eslint-disable-next-line @typescript-eslint/no-explicit-any
+      value: (resolve: any) => {
+        callCount++;
+        // First call is events (total=3), second is enrichments (enriched=5)
+        resolve({ data: null, count: callCount === 1 ? 3 : 5, error: null });
+      },
+      configurable: true,
+    });
+
+    mockFrom.mockReturnValue(headChain);
+
+    const { getEnrichStatus } = await import("@/lib/media/db");
+    const result = await getEnrichStatus(mockSupabaseClient as never);
+
+    expect(result.data!.pending).toBe(0);
+  });
+
   it("handles no events", async () => {
     const headChain = chainable();
     headChain.select = vi.fn().mockReturnValue(headChain);
diff --git a/web/lib/media/db.ts b/web/lib/media/db.ts
index 3ab2b45..a23c3ee 100644
--- a/web/lib/media/db.ts
+++ b/web/lib/media/db.ts
@@ -261,11 +261,12 @@ export async function getStats(client: SupabaseClient, opts?: { userId?: string;
 
 // ── Enrich Status ──────────────────────────────────────────────
 
-export async function getEnrichStatus(client: SupabaseClient, userId?: string) {
+export async function getEnrichStatus(client: SupabaseClient, userId?: string, contentType = CONTENT_TYPE_PHOTO) {
   let eventsQuery = client
     .from("events")
     .select("*", { count: "exact", head: true })
-    .eq("type", "create");
+    .eq("type", "create")
+    .eq("content_type", contentType);
   let enrichmentsQuery = client
     .from("enrichments")
     .select("*", { count: "exact", head: true });
@@ -292,7 +293,7 @@ export async function getEnrichStatus(client: SupabaseClient, userId?: string) {
     data: {
       total_media: total,
       enriched,
-      pending: total - enriched,
+      pending: Math.max(0, total - enriched),
     },
     error: null,
   };
