/**
 * Integration tests for scripts/local-dev.sh print_setup_env_vars output.
 *
 * Requires `supabase start` to be running locally.
 */
import { execFileSync } from "child_process";
import { resolve } from "path";
import { describe, it, expect, beforeAll } from "vitest";

const SCRIPT = resolve(__dirname, "../../../scripts/local-dev.sh");

describe("print_setup_env_vars", () => {
  let output: string;

  beforeAll(() => {
    output = execFileSync("bash", [SCRIPT, "print_setup_env_vars"], {
      encoding: "utf-8",
      timeout: 30_000,
    });
  });
  it("outputs NEXT_PUBLIC_SUPABASE_URL", () => {
    expect(output).toMatch(/^NEXT_PUBLIC_SUPABASE_URL=.+/m);
  });

  it("outputs NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", () => {
    expect(output).toMatch(/^NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=.+/m);
  });

  it("outputs SMGR_API_URL and SMGR_API_KEY", () => {
    expect(output).toMatch(/^SMGR_API_URL=.+/m);
    expect(output).toMatch(/^SMGR_API_KEY=.+/m);
  });

  it("does NOT output SUPABASE_SECRET_KEY (old name)", () => {
    // Should not appear as an active env var
    expect(output).not.toMatch(/^SUPABASE_SECRET_KEY=/m);
  });

  it("outputs SUPABASE_SERVICE_ROLE_KEY as a comment (not active env var)", () => {
    // Should be commented out
    expect(output).toMatch(/^# SUPABASE_SERVICE_ROLE_KEY=.+/m);
    // Should NOT be an active (uncommented) env var
    expect(output).not.toMatch(/^SUPABASE_SERVICE_ROLE_KEY=/m);
  });

  it("outputs valid dotenv format (no syntax errors)", () => {
    const lines = output.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      expect(
        trimmed,
        `Invalid dotenv line: "${trimmed}"`,
      ).toMatch(/^[A-Z_][A-Z0-9_]*=.*/);
    }
  });

  it("capability probe succeeds (script exits 0 with valid output)", () => {
    // The script already ran successfully in beforeAll (exit code 0).
    // If the probe failed, execFileSync would have thrown.
    expect(output.length).toBeGreaterThan(0);
  });
});
