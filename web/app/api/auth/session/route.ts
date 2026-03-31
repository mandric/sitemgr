/**
 * GET /api/auth/session — Validate a Bearer token and return user info.
 *
 * The CLI calls this to verify its stored access token is still valid.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";

export async function GET(request: NextRequest) {
  const result = await authenticateRequest(request);
  if (!isAuthenticated(result)) return result;

  return NextResponse.json({
    user_id: result.user.id,
    email: result.user.email,
  });
}
