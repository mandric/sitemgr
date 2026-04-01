/**
 * GET /api/events/by-hash/[hash] — Find an event by content hash
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import { findEventByHash } from "@/lib/media/db";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string }> },
) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const { hash } = await params;
  const { data, error } = await findEventByHash(auth.supabase, hash, auth.user.id);

  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }

  return NextResponse.json({ data });
}
