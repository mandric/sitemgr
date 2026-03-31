/**
 * GET /api/events/[id] — Show a single event with enrichments
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import { showEvent } from "@/lib/media/db";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const { data, error } = await showEvent(auth.supabase, id, auth.user.id);

  if (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ data });
}
