import { defineConfig, devices } from '@playwright/test';

// Default to single worker (safe for dev laptops). Set E2E_PARALLEL=1 to
// enable parallel execution on machines with more resources.
const parallel = !!process.env.E2E_PARALLEL;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: parallel,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: parallel ? undefined : 1,
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
  },
});
