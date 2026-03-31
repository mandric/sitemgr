/**
 * POST /api/auth/refresh — Refresh an expired access token.
 *
 * Accepts { refresh_token } in the body, returns a new session.
 * The CLI calls this instead of talking to Supabase Auth directly.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const refreshToken = body?.refresh_token;

  if (!refreshToken || typeof refreshToken !== "string") {
    return NextResponse.json(
      { error: "refresh_token is required" },
      { status: 400 },
    );
  }

  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.replace(/\s+/g, ""),
  );

  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: refreshToken,
  });

  if (error || !data.session) {
    return NextResponse.json(
      { error: error?.message ?? "Refresh failed" },
      { status: 401 },
    );
  }

  return NextResponse.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user_id: data.session.user.id,
    email: data.session.user.email,
    expires_at: data.session.expires_at ?? 0,
  });
}
