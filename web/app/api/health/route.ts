import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/media/db";

// TODO: Add Anthropic API connectivity check (e.g. list models)
// TODO: Add Twilio API connectivity check (e.g. fetch account info)

export async function GET() {
  let ok = true;

  // Check Supabase DB connectivity
  try {
    const supabase = getUserClient({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
      anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    });
    const { error } = await supabase
      .from("events")
      .select("id", { count: "exact", head: true })
      .limit(0);
    if (error) {
      console.error("[health] supabase check error:", error.message || error.code || JSON.stringify(error));
      ok = false;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[health] supabase check failed:", msg);
    ok = false;
  }

  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      service: "smgr",
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
