/**
 * GET /api/buckets/[id]/objects — List objects in the S3 bucket.
 *
 * Returns the raw S3 listing (key, etag, size, lastModified) that the
 * `sitemgr sync` CLI uses to diff local files against S3. S3 is the source
 * of truth for remote state; sync does not read the events table.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import {
  getBucketConfig,
  createS3ClientFromConfig,
} from "@/lib/media/bucket-service";
import { listS3Objects } from "@/lib/media/s3";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const prefix = request.nextUrl.searchParams.get("prefix") ?? "";

  const result = await getBucketConfig(auth.supabase, auth.user.id, id);
  if (!result.exists) {
    return NextResponse.json({ error: "Bucket not found" }, { status: 404 });
  }
  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  const config = result.config!;
  const s3 = createS3ClientFromConfig(config);

  try {
    const objects = await listS3Objects(s3, config.bucket_name, prefix);
    return NextResponse.json({ data: objects });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
