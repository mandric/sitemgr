import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/media/db";

export async function POST(request: Request) {
  let body: { device_code?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "device_code is required" },
      { status: 400 },
    );
  }

  const { device_code } = body;
  if (!device_code || typeof device_code !== "string") {
    return NextResponse.json(
      { error: "device_code is required" },
      { status: 400 },
    );
  }

  const supabase = getUserClient({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  });

  const { data, error } = await supabase.rpc("get_device_code_status", {
    p_device_code: device_code,
  });

  if (error) {
    console.error("[device-token] RPC error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }

  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "Device code not found" },
      { status: 404 },
    );
  }

  const row = data[0];

  // Check if pending but expired
  if (row.status === "pending" && new Date(row.expires_at) < new Date()) {
    await supabase.rpc("expire_device_code", { p_device_code: device_code });
    // Best-effort polled_at update
    supabase.rpc("update_device_code_polled_at", { p_device_code: device_code });
    return NextResponse.json({ status: "expired" });
  }

  // Approved: return token_hash + email, then consume
  if (row.status === "approved" && row.token_hash) {
    const { token_hash, email } = row;
    await supabase.rpc("consume_device_code", { p_device_code: device_code });
    return NextResponse.json({ status: "approved", token_hash, email });
  }

  // Best-effort polled_at update
  supabase.rpc("update_device_code_polled_at", { p_device_code: device_code });

  // All other statuses: pending, consumed, expired, denied
  return NextResponse.json({ status: row.status });
}
