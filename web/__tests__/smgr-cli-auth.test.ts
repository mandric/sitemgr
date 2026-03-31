import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("smgr CLI security checks (static analysis)", () => {
  const source = readFileSync("bin/smgr.ts", "utf-8");

  it("does not import or use getAdminClient", () => {
    expect(source).not.toContain("getAdminClient");
  });

  it("does not reference SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY", () => {
    expect(source).not.toContain("SUPABASE_SECRET_KEY");
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("does not create a Supabase client directly", () => {
    expect(source).not.toContain("getUserClient");
    expect(source).not.toContain("createClient");
    expect(source).not.toContain("setSession");
  });

  it("uses apiFetch for all API calls via the web API", () => {
    expect(source).toContain("apiFetch");
    expect(source).toContain("apiGet");
    expect(source).toContain("apiPost");
  });

  it("uses resolveApiConfig for web URL", () => {
    expect(source).toContain("resolveApiConfig()");
  });
});
