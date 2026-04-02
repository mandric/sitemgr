/**
 * POST /api/buckets/[id]/upload — Upload a file to S3 via the server
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import {
  getBucketConfig,
  createS3ClientFromConfig,
} from "@/lib/media/bucket-service";
import { uploadS3Object } from "@/lib/media/s3";
import { insertEvent, upsertWatchedKey } from "@/lib/media/db";
import {
  newEventId,
  detectContentType,
  getMimeType,
  s3Metadata,
} from "@/lib/media/utils";

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

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const prefix = (formData.get("prefix") as string) ?? "";
  const deviceId = (formData.get("device_id") as string) ?? "api";

  const arrayBuffer = await file.arrayBuffer();
  const fileBuffer = Buffer.from(arrayBuffer);
  const fileName = file.name;
  const s3Key = prefix ? `${prefix}${fileName}` : fileName;
  const contentType = detectContentType(fileName);
  const mimeType = getMimeType(fileName);

  const config = result.config!;
  const s3 = createS3ClientFromConfig(config);

  let etag: string;
  try {
    etag = await uploadS3Object(s3, config.bucket_name, s3Key, fileBuffer, mimeType);
  } catch (err) {
    return NextResponse.json(
      { error: `S3 upload failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  const contentHash = `etag:${etag}`;
  const eventId = newEventId();
  const remotePath = `s3://${config.bucket_name}/${s3Key}`;

  const { error: insertError } = await insertEvent(auth.supabase, {
    id: eventId,
    device_id: deviceId,
    type: "create",
    content_type: contentType,
    content_hash: contentHash,
    local_path: null,
    remote_path: remotePath,
    metadata: {
      ...s3Metadata(s3Key, fileBuffer.length, etag),
      mime_type: mimeType,
      source: "api-upload",
    },
    parent_id: null,
    bucket_config_id: config.id,
    user_id: auth.user.id,
  });

  if (insertError) {
    return NextResponse.json({ error: insertError }, { status: 500 });
  }

  await upsertWatchedKey(
    auth.supabase, s3Key, eventId, etag, fileBuffer.length, auth.user.id, config.id,
  );

  return NextResponse.json(
    { data: { event_id: eventId, s3_key: s3Key, content_type: contentType } },
    { status: 201 },
  );
}
