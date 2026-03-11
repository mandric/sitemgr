"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { encryptSecret } from "@/lib/crypto/encryption";
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
    return { error: "Not authenticated" };
  }

  const bucketName = formData.get("bucket_name") as string;
  const endpointUrl = formData.get("endpoint_url") as string;
  const region = (formData.get("region") as string) || null;
  const accessKeyId = formData.get("access_key_id") as string;
  const secretAccessKey = formData.get("secret_access_key") as string;

  if (!bucketName || !endpointUrl || !accessKeyId || !secretAccessKey) {
    return { error: "Missing required fields" };
  }

  try {
    // Encrypt the secret access key with versioning
    const encryptedSecret = await encryptSecretVersioned(secretAccessKey);
    const keyVersion = getEncryptionVersion(encryptedSecret);

    // Insert into database
    const { error } = await supabase.from("bucket_configs").insert({
      user_id: user.id,
      bucket_name: bucketName,
      endpoint_url: endpointUrl,
      region,
      access_key_id: accessKeyId,
      secret_access_key: encryptedSecret,
      encryption_key_version: keyVersion,
    });

    if (error) {
      console.error("Database error:", error);

      if (error.code === "23505") {
        return { error: "A bucket with this name already exists" };
      }

      return { error: "Failed to save bucket configuration" };
    }

    revalidatePath("/buckets");
    return { success: true };
  } catch (error) {
    console.error("Failed to add bucket:", error);
    return { error: "Failed to add bucket" };
  }
}

export async function deleteBucket(bucketId: string) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Not authenticated");
  }

  const { error } = await supabase
    .from("bucket_configs")
    .delete()
    .eq("id", bucketId)
    .eq("user_id", user.id);

  if (error) {
    console.error("Failed to delete bucket:", error);
    throw new Error("Failed to delete bucket");
  }

  revalidatePath("/buckets");
}
