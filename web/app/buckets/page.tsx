import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BucketList } from "@/components/buckets/bucket-list";
import { AddBucketForm } from "@/components/buckets/add-bucket-form";

async function BucketContent() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirect("/auth/login");
  }

  // Fetch user's buckets
  const { data: buckets } = await supabase
    .from("bucket_configs")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <>
      <AddBucketForm userId={user.id} />

      <div>
        <h2 className="text-2xl font-semibold mb-4">Your Buckets</h2>
        <BucketList buckets={buckets || []} />
      </div>
    </>
  );
}

function BucketLoading() {
  return (
    <div className="flex flex-col gap-8">
      <div className="h-96 rounded-lg border bg-card animate-pulse" />
      <div className="h-48 rounded-lg border bg-card animate-pulse" />
    </div>
  );
}

export default function BucketsPage() {
  return (
    <div className="flex flex-col gap-8 max-w-4xl mx-auto py-8 px-4">
      <div>
        <h1 className="text-3xl font-bold mb-2">S3 Bucket Configuration</h1>
        <p className="text-muted-foreground">
          Configure your S3-compatible storage buckets for media management.
        </p>
      </div>

      <Suspense fallback={<BucketLoading />}>
        <BucketContent />
      </Suspense>
    </div>
  );
}
