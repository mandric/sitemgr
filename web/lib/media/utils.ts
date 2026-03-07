/**
 * Pure utility functions for media handling
 */

import { createHash, randomUUID } from "crypto";
import { lookup } from "mime-types";
import { CONTENT_TYPE_MAP, MEDIA_EXTENSIONS } from "./constants";

export function sha256Bytes(data: Buffer): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export function newEventId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 26);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function detectContentType(pathOrKey: string): string {
  const mime = lookup(pathOrKey);
  if (mime) {
    const major = mime.split("/")[0];
    return CONTENT_TYPE_MAP[major] ?? "file";
  }
  return "file";
}

export function isMediaKey(key: string): boolean {
  const ext = key.slice(key.lastIndexOf(".")).toLowerCase();
  return MEDIA_EXTENSIONS.has(ext);
}

export function getMimeType(pathOrKey: string): string {
  return lookup(pathOrKey) || "application/octet-stream";
}

export function humanSize(n: number): string {
  for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
    if (Math.abs(n) < 1024) {
      return `${n.toFixed(1)} ${unit}`;
    }
    n /= 1024;
  }
  return `${n.toFixed(1)} PB`;
}

export function s3Metadata(key: string, size: number, etag: string): Record<string, unknown> {
  return {
    mime_type: getMimeType(key),
    size_bytes: size,
    source: "s3-watch",
    s3_key: key,
    s3_etag: etag,
  };
}
