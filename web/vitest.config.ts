import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: [
      "e2e/**",
      "node_modules/**",
      "__tests__/rls-policies.test.ts",
      "__tests__/rpc-user-isolation.test.ts",
      "__tests__/migration-integrity.test.ts",
      "__tests__/integration/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
