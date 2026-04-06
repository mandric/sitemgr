import { defineConfig, devices } from '@playwright/test';

const ANTHROPIC_MOCK_PORT = Number(process.env.ANTHROPIC_MOCK_PORT ?? "19876");
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_API_KEY
  ? "" // real key present — don't redirect
  : `http://127.0.0.1:${ANTHROPIC_MOCK_PORT}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/globalSetup.ts',
  globalTeardown: './e2e/globalTeardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000, // 2 minutes to start
    env: {
      // Point the Next.js dev server at the mock Anthropic server started by
      // globalSetup so the Anthropic SDK never hits the real API in tests.
      // When ANTHROPIC_API_KEY is set the mock is skipped and this is empty,
      // leaving the SDK to use the key normally.
      ANTHROPIC_BASE_URL,
    },
  },
});
