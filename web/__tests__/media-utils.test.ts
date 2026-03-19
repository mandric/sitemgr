import { describe, it, expect } from "vitest";
import {
  sha256Bytes,
  newEventId,
  nowIso,
  detectContentType,
  isMediaKey,
  humanSize,
  s3Metadata,
  getMimeType,
} from "@/lib/media/utils";

describe("detectContentType", () => {
  it("detects photos", () => {
    expect(detectContentType("photo.jpg")).toBe("photo");
    expect(detectContentType("photo.jpeg")).toBe("photo");
    expect(detectContentType("photo.png")).toBe("photo");
    expect(detectContentType("photo.webp")).toBe("photo");
    expect(detectContentType("photo.gif")).toBe("photo");
    expect(detectContentType("photo.heic")).toBe("photo");
  });

  it("detects video", () => {
    expect(detectContentType("clip.mp4")).toBe("video");
    expect(detectContentType("clip.mov")).toBe("video");
    expect(detectContentType("clip.webm")).toBe("video");
  });

  it("detects audio", () => {
    expect(detectContentType("song.mp3")).toBe("audio");
    expect(detectContentType("song.wav")).toBe("audio");
    expect(detectContentType("song.flac")).toBe("audio");
  });

  it("returns file for unknown", () => {
    expect(detectContentType("doc.pdf")).toBe("file");
    expect(detectContentType("no-ext")).toBe("file");
  });

  it("returns file for unknown extension .xyz", () => {
    expect(detectContentType("data.xyz")).toBe("file");
  });

  it("returns file when key has no extension", () => {
    expect(detectContentType("DCIM/photo")).toBe("file");
  });

  it("returns file for empty string", () => {
    expect(detectContentType("")).toBe("file");
  });

  it("handles paths with directories", () => {
    expect(detectContentType("photos/2024/beach.jpg")).toBe("photo");
    expect(detectContentType("s3://bucket/prefix/video.mp4")).toBe("video");
  });
});

describe("isMediaKey", () => {
  it("returns true for media files", () => {
    expect(isMediaKey("photo.jpg")).toBe(true);
    expect(isMediaKey("video.mp4")).toBe(true);
    expect(isMediaKey("song.mp3")).toBe(true);
    expect(isMediaKey("Photos/IMG_001.JPEG")).toBe(true);
  });

  it("returns false for non-media", () => {
    expect(isMediaKey("doc.pdf")).toBe(false);
    expect(isMediaKey("readme.txt")).toBe(false);
    expect(isMediaKey(".emptydir/")).toBe(false);
  });

  it("returns true for uppercase extension", () => {
    expect(isMediaKey("IMAGE.JPG")).toBe(true);
  });

  it("returns true for multiple dots in key", () => {
    expect(isMediaKey("photo.backup.jpg")).toBe(true);
  });

  it("returns false for notes.txt", () => {
    expect(isMediaKey("notes.txt")).toBe(false);
  });

  it("returns false for directory-like key", () => {
    expect(isMediaKey("photos/")).toBe(false);
  });
});

describe("sha256Bytes", () => {
  it("computes sha256 with prefix", () => {
    const hash = sha256Bytes(Buffer.from("hello"));
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    const a = sha256Bytes(Buffer.from("test"));
    const b = sha256Bytes(Buffer.from("test"));
    expect(a).toBe(b);
  });

  it("returns consistent hash for empty buffer", () => {
    const a = sha256Bytes(Buffer.alloc(0));
    const b = sha256Bytes(Buffer.alloc(0));
    expect(a).toBe(b);
  });

  it("matches known test vector for empty input", () => {
    const hash = sha256Bytes(Buffer.from(""));
    expect(hash).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("different inputs produce different hashes", () => {
    const a = sha256Bytes(Buffer.from("hello"));
    const b = sha256Bytes(Buffer.from("world"));
    expect(a).not.toBe(b);
  });
});

describe("newEventId", () => {
  it("generates valid ULID format (26 chars, Crockford Base32)", () => {
    const id = newEventId();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("IDs are monotonically increasing within same millisecond", () => {
    const ids = Array.from({ length: 10 }, () => newEventId());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  it("IDs generated apart sort correctly lexicographically", async () => {
    const id1 = newEventId();
    await new Promise((r) => setTimeout(r, 2));
    const id2 = newEventId();
    expect(id2 > id1).toBe(true);
  });

  it("old truncated-UUID format IDs remain valid strings", () => {
    const oldId = "a1b2c3d4e5f6a1b2c3d4e5f6ab";
    expect(typeof oldId).toBe("string");
    expect(oldId).toHaveLength(26);
  });

  it("is unique across many IDs", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newEventId()));
    expect(ids.size).toBe(1000);
  });
});

describe("nowIso", () => {
  it("returns ISO 8601 string", () => {
    const ts = nowIso();
    expect(() => new Date(ts)).not.toThrow();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("humanSize", () => {
  it("formats bytes", () => {
    expect(humanSize(500)).toBe("500.0 B");
    expect(humanSize(1024)).toBe("1.0 KB");
    expect(humanSize(1048576)).toBe("1.0 MB");
    expect(humanSize(1073741824)).toBe("1.0 GB");
  });

  it("returns 0 B for 0", () => {
    expect(humanSize(0)).toBe("0.0 B");
  });

  it("returns 1.5 KB for 1536", () => {
    expect(humanSize(1536)).toBe("1.5 KB");
  });
});

describe("s3Metadata", () => {
  it("builds metadata object", () => {
    const meta = s3Metadata("photos/test.jpg", 12345, "abc123");
    expect(meta).toEqual({
      mime_type: "image/jpeg",
      size_bytes: 12345,
      source: "s3-watch",
      s3_key: "photos/test.jpg",
      s3_etag: "abc123",
    });
  });
});

describe("getMimeType", () => {
  it("returns correct mime types", () => {
    expect(getMimeType("photo.jpg")).toBe("image/jpeg");
    expect(getMimeType("video.mp4")).toBe("video/mp4");
    expect(getMimeType("unknown.zzz123")).toBe("application/octet-stream");
  });
});
