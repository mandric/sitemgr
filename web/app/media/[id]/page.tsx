import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getMediaEvent } from "@/components/media/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

async function MediaDetailContent({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: eventId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/auth/login");

  const event = await getMediaEvent(eventId);
  if (!event) return notFound();

  const meta = (event.metadata ?? {}) as Record<string, unknown>;
  const s3Key = (meta.s3_key as string) ?? "";
  const fileName = s3Key.split("/").pop() ?? event.id;
  const sizeBytes = meta.size_bytes as number | undefined;
  const mimeType = meta.mime_type as string | undefined;
  const isPhoto = event.content_type === "photo";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Media preview */}
      <div className="lg:col-span-2">
        <div className="rounded-lg border bg-card overflow-hidden">
          {isPhoto && event.bucket_config_id ? (
            <img
              src={`/api/media/${event.id}`}
              alt={event.enrichment?.description ?? fileName}
              className="w-full h-auto"
            />
          ) : (
            <div className="flex items-center justify-center h-64 text-muted-foreground">
              {event.content_type ?? "file"} — preview not available
            </div>
          )}
        </div>
      </div>

      {/* Metadata sidebar */}
      <div className="space-y-4">
        {/* Enrichment data */}
        {event.enrichment && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">AI Description</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm">{event.enrichment.description}</p>

              {event.enrichment.context && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Context
                  </p>
                  <p className="text-sm">{event.enrichment.context}</p>
                </div>
              )}

              {event.enrichment.objects?.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Objects
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {event.enrichment.objects.map((obj) => (
                      <Badge key={obj} variant="outline">
                        {obj}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {event.enrichment.tags?.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Tags
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {event.enrichment.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* File info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">File Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground">File Name</dt>
                <dd className="font-mono text-xs break-all">{fileName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Type</dt>
                <dd>{event.content_type ?? "unknown"}</dd>
              </div>
              {mimeType && (
                <div>
                  <dt className="text-muted-foreground">MIME Type</dt>
                  <dd className="font-mono text-xs">{mimeType}</dd>
                </div>
              )}
              {sizeBytes && (
                <div>
                  <dt className="text-muted-foreground">Size</dt>
                  <dd>{formatSize(sizeBytes)}</dd>
                </div>
              )}
              <div>
                <dt className="text-muted-foreground">Indexed</dt>
                <dd>{new Date(event.timestamp).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Device</dt>
                <dd className="font-mono text-xs">{event.device_id}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Event ID</dt>
                <dd className="font-mono text-xs break-all">{event.id}</dd>
              </div>
              {event.content_hash && (
                <div>
                  <dt className="text-muted-foreground">Content Hash</dt>
                  <dd className="font-mono text-xs break-all">
                    {event.content_hash}
                  </dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (Math.abs(bytes) < 1024) return `${bytes.toFixed(1)} ${unit}`;
    bytes /= 1024;
  }
  return `${bytes.toFixed(1)} TB`;
}

function DetailLoading() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2">
        <div className="aspect-video rounded-lg border bg-card animate-pulse" />
      </div>
      <div className="space-y-4">
        <div className="h-64 rounded-lg border bg-card animate-pulse" />
        <div className="h-48 rounded-lg border bg-card animate-pulse" />
      </div>
    </div>
  );
}

export default function MediaDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto py-8 px-4">
      <div className="flex items-center gap-4">
        <Link href="/media">
          <Button variant="outline" size="sm">
            Back to Gallery
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">Media Detail</h1>
      </div>

      <Suspense fallback={<DetailLoading />}>
        <MediaDetailContent params={params} />
      </Suspense>
    </div>
  );
}
