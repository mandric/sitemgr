/**
 * POST /api/buckets/[id]/scan — Scan bucket for new objects, create events
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import {
  getBucketConfig,
  createS3ClientFromConfig,
  scanBucket,
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
    const scanResult = await scanBucket(auth.supabase, s3, result.config!, auth.user.id, {
      prefix: body.prefix,
      batch_size: body.batch_size,
      auto_enrich: body.auto_enrich,
      device_id: body.device_id ?? "api",
    });

    return NextResponse.json({ data: scanResult });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
