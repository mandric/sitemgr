/**
 * Media image proxy — streams S3 objects to the browser.
 * GET /api/media/[id] — returns the image/video bytes with correct content-type.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createS3Client, downloadS3Object } from "@/lib/media/s3";
import {
  decryptSecretVersioned,
} from "@/lib/crypto/encryption-versioned";
import { getMimeType } from "@/lib/media/utils";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: eventId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch the event
  const { data: event, error } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !event) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Extract S3 key from metadata or remote_path
  const meta = (event.metadata as Record<string, unknown>) ?? {};
  const s3Key = (meta.s3_key as string) ?? null;
  const remotePath = event.remote_path as string | null;
  const bucketConfigId = event.bucket_config_id as string | null;

  if (!s3Key && !remotePath) {
    return NextResponse.json({ error: "No media path" }, { status: 404 });
  }

  // Get bucket config for S3 credentials
  if (!bucketConfigId) {
    return NextResponse.json(
      { error: "No bucket config" },
      { status: 404 },
    );
  }

  const { data: bucketConfig } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("id", bucketConfigId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!bucketConfig) {
    return NextResponse.json(
      { error: "Bucket config not found" },
      { status: 404 },
    );
  }

  try {
    const decryptedSecret = await decryptSecretVersioned(
      bucketConfig.secret_access_key,
    );

    const s3 = createS3Client({
      endpoint: bucketConfig.endpoint_url,
      region: bucketConfig.region ?? undefined,
      accessKeyId: bucketConfig.access_key_id,
      secretAccessKey: decryptedSecret,
    });

    // Determine key and bucket name
    const key =
      s3Key ??
      remotePath!.replace(`s3://${bucketConfig.bucket_name}/`, "");
    const imageBytes = await downloadS3Object(
      s3,
      bucketConfig.bucket_name,
      key,
    );

    const mimeType = getMimeType(key);

    return new NextResponse(imageBytes, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "private, max-age=3600",
        "Content-Length": String(imageBytes.length),
      },
    });
  } catch (err) {
    console.error(`[media-proxy] Failed to fetch ${eventId}:`, err);
    return NextResponse.json(
      { error: "Failed to fetch media" },
      { status: 500 },
    );
  }
}
