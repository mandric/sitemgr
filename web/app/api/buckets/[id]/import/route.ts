/**
 * POST /api/buckets/[id]/import — Create s3:put events for untracked S3
 * objects so that enrich --pending can process pre-existing bucket content.
 *
 * Import composes on top of scan: it reuses scanBucket's untracked classifier
 * and writes an event for each entry. Modified objects are left alone; those
 * need sync (or a future --update flag) to resolve. Idempotent: re-running
 * after a successful import writes nothing because the same objects now
 * classify as synced.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import {
  getBucketConfig,
  createS3ClientFromConfig,
  importBucket,
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
    const importResult = await importBucket(
      auth.supabase,
      s3,
      result.config!,
      auth.user.id,
      {
        prefix: body.prefix,
        dry_run: body.dry_run,
        batch_size: body.batch_size,
        concurrency: body.concurrency,
      },
    );

    return NextResponse.json({ data: importResult });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
