import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { generateDeviceCode, generateUserCode } from "@/lib/auth/device-codes";

const MAX_RETRIES = 3;
const EXPIRY_MINUTES = 10;
const CLEANUP_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export async function POST(request: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );

  let body: { device_name?: string } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine — device_name is optional
  }

  const device_name = body.device_name ?? "unknown";
  const device_code = generateDeviceCode();
  const expires_at = new Date(Date.now() + EXPIRY_MINUTES * 60 * 1000).toISOString();
  const client_ip = request.headers.get("x-forwarded-for") ?? "unknown";

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ??
    request.headers.get("origin") ??
    "http://localhost:3000";

  let user_code = generateUserCode();

  // Insert with retry on user_code collision
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const verification_url = `${siteUrl}/auth/device?code=${user_code}`;

    const { error } = await supabase.from("device_codes").insert({
      device_code,
      user_code,
      status: "pending",
      device_name,
      expires_at,
      client_ip,
    });

    if (!error) {
      // Fire-and-forget cleanup of expired rows
      supabase
        .from("device_codes")
        .delete()
        .lt("expires_at", new Date(Date.now() - CLEANUP_THRESHOLD_MS).toISOString())
        .then(({ error: cleanupErr }) => {
          if (cleanupErr) {
            console.warn("[device-auth] cleanup failed:", cleanupErr.message);
          }
        });

      return NextResponse.json(
        {
          device_code,
          user_code,
          verification_url,
          expires_at,
          interval: 5,
        },
        { status: 201 },
      );
    }

    // Retry on unique_violation (user_code collision)
    if (error.code === "23505") {
      user_code = generateUserCode();
      continue;
    }

    // Non-retryable error
    return NextResponse.json({ error }, { status: 500 });
  }

  return NextResponse.json(
    { error: "Failed to generate unique code" },
    { status: 500 },
  );
}
