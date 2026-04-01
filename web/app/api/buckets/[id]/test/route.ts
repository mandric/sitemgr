/**
 * POST /api/buckets/[id]/test — Test S3 connectivity for a bucket
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import {
  getBucketConfig,
  createS3ClientFromConfig,
  testBucketConnectivity,
} from "@/lib/media/bucket-service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const result = await getBucketConfig(auth.supabase, auth.user.id, id);

  if (!result.exists) {
    return NextResponse.json({ error: "Bucket not found" }, { status: 404 });
  }
  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  const s3 = createS3ClientFromConfig(result.config!);
  const connectivity = await testBucketConnectivity(s3, result.config!.bucket_name);

  return NextResponse.json({ data: connectivity });
}
