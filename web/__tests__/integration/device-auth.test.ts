/**
 * Integration tests for device code authentication flow.
 *
 * Tests the complete lifecycle: initiate → approve → poll → verifyOtp.
 * Runs against real local Supabase and the Next.js dev server.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAdminClient,
  createTestUser,
} from "./setup";

const APP_URL = `http://localhost:${process.env.WEB_PORT ?? "3000"}`;

describe("device code auth flow", () => {
  let admin: SupabaseClient;
  const cleanupUserIds: string[] = [];
  const cleanupDeviceCodes: string[] = [];

  beforeAll(() => {
    admin = getAdminClient();
  });

  afterAll(async () => {
    for (const dc of cleanupDeviceCodes) {
      await admin.from("device_codes").delete().eq("device_code", dc);
    }
    for (const uid of cleanupUserIds) {
      try {
        await admin.auth.admin.deleteUser(uid);
      } catch {
        // ignore cleanup errors
      }
    }
    await admin.removeAllChannels();
  });

  it("complete happy path: initiate → approve → poll → verifyOtp", async () => {
    // 1. Initiate device code flow
    const initiateRes = await fetch(`${APP_URL}/api/auth/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_name: "integration-test" }),
    });
    expect(initiateRes.status).toBe(201);
    const {
      device_code,
      user_code,
      verification_url,
      expires_at,
      interval,
    } = await initiateRes.json();
    expect(device_code).toBeDefined();
    expect(user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(verification_url).toContain(user_code);
    expect(expires_at).toBeDefined();
    expect(interval).toBe(5);
    cleanupDeviceCodes.push(device_code);

    // 2. Create a test user
    const { userId } = await createTestUser();
    cleanupUserIds.push(userId);

    // Get user email
    const { data: userData } = await admin.auth.admin.getUserById(userId);
    const testEmail = userData.user!.email!;

    // 3. Generate magic link token via admin API
    const { data: linkData, error: linkError } =
      await admin.auth.admin.generateLink({
        type: "magiclink",
        email: testEmail,
      });
    expect(linkError).toBeNull();
    const hashedToken = linkData?.properties?.hashed_token ?? "";
    expect(hashedToken).toBeDefined();

    // 4. Simulate approval by updating device_codes row directly
    const { error: updateError } = await admin
      .from("device_codes")
      .update({
        status: "approved",
        user_id: userId,
        email: testEmail,
        token_hash: hashedToken,
        approved_at: new Date().toISOString(),
      })
      .eq("device_code", device_code);
    expect(updateError).toBeNull();

    // 5. Poll for approved status — server-side verifyOtp returns session directly
    const pollRes = await fetch(`${APP_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code }),
    });
    expect(pollRes.status).toBe(200);
    const pollData = await pollRes.json();
    expect(pollData.status).toBe("approved");
    expect(pollData.access_token).toBeDefined();
    expect(pollData.refresh_token).toBeDefined();
    expect(pollData.user_id).toBeDefined();
    expect(pollData.email).toBe(testEmail);

    // 6. Second poll should return consumed (no session fields)
    const pollRes2 = await fetch(`${APP_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code }),
    });
    expect(pollRes2.status).toBe(200);
    const pollData2 = await pollRes2.json();
    expect(pollData2.status).toBe("consumed");
    expect(pollData2.access_token).toBeUndefined();
  });

  it("expired code returns expired status on poll", async () => {
    // 1. Initiate
    const res = await fetch(`${APP_URL}/api/auth/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_name: "expiry-test" }),
    });
    expect(res.status).toBe(201);
    const { device_code } = await res.json();
    cleanupDeviceCodes.push(device_code);

    // 2. Set expires_at to past
    const { error } = await admin
      .from("device_codes")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("device_code", device_code);
    expect(error).toBeNull();

    // 3. Poll → expired
    const pollRes = await fetch(`${APP_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code }),
    });
    expect(pollRes.status).toBe(200);
    const pollData = await pollRes.json();
    expect(pollData.status).toBe("expired");
  });

  it("poll with unknown device_code returns 404", async () => {
    const res = await fetch(`${APP_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: "nonexistent-device-code-xyz" }),
    });
    expect(res.status).toBe(404);
  });

  it("unauthenticated approve returns 401", async () => {
    // 1. Create a valid device code
    const initRes = await fetch(`${APP_URL}/api/auth/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_name: "auth-test" }),
    });
    expect(initRes.status).toBe(201);
    const { device_code, user_code } = await initRes.json();
    cleanupDeviceCodes.push(device_code);

    // 2. Try to approve without authentication
    const approveRes = await fetch(`${APP_URL}/api/auth/device/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code }),
    });
    expect(approveRes.status).toBe(401);
    const body = await approveRes.json();
    expect(body.error).toBe("Unauthorized");
  });
});
