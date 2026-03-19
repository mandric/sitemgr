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
    accessKeyId: SUPABASE_SERVICE_KEY,
    secretAccessKey: SUPABASE_SERVICE_KEY,
    forcePathStyle: true,
  };
}

/** Minimal valid JPEG buffer for testing */
export const TINY_JPEG = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
]);
