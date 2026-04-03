/**
 * Playwright fixture that collects browser-side (client) JavaScript coverage.
 *
 * Uses Chrome DevTools Protocol to start/stop V8 coverage in the browser.
 * After all tests, writes raw V8 coverage JSON to a temp directory for
 * conversion to LCOV via c8.
 *
 * Usage: import { test } from './coverage-fixture' instead of '@playwright/test'
 */
import { test as base } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const V8_COV_DIR = join(tmpdir(), "v8-coverage-playwright-client");
mkdirSync(V8_COV_DIR, { recursive: true });

let coverageIndex = 0;

export const test = base.extend({
  // Auto-use fixture: starts coverage before each test, stops after
  page: async ({ page }, use) => {
    // Start collecting JS coverage in the browser
    await page.coverage.startJSCoverage({ resetOnNavigation: false });

    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(page);

    // Stop and save coverage
    const coverage = await page.coverage.stopJSCoverage();

    // Filter to only our app's JS (exclude node_modules, _next/static framework chunks)
    const appCoverage = coverage.filter((entry) => {
      const url = entry.url;
      // Keep: app source files compiled by Next.js
      return (
        url.includes("localhost:3000") &&
        !url.includes("node_modules") &&
        !url.includes("_next/static/chunks/webpack") &&
        !url.includes("_next/static/chunks/polyfill") &&
        !url.includes("_next/static/chunks/framework")
      );
    });

    if (appCoverage.length > 0) {
      // Write in V8 coverage format that c8 can read
      const covData = {
        result: appCoverage.map((entry) => ({
          scriptId: String(coverageIndex++),
          url: entry.url,
          functions: entry.functions || [],
        })),
      };
      const filename = join(
        V8_COV_DIR,
        `coverage-${Date.now()}-${coverageIndex}.json`,
      );
      writeFileSync(filename, JSON.stringify(covData));
    }
  },
});

export { expect } from "@playwright/test";
