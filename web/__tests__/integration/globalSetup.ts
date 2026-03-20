/**
 * Vitest globalSetup — validates Supabase is running before integration tests.
 * Replaces the describe.skipIf(!canRun) pattern with fail-fast behavior.
 */

export default async function setup(): Promise<void> {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: anonKey },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new Error(
      `Integration tests require a running Supabase instance.\n\n` +
        `Run: supabase start\n` +
        `Then: npm run test:integration\n\n` +
        `Expected Supabase at: ${url}\n` +
        `Error: ${message}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
