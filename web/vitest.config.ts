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
            // Old test files (deleted in cleanup, kept until then)
            "__tests__/rls-policies.test.ts",
            "__tests__/rpc-user-isolation.test.ts",
            "__tests__/migration-integrity.test.ts",
            "__tests__/rls-audit.test.ts",
          ],
        },
      },
      {
        extends: true,
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
    ],
  },
});
