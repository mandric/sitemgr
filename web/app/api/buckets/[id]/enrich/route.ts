/**
 * POST /api/buckets/[id]/enrich — Enrich unenriched images in this bucket
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import {
  getBucketConfig,
  createS3ClientFromConfig,
  enrichBucketPending,
} from "@/lib/media/bucket-service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const result = await getBucketConfig(auth.supabase, auth.user.id, id);
  if (!result.exists) {
    return NextResponse.json({ error: "Bucket not found" }, { status: 404 });
  }
  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  const s3 = createS3ClientFromConfig(result.config!);

  try {
    const enrichResult = await enrichBucketPending(
      auth.supabase, s3, result.config!, auth.user.id, {
        event_id: body.event_id,
        concurrency: body.concurrency,
        dry_run: body.dry_run,
      },
    );

    return NextResponse.json({ data: enrichResult });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
