import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyS3Error, S3ErrorType } from "@/lib/media/s3-errors";

const mockSend = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let s3ConstructorArgs: any[] = [];

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    send = mockSend;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(opts: any) {
      s3ConstructorArgs.push(opts);
    }
  }
  class MockListObjectsCommand {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public input: any) {}
  }
  class MockGetObjectCommand {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public input: any) {}
  }
  class MockPutObjectCommand {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public input: any) {}
  }
  return {
    S3Client: MockS3Client,
    ListObjectsV2Command: MockListObjectsCommand,
    ListObjectsCommand: MockListObjectsCommand,
    GetObjectCommand: MockGetObjectCommand,
    PutObjectCommand: MockPutObjectCommand,
  };
});

vi.mock("@smithy/node-http-handler", () => ({
  NodeHttpHandler: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogComponent: { S3: "s3" },
}));

vi.mock("@/lib/media/validation", () => ({
  validateS3Key: vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  s3ConstructorArgs = [];
});

describe("createS3Client", () => {
  it("creates client with default region us-east-1", async () => {
    const { createS3Client } = await import("@/lib/media/s3");
    createS3Client({});
    expect(s3ConstructorArgs[0]).toMatchObject({ region: "us-east-1" });
  });

  it("creates client with custom endpoint", async () => {
    const { createS3Client } = await import("@/lib/media/s3");
    createS3Client({ endpoint: "http://localhost:9000" });
    expect(s3ConstructorArgs[0]).toMatchObject({
      endpoint: "http://localhost:9000",
    });
  });

  it("sets forcePathStyle true when endpoint is provided", async () => {
    const { createS3Client } = await import("@/lib/media/s3");
    createS3Client({ endpoint: "http://localhost:9000" });
    expect(s3ConstructorArgs[0].forcePathStyle).toBe(true);
  });

  it("sets forcePathStyle false when no endpoint", async () => {
    const { createS3Client } = await import("@/lib/media/s3");
    createS3Client({});
    expect(s3ConstructorArgs[0].forcePathStyle).toBe(false);
  });

  it("passes credentials when both keys provided", async () => {
    const { createS3Client } = await import("@/lib/media/s3");
    createS3Client({ accessKeyId: "AK", secretAccessKey: "SK" });
    expect(s3ConstructorArgs[0].credentials).toEqual({
      accessKeyId: "AK",
      secretAccessKey: "SK",
    });
  });

  it("sets maxAttempts: 4", async () => {
    const { createS3Client } = await import("@/lib/media/s3");
    createS3Client({});
    expect(s3ConstructorArgs[0].maxAttempts).toBe(4);
  });

  it("sets retryMode: adaptive", async () => {
    const { createS3Client } = await import("@/lib/media/s3");
    createS3Client({});
    expect(s3ConstructorArgs[0].retryMode).toBe("adaptive");
  });

  it("passes requestHandler", async () => {
    const { createS3Client } = await import("@/lib/media/s3");
    createS3Client({});
    expect(s3ConstructorArgs[0].requestHandler).toBeDefined();
  });
});

describe("classifyS3Error", () => {
  it("classifies 'not implemented' as Unsupported", () => {
    expect(classifyS3Error(new Error("not implemented"))).toBe(S3ErrorType.Unsupported);
  });

  it("classifies 'unsupported' (case-insensitive) as Unsupported", () => {
    expect(classifyS3Error(new Error("Unsupported operation"))).toBe(S3ErrorType.Unsupported);
  });

  it("classifies httpStatusCode 404 as NotFound", () => {
    const err = Object.assign(new Error("nf"), { $metadata: { httpStatusCode: 404 } });
    expect(classifyS3Error(err)).toBe(S3ErrorType.NotFound);
  });

  it("classifies httpStatusCode 403 as AccessDenied", () => {
    const err = Object.assign(new Error("forbidden"), { $metadata: { httpStatusCode: 403 } });
    expect(classifyS3Error(err)).toBe(S3ErrorType.AccessDenied);
  });

  it("classifies httpStatusCode 401 as AccessDenied", () => {
    const err = Object.assign(new Error("unauth"), { $metadata: { httpStatusCode: 401 } });
    expect(classifyS3Error(err)).toBe(S3ErrorType.AccessDenied);
  });

  it("classifies httpStatusCode 500 as ServerError", () => {
    const err = Object.assign(new Error("ise"), { $metadata: { httpStatusCode: 500 } });
    expect(classifyS3Error(err)).toBe(S3ErrorType.ServerError);
  });

  it("classifies httpStatusCode 503 as ServerError", () => {
    const err = Object.assign(new Error("su"), { $metadata: { httpStatusCode: 503 } });
    expect(classifyS3Error(err)).toBe(S3ErrorType.ServerError);
  });

  it("classifies ECONNRESET as NetworkError", () => {
    expect(classifyS3Error(Object.assign(new Error("r"), { code: "ECONNRESET" }))).toBe(S3ErrorType.NetworkError);
  });

  it("classifies ECONNREFUSED as NetworkError", () => {
    expect(classifyS3Error(Object.assign(new Error("r"), { code: "ECONNREFUSED" }))).toBe(S3ErrorType.NetworkError);
  });

  it("classifies ETIMEDOUT as NetworkError", () => {
    expect(classifyS3Error(Object.assign(new Error("t"), { code: "ETIMEDOUT" }))).toBe(S3ErrorType.NetworkError);
  });

  it("classifies TimeoutError name as Timeout", () => {
    const err = new Error("to");
    err.name = "TimeoutError";
    expect(classifyS3Error(err)).toBe(S3ErrorType.Timeout);
  });

  it("classifies RequestTimeout name as Timeout", () => {
    const err = new Error("rt");
    err.name = "RequestTimeout";
    expect(classifyS3Error(err)).toBe(S3ErrorType.Timeout);
  });

  it("classifies unknown error as Unknown", () => {
    expect(classifyS3Error(new Error("something weird"))).toBe(S3ErrorType.Unknown);
  });

  it("classifies a plain string as Unknown without crashing", () => {
    expect(classifyS3Error("some string")).toBe(S3ErrorType.Unknown);
  });

  it("message check takes priority over httpStatusCode", () => {
    const err = Object.assign(new Error("not implemented"), { $metadata: { httpStatusCode: 404 } });
    expect(classifyS3Error(err)).toBe(S3ErrorType.Unsupported);
  });
});

describe("listS3Objects", () => {
  it("returns correct S3Object array from single-page response", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    const date = new Date("2024-01-15T10:00:00Z");
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: "photo.jpg", Size: 1024, ETag: '"abc123"', LastModified: date }],
      IsTruncated: false,
    });

    const client = createS3Client({});
    const result = await listS3Objects(client, "my-bucket");
    expect(result).toEqual([{
      key: "photo.jpg", size: 1024, etag: "abc123", lastModified: "2024-01-15T10:00:00.000Z",
    }]);
  });

  it("collects objects across multiple v2 pages", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    const date = new Date("2024-01-15T10:00:00Z");
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: "a.jpg", Size: 100, ETag: '"e1"', LastModified: date }],
        IsTruncated: true, NextContinuationToken: "token-1",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "b.jpg", Size: 200, ETag: '"e2"', LastModified: date }],
        IsTruncated: false,
      });

    const client = createS3Client({});
    const result = await listS3Objects(client, "my-bucket");
    expect(result).toHaveLength(2);
    expect(result[0].key).toBe("a.jpg");
    expect(result[1].key).toBe("b.jpg");
  });

  it("returns empty array when Contents is undefined", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    mockSend.mockResolvedValueOnce({ IsTruncated: false });
    const result = await listS3Objects(createS3Client({}), "b");
    expect(result).toEqual([]);
  });

  it("returns empty array when Contents is empty", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    mockSend.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const result = await listS3Objects(createS3Client({}), "b");
    expect(result).toEqual([]);
  });

  it("strips quotes from ETag", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: "a.jpg", Size: 0, ETag: '"quoted"', LastModified: new Date() }],
      IsTruncated: false,
    });
    const result = await listS3Objects(createS3Client({}), "b");
    expect(result[0].etag).toBe("quoted");
  });

  it("uses empty string for undefined ETag", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: "a.jpg", Size: 0, LastModified: new Date() }],
      IsTruncated: false,
    });
    const result = await listS3Objects(createS3Client({}), "b");
    expect(result[0].etag).toBe("");
  });

  it("uses current timestamp when LastModified is missing", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: "a.jpg", Size: 0 }],
      IsTruncated: false,
    });
    const result = await listS3Objects(createS3Client({}), "b");
    expect(result[0].lastModified).not.toBe("");
    expect(new Date(result[0].lastModified).getTime()).not.toBeNaN();
  });

  it("falls back to v1 when v2 throws 'not implemented'", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    mockSend
      .mockRejectedValueOnce(new Error("not implemented"))
      .mockResolvedValueOnce({
        Contents: [{ Key: "fb.jpg", Size: 50, ETag: '"fb"', LastModified: new Date() }],
        IsTruncated: false,
      });
    const result = await listS3Objects(createS3Client({}), "b");
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("fb.jpg");
  });

  it("falls back to v1 when v2 throws 'unsupported'", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    mockSend
      .mockRejectedValueOnce(new Error("Unsupported operation"))
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const result = await listS3Objects(createS3Client({}), "b");
    expect(result).toEqual([]);
  });

  it("does NOT fall back when v2 throws unrelated error", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    mockSend.mockRejectedValueOnce(new Error("network failure"));
    await expect(listS3Objects(createS3Client({}), "b")).rejects.toThrow("network failure");
  });

  it("v1 fallback paginates with Marker", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    const date = new Date();
    mockSend
      .mockRejectedValueOnce(new Error("not implemented"))
      .mockResolvedValueOnce({
        Contents: [{ Key: "a.jpg", Size: 1, ETag: '""', LastModified: date }],
        IsTruncated: true, NextMarker: "a.jpg",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "b.jpg", Size: 2, ETag: '""', LastModified: date }],
        IsTruncated: false,
      });
    const result = await listS3Objects(createS3Client({}), "b");
    expect(result).toHaveLength(2);
  });

  it("v1 uses last key as Marker when NextMarker is absent", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    const date = new Date();
    mockSend
      .mockRejectedValueOnce(new Error("not implemented"))
      .mockResolvedValueOnce({
        Contents: [{ Key: "c.jpg", Size: 1, ETag: '""', LastModified: date }],
        IsTruncated: true,
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "d.jpg", Size: 2, ETag: '""', LastModified: date }],
        IsTruncated: false,
      });
    const result = await listS3Objects(createS3Client({}), "b");
    expect(result).toHaveLength(2);
  });

  it("treats IsTruncated with no NextContinuationToken as last page", async () => {
    const { listS3Objects, createS3Client } = await import("@/lib/media/s3");
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: "a.jpg", Size: 1, ETag: '""', LastModified: new Date() }],
      IsTruncated: true,
      // No NextContinuationToken
    });
    const result = await listS3Objects(createS3Client({}), "b");
    expect(result).toHaveLength(1);
  });
});

describe("downloadS3Object", () => {
  it("downloads object and returns a Buffer", async () => {
    const { downloadS3Object, createS3Client } = await import("@/lib/media/s3");
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3])) },
    });
    const result = await downloadS3Object(createS3Client({}), "b", "key.jpg");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toEqual(Buffer.from([1, 2, 3]));
  });

  it("calls validateS3Key before sending request", async () => {
    const { validateS3Key } = await import("@/lib/media/validation");
    const { downloadS3Object, createS3Client } = await import("@/lib/media/s3");
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: () => Promise.resolve(new Uint8Array()) },
    });
    await downloadS3Object(createS3Client({}), "b", "valid-key.jpg");
    expect(validateS3Key).toHaveBeenCalledWith("valid-key.jpg");
  });

  it("throws with s3ErrorType on 404", async () => {
    const { downloadS3Object, createS3Client } = await import("@/lib/media/s3");
    const err = Object.assign(new Error("NoSuchKey"), { $metadata: { httpStatusCode: 404 } });
    mockSend.mockRejectedValueOnce(err);
    try {
      await downloadS3Object(createS3Client({}), "b", "missing.jpg");
      expect.fail("should throw");
    } catch (e: unknown) {
      expect((e as Record<string, unknown>).s3ErrorType).toBe(S3ErrorType.NotFound);
    }
  });

  it("throws with s3ErrorType on 403", async () => {
    const { downloadS3Object, createS3Client } = await import("@/lib/media/s3");
    const err = Object.assign(new Error("AccessDenied"), { $metadata: { httpStatusCode: 403 } });
    mockSend.mockRejectedValueOnce(err);
    try {
      await downloadS3Object(createS3Client({}), "b", "secret.jpg");
      expect.fail("should throw");
    } catch (e: unknown) {
      expect((e as Record<string, unknown>).s3ErrorType).toBe(S3ErrorType.AccessDenied);
    }
  });
});

describe("uploadS3Object", () => {
  it("sends PutObjectCommand with correct params and calls send", async () => {
    const { uploadS3Object, createS3Client } = await import("@/lib/media/s3");
    mockSend.mockResolvedValueOnce({});
    const body = Buffer.from("test");
    await uploadS3Object(createS3Client({}), "bucket", "key.jpg", body, "image/jpeg");
    expect(mockSend).toHaveBeenCalledOnce();
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input).toEqual({
      Bucket: "bucket", Key: "key.jpg", Body: body, ContentType: "image/jpeg",
    });
  });

  it("omits ContentType when not provided", async () => {
    const { uploadS3Object, createS3Client } = await import("@/lib/media/s3");
    mockSend.mockResolvedValueOnce({});
    await uploadS3Object(createS3Client({}), "b", "k", Buffer.from("x"));
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.ContentType).toBeUndefined();
  });

  it("propagates error when upload fails", async () => {
    const { uploadS3Object, createS3Client } = await import("@/lib/media/s3");
    mockSend.mockRejectedValueOnce(new Error("upload failed"));
    await expect(uploadS3Object(createS3Client({}), "b", "k", Buffer.from("x"))).rejects.toThrow("upload failed");
  });
});
