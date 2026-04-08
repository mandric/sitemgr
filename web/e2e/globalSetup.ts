import { resolve } from "node:path";

// globalSetup runs before Playwright's env loading — load .env.local explicitly.
try {
  process.loadEnvFile(resolve(__dirname, "../.env.local"));
} catch {
  // .env.local may not exist in CI (env vars set directly)
}

const REQUIRED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "ENCRYPTION_KEY_CURRENT",
];

export default async function globalSetup(): Promise<void> {
  const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `E2E tests are missing required environment variables:\n` +
      missing.map((v) => `  - ${v}`).join("\n") + "\n\n" +
      "Run `npm run setup` to generate web/.env.local.",
    );
  }
}
