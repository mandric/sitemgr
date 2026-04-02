/**
 * Integration test for GET /api/health
 * No auth needed — validates dev server + Supabase connectivity.
 */

const BASE_URL = `http://localhost:${process.env.WEB_PORT ?? "3000"}`;

describe("GET /api/health", () => {
  it("returns 200 with status ok", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("smgr");
    expect(typeof body.timestamp).toBe("string");
  });
});
