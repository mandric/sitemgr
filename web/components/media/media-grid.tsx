"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { MediaEvent } from "./actions";

function MediaCard({ event }: { event: MediaEvent }) {
  const meta = event.metadata ?? {};
  const s3Key = (meta.s3_key as string) ?? "";
  const fileName = s3Key.split("/").pop() ?? event.id;
  const isPhoto = event.content_type === "photo";

  return (
    <Link
      href={`/media/${event.id}`}
      className="group block rounded-lg border bg-card overflow-hidden hover:ring-2 hover:ring-primary/50 transition-all"
    >
      <div className="aspect-square relative bg-muted">
        {isPhoto && event.bucket_config_id ? (
          <img
            src={`/api/media/${event.id}`}
            alt={event.enrichment?.description ?? fileName}
            className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-200"
            loading="lazy"
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {event.content_type ?? "file"}
          </div>
        )}
      </div>
      <div className="p-3 space-y-1.5">
        <p className="text-sm font-medium truncate" title={fileName}>
          {fileName}
        </p>
        {event.enrichment?.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {event.enrichment.description}
          </p>
        )}
        <div className="flex flex-wrap gap-1">
          {event.enrichment?.tags?.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="secondary" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
      </div>
    </Link>
  );
}

export function MediaGrid({ events }: { events: MediaEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <p className="text-lg">No media found</p>
        <p className="text-sm mt-1">
          Index some S3 buckets to see your media here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {events.map((event) => (
        <MediaCard key={event.id} event={event} />
      ))}
    </div>
  );
}
