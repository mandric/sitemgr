export enum S3ErrorType {
  NotFound,
  AccessDenied,
  Unsupported,
  NetworkError,
  Timeout,
  ServerError,
  Unknown,
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
]);

const TIMEOUT_NAMES = new Set(["TimeoutError", "RequestTimeout"]);

export function classifyS3Error(error: unknown): S3ErrorType {
  // 1. Message-based check (highest priority)
  const msg = String(error).toLowerCase();
  if (msg.includes("not implemented") || msg.includes("unsupported")) {
    return S3ErrorType.Unsupported;
  }

  // 2. HTTP status code
  const errRecord = error as Record<string, unknown>;
  const metadata = errRecord?.$metadata as Record<string, unknown> | undefined;
  const status = metadata?.httpStatusCode as number | undefined;
  if (status === 403 || status === 401) return S3ErrorType.AccessDenied;
  if (status === 404) return S3ErrorType.NotFound;
  if (status === 500 || status === 503) return S3ErrorType.ServerError;

  // 3. Network error codes
  const code = errRecord?.code as string | undefined;
  if (code && NETWORK_CODES.has(code)) return S3ErrorType.NetworkError;

  // 4. Timeout by name
  const name = errRecord?.name as string | undefined;
  if (name && TIMEOUT_NAMES.has(name)) return S3ErrorType.Timeout;

  return S3ErrorType.Unknown;
}
