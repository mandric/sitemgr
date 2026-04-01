/**
 * GET  /api/buckets — List user's bucket configs (no secrets in response)
 * POST /api/buckets — Add a new bucket config
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import {
  encryptSecretVersioned,
  getEncryptionVersion,
} from "@/lib/crypto/encryption-versioned";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const { data, error } = await auth.supabase
    .from("bucket_configs")
    .select("id, bucket_name, region, endpoint_url, created_at, last_synced_key")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }

  return NextResponse.json({ data: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { bucket_name, endpoint_url, region, access_key_id, secret_access_key } = body;

  if (!bucket_name || !endpoint_url || !access_key_id || !secret_access_key) {
    return NextResponse.json(
      { error: "Missing required fields: bucket_name, endpoint_url, access_key_id, secret_access_key" },
      { status: 400 },
    );
  }

  const encryptedSecret = await encryptSecretVersioned(secret_access_key);
  const keyVersion = getEncryptionVersion(encryptedSecret);

  const { data, error } = await auth.supabase
    .from("bucket_configs")
    .insert({
      user_id: auth.user.id,
      bucket_name,
      region: region ?? null,
      endpoint_url,
      access_key_id,
      secret_access_key: encryptedSecret,
      encryption_key_version: keyVersion,
    })
    .select("id, bucket_name, region, endpoint_url, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "Bucket already configured" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error }, { status: 500 });
  }

  return NextResponse.json({ data }, { status: 201 });
}
