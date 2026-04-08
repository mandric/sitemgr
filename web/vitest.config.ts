import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          globals: true,
          environment: "node",
          exclude: [
            "e2e/**",
            "node_modules/**",
            "__tests__/integration/**",
            "__tests__/e2e-cli/**",
          ],
        },
      },
      {
        extends: true,
        envDir: ".",
        test: {
          name: "integration",
          globals: true,
          environment: "node",
          include: ["__tests__/integration/**/*.test.ts"],
          testTimeout: 60000,
          hookTimeout: 30000,
          globalSetup: ["__tests__/integration/globalSetup.ts"],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        envDir: ".",
        test: {
          name: "e2e-cli",
          globals: true,
          environment: "node",
          include: ["__tests__/e2e-cli/**/*.test.ts"],
          testTimeout: 120000,
          hookTimeout: 60000,
          globalSetup: ["__tests__/integration/globalSetup.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
