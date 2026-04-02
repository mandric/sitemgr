/**
 * GET /api/dedup — Find duplicate files within a bucket
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import { findDuplicateGroups } from "@/lib/media/db";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const params = request.nextUrl.searchParams;
  const bucketConfigId = params.get("bucket_config_id");
  if (!bucketConfigId) {
    return NextResponse.json(
      { error: "bucket_config_id query parameter is required" },
      { status: 400 },
    );
  }

  const limit = params.has("limit") ? parseInt(params.get("limit")!, 10) : 100;
  const offset = params.has("offset") ? parseInt(params.get("offset")!, 10) : 0;

  const { data, error } = await findDuplicateGroups(
    auth.supabase,
    auth.user.id,
    bucketConfigId,
    limit,
    offset,
  );

  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }

  const groups = data ?? [];
  return NextResponse.json({
    data: {
      groups,
      total_duplicate_groups: groups.length,
    },
  });
}
