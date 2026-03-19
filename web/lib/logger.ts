import { getRequestId } from "./request-context";

export const LogComponent = {
  S3: "s3",
  Enrichment: "enrichment",
  DB: "db",
  Agent: "agent",
  CLI: "cli",
  API: "api",
  Crypto: "crypto",
} as const;

interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  component: string;
  message: string;
  request_id?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(component: string): Logger {
  function log(
    level: LogEntry["level"],
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
    };

    const requestId = getRequestId();
    if (requestId !== undefined) {
      entry.request_id = requestId;
    }

    if (meta) {
      for (const [key, value] of Object.entries(meta)) {
        if (value instanceof Error) {
          entry.error_message = value.message;
          entry.error_stack = value.stack;
        } else {
          entry[key] = value;
        }
      }
    }

    console.error(JSON.stringify(entry));
  }

  return {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
  };
}
