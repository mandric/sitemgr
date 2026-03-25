import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

// EXCEPTION: This endpoint uses SUPABASE_SERVICE_ROLE_KEY for admin.generateLink().
// See CLAUDE.md — this is the only runtime usage of the service role key.

export async function POST(request: Request) {
  // 1. Authenticate the user via cookie-based session
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Parse request body
  let body: { user_code?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "user_code is required" },
      { status: 400 },
    );
  }

  const { user_code } = body;
  if (!user_code || typeof user_code !== "string") {
    return NextResponse.json(
      { error: "user_code is required" },
      { status: 400 },
    );
  }

  // 3. Create admin client for DB operations and generateLink
  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // 4. Look up the pending device code
  const { data: row, error: lookupError } = await adminClient
    .from("device_codes")
    .select("id, user_code")
    .eq("user_code", user_code)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .single();

  if (lookupError || !row) {
    return NextResponse.json(
      { error: "Code not found or expired" },
      { status: 404 },
    );
  }

  // 5. Generate magic link token
  const { data: linkData, error: linkError } =
    await adminClient.auth.admin.generateLink({
      type: "magiclink",
      email: user.email!,
    });

  if (linkError || !linkData?.properties?.hashed_token) {
    console.error("[device-approve] generateLink error:", linkError);
    return NextResponse.json(
      { error: "Failed to generate auth link" },
      { status: 500 },
    );
  }

  // 6. Update the device code row
  const { error: updateError } = await adminClient
    .from("device_codes")
    .update({
      status: "approved",
      user_id: user.id,
      email: user.email,
      token_hash: linkData.properties.hashed_token,
      approved_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (updateError) {
    console.error("[device-approve] update error:", updateError);
    return NextResponse.json(
      { error: "Failed to approve device code" },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
