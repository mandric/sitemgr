/**
 * GET  /api/events — Query/search events
 * POST /api/events — Insert a new event
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import { queryEvents, insertEvent } from "@/lib/media/db";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const params = request.nextUrl.searchParams;

  const { data, count, error } = await queryEvents(auth.supabase, {
    userId: auth.user.id,
    search: params.get("search") ?? undefined,
    type: params.get("type") ?? undefined,
    since: params.get("since") ?? undefined,
    until: params.get("until") ?? undefined,
    device: params.get("device") ?? undefined,
    limit: params.has("limit") ? parseInt(params.get("limit")!, 10) : undefined,
    offset: params.has("offset") ? parseInt(params.get("offset")!, 10) : undefined,
  });

  if (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }

  return NextResponse.json({ data, count });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { data, error } = await insertEvent(auth.supabase, {
    ...body,
    user_id: auth.user.id,
  });

  if (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }

  return NextResponse.json({ data }, { status: 201 });
}
