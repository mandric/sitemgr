"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  encryptSecretVersioned,
  getEncryptionVersion,
} from "@/lib/crypto/encryption-versioned";

export async function addBucket(formData: FormData) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { data: null, error: { message: "Not authenticated" } };
  }

  const bucketName = formData.get("bucket_name") as string;
  const endpointUrl = formData.get("endpoint_url") as string;
  const region = (formData.get("region") as string) || null;
  const accessKeyId = formData.get("access_key_id") as string;
  const secretAccessKey = formData.get("secret_access_key") as string;

  if (!bucketName || !endpointUrl || !accessKeyId || !secretAccessKey) {
    return { data: null, error: { message: "Missing required fields" } };
  }

  try {
    // Encrypt the secret access key with versioning
    const encryptedSecret = await encryptSecretVersioned(secretAccessKey);
    const keyVersion = getEncryptionVersion(encryptedSecret);

    // Insert into database
    const { data, error } = await supabase.from("bucket_configs").insert({
      user_id: user.id,
      bucket_name: bucketName,
      endpoint_url: endpointUrl,
      region,
      access_key_id: accessKeyId,
      secret_access_key: encryptedSecret,
      encryption_key_version: keyVersion,
    }).select().single();

    if (error) {
      return { data: null, error };
    }

    revalidatePath("/buckets");
    return { data, error: null };
  } catch (err) {
    console.error("addBucket exception:", err);
    return {
      data: null,
      error: { message: `Failed to add bucket: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
}

export async function deleteBucket(bucketId: string) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { data: null, error: { message: "Not authenticated" } };
  }

  const { error } = await supabase
    .from("bucket_configs")
    .delete()
    .eq("id", bucketId)
    .eq("user_id", user.id);

  if (error) {
    return { data: null, error };
  }

  revalidatePath("/buckets");
  return { data: null, error: null };
}
