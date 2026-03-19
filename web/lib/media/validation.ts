export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const MAGIC_BYTES: Record<
  string,
  { minBytes: number; check: (buf: Buffer) => boolean }
> = {
  "image/jpeg": {
    minBytes: 3,
    check: (buf) => buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  "image/png": {
    minBytes: 4,
    check: (buf) =>
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
  },
  "image/gif": {
    minBytes: 4,
    check: (buf) =>
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38,
  },
  "image/webp": {
    minBytes: 12,
    check: (buf) =>
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50,
  },
};

export function validateImage(
  buffer: Buffer,
  mimeType: string,
): ValidationResult {
  const errors: string[] = [];

  if (buffer.length === 0) {
    return { valid: false, errors: ["Image buffer is empty"], warnings: [] };
  }

  if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
    const actualMB = (buffer.length / (1024 * 1024)).toFixed(1);
    errors.push(
      `Image exceeds maximum size of 20MB (actual: ${actualMB}MB)`,
    );
  }

  const normalized = mimeType === "image/jpg" ? "image/jpeg" : mimeType;

  if (!ALLOWED_MIME_TYPES.has(normalized)) {
    errors.push(
      `Unsupported MIME type: ${mimeType}. Supported formats: image/jpeg, image/png, image/gif, image/webp`,
    );
  } else {
    const spec = MAGIC_BYTES[normalized];
    if (buffer.length < spec.minBytes) {
      errors.push(
        `Buffer too short to verify file format (need at least ${spec.minBytes} bytes, got ${buffer.length} bytes)`,
      );
    } else if (!spec.check(buffer)) {
      errors.push(
        `Magic bytes do not match declared MIME type ${normalized}`,
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

export function validateS3Key(key: string): ValidationResult {
  const errors: string[] = [];

  if (key.length === 0) {
    errors.push("S3 key must not be empty");
  }

  if (Buffer.byteLength(key, "utf8") > 1024) {
    errors.push("S3 key exceeds maximum length of 1024 bytes");
  }

  if (key.includes("\u0000")) {
    errors.push("S3 key must not contain null bytes");
  }

  let hasControlChars = false;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if ((code < 32 || code === 127) && code !== 0) {
      hasControlChars = true;
      break;
    }
  }
  if (hasControlChars) {
    errors.push("S3 key must not contain control characters");
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

export interface BucketConfigInput {
  bucket_name: string;
  endpoint_url?: string | null;
  region?: string | null;
  access_key_id: string;
  secret_access_key: string;
}

export function validateBucketConfig(
  config: BucketConfigInput,
): ValidationResult {
  const errors: string[] = [];

  if (!config.bucket_name || config.bucket_name.trim() === "") {
    errors.push("bucket_name is required");
  }

  if (
    config.access_key_id !== undefined &&
    config.access_key_id.trim() === ""
  ) {
    errors.push("access_key_id must not be empty");
  }

  if (
    config.secret_access_key !== undefined &&
    config.secret_access_key.trim() === ""
  ) {
    errors.push("secret_access_key must not be empty");
  }

  if (
    config.endpoint_url !== undefined &&
    config.endpoint_url !== null &&
    config.endpoint_url !== ""
  ) {
    try {
      const url = new URL(config.endpoint_url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        errors.push(
          `endpoint_url must use http or https protocol (got: ${url.protocol})`,
        );
      }
    } catch {
      errors.push(`endpoint_url is not a valid URL: ${config.endpoint_url}`);
    }
  }

  if (
    config.region !== undefined &&
    config.region !== null &&
    config.region.trim() === ""
  ) {
    errors.push("region must not be empty when provided");
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}
