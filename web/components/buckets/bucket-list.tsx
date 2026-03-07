"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { deleteBucket } from "./actions";

type Bucket = {
  id: string;
  bucket_name: string;
  endpoint_url: string;
  region: string | null;
  access_key_id: string;
  created_at: string;
  last_synced_key: string | null;
};

export function BucketList({ buckets }: { buckets: Bucket[] }) {
  const [deleting, setDeleting] = useState<string | null>(null);

  if (buckets.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-center text-muted-foreground">
            No buckets configured yet. Add your first bucket above.
          </p>
        </CardContent>
      </Card>
    );
  }

  const handleDelete = async (bucketId: string, bucketName: string) => {
    if (!confirm(`Are you sure you want to remove "${bucketName}"?`)) {
      return;
    }

    setDeleting(bucketId);
    try {
      await deleteBucket(bucketId);
    } catch (error) {
      console.error("Failed to delete bucket:", error);
      alert("Failed to delete bucket");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="grid gap-4">
      {buckets.map((bucket) => (
        <Card key={bucket.id}>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle>{bucket.bucket_name}</CardTitle>
                <CardDescription className="mt-1">{bucket.endpoint_url}</CardDescription>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => handleDelete(bucket.id, bucket.bucket_name)}
                disabled={deleting === bucket.id}
              >
                {deleting === bucket.id ? "Removing..." : "Remove"}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">Region:</dt>
              <dd>{bucket.region || "N/A"}</dd>

              <dt className="text-muted-foreground">Access Key:</dt>
              <dd className="font-mono text-xs">{bucket.access_key_id}</dd>

              <dt className="text-muted-foreground">Created:</dt>
              <dd>{new Date(bucket.created_at).toLocaleDateString()}</dd>

              {bucket.last_synced_key && (
                <>
                  <dt className="text-muted-foreground">Last Synced:</dt>
                  <dd className="font-mono text-xs truncate">{bucket.last_synced_key}</dd>
                </>
              )}
            </dl>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
