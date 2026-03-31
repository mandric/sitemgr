/**
 * Bearer token authentication for API routes.
 *
 * CLI sends `Authorization: Bearer <access_token>` — this helper creates
 * a Supabase client authenticated with that JWT so RLS policies apply.
 */

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export interface AuthenticatedContext {
  supabase: SupabaseClient;
  user: { id: string; email?: string };
}

/**
 * Authenticate an API request via Bearer token.
 * Returns the authenticated context or a NextResponse error.
 */
export async function authenticateRequest(
  request: NextRequest,
): Promise<AuthenticatedContext | NextResponse> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Missing or invalid Authorization header" },
      { status: 401 },
    );
  }

  const accessToken = authHeader.slice(7);

  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.replace(/\s+/g, ""),
    {
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    },
  );

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(accessToken);

  if (error || !user) {
    return NextResponse.json(
      { error: "Invalid or expired token" },
      { status: 401 },
    );
  }

  return { supabase, user: { id: user.id, email: user.email } };
}

/**
 * Type guard: checks if the result is an authenticated context (not an error response).
 */
export function isAuthenticated(
  result: AuthenticatedContext | NextResponse,
): result is AuthenticatedContext {
  return "supabase" in result;
}
