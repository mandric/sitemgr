import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("sitemgr.ts login command", () => {
  const source = readFileSync(
    resolve(__dirname, "../../bin/sitemgr.ts"),
    "utf-8",
  );

  it("usage text does not mention [email] [password]", () => {
    expect(source).not.toContain("[email] [password]");
  });

  it("cmdLogin does not pass email/password args to login()", () => {
    expect(source).not.toMatch(/login\(email/);
    expect(source).not.toMatch(/login\(password/);
  });

  it("usage text mentions browser-based device code flow", () => {
    expect(source).toContain("device code flow");
  });
});
