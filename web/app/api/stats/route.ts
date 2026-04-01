/**
 * GET /api/stats — Aggregate event and enrichment statistics
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import { getStats } from "@/lib/media/db";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const params = request.nextUrl.searchParams;
  const { data, error } = await getStats(auth.supabase, {
    userId: auth.user.id,
    bucketConfigId: params.get("bucket_config_id") ?? undefined,
  });

  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }

  return NextResponse.json({ data });
}
