import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/media/db";

// TODO: Add Anthropic API connectivity check (e.g. list models)
// TODO: Add Twilio API connectivity check (e.g. fetch account info)

export async function GET() {
  const checks: Record<string, string> = {};

  // Check Supabase DB connectivity
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("conversations")
      .select("phone", { count: "exact", head: true })
      .limit(0);
    checks.supabase = error ? `error: ${error.message}` : "ok";
  } catch (e) {
    checks.supabase = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  const allOk = Object.values(checks).every((v) => v === "ok");

  return NextResponse.json(
    {
      status: allOk ? "ok" : "degraded",
      service: "smgr",
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 },
  );
}
