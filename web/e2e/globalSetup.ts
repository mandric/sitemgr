/**
 * Playwright globalSetup — starts a mock Anthropic HTTP server so E2E tests
 * that exercise the agent UI get deterministic responses without needing a real
 * ANTHROPIC_API_KEY.
 *
 * The mock server binds to a fixed port (ANTHROPIC_MOCK_PORT, default 19876)
 * so that playwright.config.ts can reference it in webServer.env before
 * globalSetup runs. The Next.js dev server picks it up via the Anthropic SDK's
 * standard ANTHROPIC_BASE_URL env var.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";

/**
 * A minimal Anthropic messages response that contains a markdown link to /buckets.
 * The format matches the Anthropic Messages API v1 response shape.
 */
function mockAnthropicResponse(userMessage: string): object {
  // Return a response with a markdown link so tests for link rendering pass.
  let text = "I can help you with that! You can configure your S3 buckets on the [buckets page](/buckets).";

  if (/link.*bucket|bucket.*link|configure bucket/i.test(userMessage)) {
    text = "Sure! Here's the link to configure your buckets: [Buckets](/buckets).";
  }

  return {
    id: "msg_mock_001",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-sonnet-4-20250514",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

export const MOCK_PORT = Number(process.env.ANTHROPIC_MOCK_PORT ?? "19876");

let mockServer: Server | undefined;

export default async function globalSetup(): Promise<void> {
  // If a real API key is set, don't intercept — let tests hit the real API.
  if (process.env.ANTHROPIC_API_KEY) {
    return;
  }

  mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url?.includes("/messages")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let userMessage = "";
        try {
          const parsed = JSON.parse(body);
          const lastUserMsg = [...(parsed.messages ?? [])].reverse().find(
            (m: { role: string }) => m.role === "user"
          );
          userMessage = typeof lastUserMsg?.content === "string"
            ? lastUserMsg.content
            : "";
        } catch {
          // ignore parse errors, use empty string
        }

        const responseBody = JSON.stringify(mockAnthropicResponse(userMessage));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(responseBody),
        });
        res.end(responseBody);
      });
    } else {
      // Return empty 200 for any other requests (e.g. health checks from SDK)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }
  });

  await new Promise<void>((resolve) => {
    mockServer!.listen(MOCK_PORT, "127.0.0.1", resolve);
  });

  const baseUrl = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  console.log(`[e2e/globalSetup] Mock Anthropic server listening at ${baseUrl}`);
}

export async function teardown(): Promise<void> {
  if (mockServer) {
    await new Promise<void>((resolve, reject) => {
      mockServer!.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
