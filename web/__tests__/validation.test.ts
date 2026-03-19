import { describe, it, expect } from "vitest";
import {
  validateImage,
  validateS3Key,
  validateBucketConfig,
} from "@/lib/media/validation";

function makeJpegBuffer(sizeBytes = 100): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
}

function makePngBuffer(sizeBytes = 100): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  return buf;
}

function makeGifBuffer(sizeBytes = 100): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  buf[0] = 0x47;
  buf[1] = 0x49;
  buf[2] = 0x46;
  buf[3] = 0x38;
  return buf;
}

function makeWebpBuffer(sizeBytes = 100): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  buf[0] = 0x52;
  buf[1] = 0x49;
  buf[2] = 0x46;
  buf[3] = 0x46;
  buf[8] = 0x57;
  buf[9] = 0x45;
  buf[10] = 0x42;
  buf[11] = 0x50;
  return buf;
}

describe("validateImage", () => {
  // === Valid images ===
  it("accepts a valid JPEG buffer", () => {
    const result = validateImage(makeJpegBuffer(), "image/jpeg");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a valid PNG buffer", () => {
    const result = validateImage(makePngBuffer(), "image/png");
    expect(result.valid).toBe(true);
  });

  it("accepts a valid GIF buffer", () => {
    const result = validateImage(makeGifBuffer(), "image/gif");
    expect(result.valid).toBe(true);
  });

  it("accepts a valid WebP buffer", () => {
    const result = validateImage(makeWebpBuffer(), "image/webp");
    expect(result.valid).toBe(true);
  });

  it("warnings is empty for a normal valid image", () => {
    const result = validateImage(makeJpegBuffer(), "image/jpeg");
    expect(result.warnings).toEqual([]);
  });

  // === File size ===
  it("rejects a buffer over 20MB", () => {
    const buf = makeJpegBuffer(20 * 1024 * 1024 + 1);
    const result = validateImage(buf, "image/jpeg");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("20MB");
  });

  it("accepts a buffer of exactly 20MB", () => {
    const buf = makeJpegBuffer(20 * 1024 * 1024);
    const result = validateImage(buf, "image/jpeg");
    expect(result.valid).toBe(true);
  });

  // === MIME type ===
  it("rejects image/tiff", () => {
    const result = validateImage(makeJpegBuffer(), "image/tiff");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("image/tiff");
  });

  it("rejects application/pdf", () => {
    const result = validateImage(makeJpegBuffer(), "application/pdf");
    expect(result.valid).toBe(false);
  });

  it("rejects image/bmp", () => {
    const result = validateImage(makeJpegBuffer(), "image/bmp");
    expect(result.valid).toBe(false);
  });

  it("rejects empty string mimeType", () => {
    const result = validateImage(makeJpegBuffer(), "");
    expect(result.valid).toBe(false);
  });

  it("accepts image/jpg with JPEG magic bytes (normalizes to image/jpeg)", () => {
    const result = validateImage(makeJpegBuffer(), "image/jpg");
    expect(result.valid).toBe(true);
  });

  // === Magic bytes / corrupt files ===
  it("rejects PNG header with image/jpeg mime", () => {
    const result = validateImage(makePngBuffer(), "image/jpeg");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Magic bytes");
  });

  it("rejects JPEG header with image/png mime", () => {
    const result = validateImage(makeJpegBuffer(), "image/png");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Magic bytes");
  });

  it("rejects all-zero buffer with image/jpeg", () => {
    const result = validateImage(Buffer.alloc(100), "image/jpeg");
    expect(result.valid).toBe(false);
  });

  it("rejects empty buffer", () => {
    const result = validateImage(Buffer.alloc(0), "image/jpeg");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("empty");
  });

  it("rejects 2-byte buffer with image/jpeg (needs 3 bytes)", () => {
    const buf = Buffer.from([0xff, 0xd8]);
    const result = validateImage(buf, "image/jpeg");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("too short");
  });

  it("rejects 11-byte buffer with image/webp (needs 12 bytes)", () => {
    const buf = Buffer.alloc(11);
    buf[0] = 0x52;
    buf[1] = 0x49;
    buf[2] = 0x46;
    buf[3] = 0x46;
    const result = validateImage(buf, "image/webp");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("too short");
  });

  // === Multiple errors accumulate ===
  it("oversized buffer with wrong magic bytes produces multiple errors", () => {
    const buf = Buffer.alloc(20 * 1024 * 1024 + 1);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47; // PNG header
    const result = validateImage(buf, "image/jpeg"); // JPEG mime
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("validateS3Key", () => {
  it("accepts photos/2024/image.jpg", () => {
    const result = validateS3Key("photos/2024/image.jpg");
    expect(result.valid).toBe(true);
  });

  it("accepts key with spaces", () => {
    const result = validateS3Key("my photos/holiday 2024.jpg");
    expect(result.valid).toBe(true);
  });

  it("accepts key with unicode", () => {
    const result = validateS3Key("photos/été/plage.jpg");
    expect(result.valid).toBe(true);
  });

  it("accepts key with tilde, parentheses, dashes", () => {
    const result = validateS3Key("photos/img-(1)~final.jpg");
    expect(result.valid).toBe(true);
  });

  it("accepts key that is exactly 1024 bytes", () => {
    const key = "a".repeat(1024);
    const result = validateS3Key(key);
    expect(result.valid).toBe(true);
  });

  it("rejects empty string", () => {
    const result = validateS3Key("");
    expect(result.valid).toBe(false);
  });

  it("rejects key of 1025 bytes", () => {
    const key = "a".repeat(1025);
    const result = validateS3Key(key);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("1024");
  });

  it("rejects key with null byte", () => {
    const result = validateS3Key("photos/\u0000image.jpg");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("null");
  });

  it("rejects key with control character \\u0001", () => {
    const result = validateS3Key("photos/\u0001image.jpg");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("control");
  });

  it("rejects key with control character \\u001f", () => {
    const result = validateS3Key("photos/\u001fimage.jpg");
    expect(result.valid).toBe(false);
  });

  it("key with both null byte and excessive length produces errors for both", () => {
    const key = "\u0000" + "a".repeat(1025);
    const result = validateS3Key(key);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("validateBucketConfig", () => {
  const validConfig = {
    bucket_name: "my-bucket",
    endpoint_url: "https://s3.example.com",
    region: "us-east-1",
    access_key_id: "AKIAIOSFODNN7EXAMPLE",
    secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  it("accepts valid config", () => {
    const result = validateBucketConfig(validConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts config with endpoint_url omitted", () => {
    const { endpoint_url, ...rest } = validConfig;
    const result = validateBucketConfig(rest as any);
    expect(result.valid).toBe(true);
  });

  it("accepts config with region omitted", () => {
    const { region, ...rest } = validConfig;
    const result = validateBucketConfig(rest as any);
    expect(result.valid).toBe(true);
  });

  it("accepts config with both endpoint_url and region omitted", () => {
    const { endpoint_url, region, ...rest } = validConfig;
    const result = validateBucketConfig(rest as any);
    expect(result.valid).toBe(true);
  });

  it("accepts endpoint_url http://localhost:9000", () => {
    const result = validateBucketConfig({
      ...validConfig,
      endpoint_url: "http://localhost:9000",
    });
    expect(result.valid).toBe(true);
  });

  // === Required field failures ===
  it("rejects empty bucket_name", () => {
    const result = validateBucketConfig({
      ...validConfig,
      bucket_name: "",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("bucket_name");
  });

  it("rejects empty access_key_id", () => {
    const result = validateBucketConfig({
      ...validConfig,
      access_key_id: "",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("access_key_id");
  });

  it("rejects empty secret_access_key", () => {
    const result = validateBucketConfig({
      ...validConfig,
      secret_access_key: "",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("secret_access_key");
  });

  // === Optional field format checks ===
  it("rejects endpoint_url 'not-a-url'", () => {
    const result = validateBucketConfig({
      ...validConfig,
      endpoint_url: "not-a-url",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("endpoint_url");
  });

  it("rejects endpoint_url ftp://example.com", () => {
    const result = validateBucketConfig({
      ...validConfig,
      endpoint_url: "ftp://example.com",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("http");
  });

  it("rejects empty region when provided", () => {
    const result = validateBucketConfig({
      ...validConfig,
      region: "",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("region");
  });

  // === Error accumulation ===
  it("config with empty bucket_name AND invalid endpoint_url produces 2 errors", () => {
    const result = validateBucketConfig({
      ...validConfig,
      bucket_name: "",
      endpoint_url: "not-a-url",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});
