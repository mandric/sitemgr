/**
 * GET  /api/watched-keys — List watched S3 keys
 * POST /api/watched-keys — Upsert a watched S3 key
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import { getWatchedKeys, upsertWatchedKey } from "@/lib/media/db";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const { data, error } = await getWatchedKeys(auth.supabase, auth.user.id);

  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }

  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const body = await request.json().catch(() => null);
  if (!body?.s3_key) {
    return NextResponse.json(
      { error: "s3_key is required" },
      { status: 400 },
    );
  }

  const { data, error } = await upsertWatchedKey(
    auth.supabase,
    body.s3_key,
    body.event_id ?? null,
    body.etag ?? "",
    body.size_bytes ?? 0,
    auth.user.id,
  );

  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }

  return NextResponse.json({ data }, { status: 201 });
}
