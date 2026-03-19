const NON_RETRYABLE_CODES = new Set([
  "23505", // Postgres duplicate key
  "23503", // Postgres FK violation
  "42501", // Postgres RLS denied
  "PGRST301", // PostgREST JWT/auth error
  "PGRST302", // PostgREST auth error
]);

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  shouldRetry: (error: unknown) => boolean;
  delayFn?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const defaultConfig: RetryConfig = {
  maxRetries: 2,
  baseDelay: 500,
  maxDelay: 5000,
  shouldRetry: (error: unknown): boolean => {
    const code = (error as { code?: string })?.code;
    if (code && NON_RETRYABLE_CODES.has(code)) return false;
    return true;
  },
};

const defaultDelayFn = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
): Promise<T> {
  const cfg = { ...defaultConfig, ...config };
  const delayFn = cfg.delayFn ?? defaultDelayFn;

  let lastError: unknown;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= cfg.maxRetries || !cfg.shouldRetry(error)) {
        throw error;
      }

      const delayMs = Math.min(
        cfg.baseDelay * Math.pow(2, attempt),
        cfg.maxDelay,
      );

      if (cfg.onRetry) {
        cfg.onRetry(attempt + 1, error, delayMs);
      }

      await delayFn(delayMs);
    }
  }

  throw lastError;
}
