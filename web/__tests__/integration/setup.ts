/**
 * Shared integration test setup for media pipeline tests.
 *
 * Requires `supabase start` to be running locally.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Local Supabase defaults from `supabase start`
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY ?? "";

export function getSupabaseConfig() {
  return {
    url: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    serviceKey: SUPABASE_SERVICE_KEY,
  };
}

export function getAdminClient(): SupabaseClient {
  if (!SUPABASE_SERVICE_KEY) {
    throw new Error(
      "SUPABASE_SECRET_KEY not set. Run `supabase start` and set env vars.",
    );
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function createTestUser(
  email?: string,
): Promise<{ userId: string; client: SupabaseClient }> {
  const admin = getAdminClient();
  const testEmail = email ?? `test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const testPassword = "test-password-" + Math.random().toString(36).slice(2);

  const { data, error } = await admin.auth.admin.createUser({
    email: testEmail,
    password: testPassword,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw new Error(`Failed to create test user: ${error?.message ?? "no user returned"}`);
  }

  const userId = data.user.id;

  // Sign in as the user to get an authenticated client
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await userClient.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  });

  return { userId, client: userClient };
}

export async function cleanupTestData(userId: string): Promise<void> {
  const admin = getAdminClient();

  // Delete in dependency order
  await admin.from("enrichments").delete().eq("user_id", userId);
  await admin.from("watched_keys").delete().eq("user_id", userId);
  await admin.from("events").delete().eq("user_id", userId);
  await admin.from("bucket_configs").delete().eq("user_id", userId);
  await admin.from("conversations").delete().eq("user_id", userId);
  await admin.from("user_profiles").delete().eq("id", userId);

  // Delete the auth user
  await admin.auth.admin.deleteUser(userId);
}

/** S3 config for local Supabase Storage */
export function getS3Config() {
  return {
    endpoint: `${SUPABASE_URL}/storage/v1/s3`,
    region: "local",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? SUPABASE_SERVICE_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? SUPABASE_SERVICE_KEY,
    forcePathStyle: true,
  };
}

/** Minimal valid JPEG buffer for testing */
export const TINY_JPEG = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
]);

// --- Seed Layer ---

export interface SeedOptions {
  eventCount?: number;
  withEnrichments?: boolean;
  withWatchedKeys?: boolean;
  withBucketConfig?: boolean;
  withConversation?: boolean;
  withUserProfile?: boolean;
}

export interface SeedResult {
  userId: string;
  eventIds: string[];
  enrichmentIds: string[];
  watchedKeyIds: string[];
  bucketConfigId: string | null;
  conversationUserId: string | null;
}

/**
 * Throws with full error context when a Supabase insert/upsert fails.
 */
export function assertInsert(
  description: string,
  result: { error: { message: string; code?: string; details?: string } | null },
): void {
  if (result.error) {
    throw new Error(
      `Seed failed: "${description}" — ${result.error.message} (${result.error.code || "unknown"})\nDetails: ${result.error.details || "none"}`,
    );
  }
}

/**
 * Creates a complete dataset for one test user. Inserts in dependency order.
 */
export async function seedUserData(
  admin: SupabaseClient,
  userId: string,
  opts?: SeedOptions,
): Promise<SeedResult> {
  const eventCount = opts?.eventCount ?? 2;
  const withEnrichments = opts?.withEnrichments ?? true;
  const withWatchedKeys = opts?.withWatchedKeys ?? true;
  const withBucketConfig = opts?.withBucketConfig ?? true;
  const withConversation = opts?.withConversation ?? true;
  const withUserProfile = opts?.withUserProfile ?? true;

  const prefix = userId.slice(0, 8);
  const result: SeedResult = {
    userId,
    eventIds: [],
    enrichmentIds: [],
    watchedKeyIds: [],
    bucketConfigId: null,
    conversationUserId: null,
  };

  // 1. user_profiles
  if (withUserProfile) {
    assertInsert(
      "user_profiles",
      await admin.from("user_profiles").insert({
        id: userId,
        phone_number: `+1555${prefix}`,
      }),
    );
  }

  // 2. events
  for (let i = 1; i <= eventCount; i++) {
    const eventId = `${prefix}-evt-${i}`;
    assertInsert(
      `events[${i}]`,
      await admin.from("events").insert({
        id: eventId,
        timestamp: new Date().toISOString(),
        device_id: `device-${prefix}`,
        type: "photo",
        content_type: "image/jpeg",
        content_hash: `hash-${prefix}-${i}`,
        user_id: userId,
      }),
    );
    result.eventIds.push(eventId);
  }

  // 3. enrichments (one per event)
  if (withEnrichments && eventCount > 0) {
    for (const eventId of result.eventIds) {
      assertInsert(
        `enrichments[${eventId}]`,
        await admin.from("enrichments").insert({
          event_id: eventId,
          description: `Test enrichment for ${eventId}`,
          objects: ["object1", "object2"],
          context: "test-context",
          tags: ["tag1", "tag2"],
          user_id: userId,
        }),
      );
      result.enrichmentIds.push(eventId);
    }
  }

  // 4. watched_keys (one per event)
  if (withWatchedKeys && eventCount > 0) {
    for (let i = 0; i < result.eventIds.length; i++) {
      const keyId = `${prefix}/media/file-${i + 1}.jpg`;
      assertInsert(
        `watched_keys[${keyId}]`,
        await admin.from("watched_keys").insert({
          s3_key: keyId,
          first_seen: new Date().toISOString(),
          event_id: result.eventIds[i],
          etag: `etag-${prefix}-${i + 1}`,
          size_bytes: 1024 * (i + 1),
          user_id: userId,
        }),
      );
      result.watchedKeyIds.push(keyId);
    }
  }

  // 5. bucket_configs
  if (withBucketConfig) {
    const bcResult = await admin
      .from("bucket_configs")
      .insert({
        user_id: userId,
        bucket_name: `test-bucket-${prefix}`,
        endpoint_url: "http://localhost:9000",
        access_key_id: "test-access-key",
        secret_access_key: "test-secret-key",
      })
      .select("id")
      .single();
    assertInsert("bucket_configs", bcResult);
    result.bucketConfigId = bcResult.data?.id ?? null;
  }

  // 6. conversations
  if (withConversation) {
    assertInsert(
      "conversations",
      await admin.from("conversations").insert({
        user_id: userId,
        phone_number: `+1555${prefix}`,
        history: JSON.stringify([{ role: "user", content: "hello" }]),
      }),
    );
    result.conversationUserId = userId;
  }

  return result;
}

/**
 * Removes all data for a test user. Logs warnings on cleanup errors instead of throwing.
 */
export async function cleanupUserData(
  admin: SupabaseClient,
  userId: string,
): Promise<void> {
  const tables = [
    { name: "enrichments", column: "user_id" },
    { name: "watched_keys", column: "user_id" },
    { name: "events", column: "user_id" },
    { name: "bucket_configs", column: "user_id" },
    { name: "conversations", column: "user_id" },
    { name: "user_profiles", column: "id" },
  ];

  for (const { name, column } of tables) {
    const { error } = await admin.from(name).delete().eq(column, userId);
    if (error) {
      console.warn(
        `Cleanup warning: ${name} delete failed for user ${userId}: ${error.message}`,
      );
    }
  }

  try {
    await admin.auth.admin.deleteUser(userId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Cleanup warning: auth user delete failed for ${userId}: ${msg}`);
  }
}
