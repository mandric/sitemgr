import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("instrumentation register()", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
  });

  it("warns when NEXT_PUBLIC_SUPABASE_URL is missing", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    const { register } = await import("@/instrumentation");
    await register();

    const output = errorSpy.mock.calls.map((c: unknown[]) => c[0]).join(" ");
    expect(output).toContain("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("warns when NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    const { register } = await import("@/instrumentation");
    await register();

    const output = errorSpy.mock.calls.map((c: unknown[]) => c[0]).join(" ");
    expect(output).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  });

  it("required vars do NOT include SUPABASE_SECRET_KEY", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+1");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    delete process.env.SUPABASE_SECRET_KEY;

    const { register } = await import("@/instrumentation");
    await register();

    // With all required + webhook vars provided, no warning should appear
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("required vars do NOT include SUPABASE_SERVICE_ROLE_KEY", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+1");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { register } = await import("@/instrumentation");
    await register();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("warns when required vars are missing", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    const { register } = await import("@/instrumentation");
    await register();

    expect(errorSpy).toHaveBeenCalled();
    const output = errorSpy.mock.calls.map((c: unknown[]) => c[0]).join(" ");
    expect(output).toContain("Missing environment variables");
  });
});
