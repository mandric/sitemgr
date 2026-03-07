"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addBucket } from "./actions";

export function AddBucketForm({ userId }: { userId: string }) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    const form = e.currentTarget;
    const formData = new FormData(form);

    try {
      const result = await addBucket(formData);

      if (result.error) {
        setError(result.error);
      } else {
        // Reset form on success
        form.reset();
      }
    } catch (err) {
      setError("Failed to add bucket");
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add New Bucket</CardTitle>
        <CardDescription>
          Configure an S3-compatible storage bucket for your media files.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input type="hidden" name="userId" value={userId} />

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="bucket_name">Bucket Name *</Label>
              <Input
                id="bucket_name"
                name="bucket_name"
                placeholder="my-media-bucket"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="region">Region</Label>
              <Input
                id="region"
                name="region"
                placeholder="us-east-1 (optional)"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="endpoint_url">Endpoint URL *</Label>
            <Input
              id="endpoint_url"
              name="endpoint_url"
              type="url"
              placeholder="https://s3.us-east-1.amazonaws.com"
              required
            />
            <p className="text-xs text-muted-foreground">
              Examples: AWS S3, Backblaze B2, Cloudflare R2, MinIO
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="access_key_id">Access Key ID *</Label>
              <Input
                id="access_key_id"
                name="access_key_id"
                placeholder="AKIAIOSFODNN7EXAMPLE"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="secret_access_key">Secret Access Key *</Label>
              <Input
                id="secret_access_key"
                name="secret_access_key"
                type="password"
                placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                required
              />
            </div>
          </div>

          {error && (
            <div className="text-sm text-red-500 bg-red-50 p-3 rounded">
              {error}
            </div>
          )}

          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Adding Bucket..." : "Add Bucket"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
