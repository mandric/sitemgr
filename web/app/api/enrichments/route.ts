/**
 * POST /api/enrichments — Save an enrichment result for an event
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, isAuthenticated } from "@/lib/supabase/api-auth";
import { insertEnrichment } from "@/lib/media/db";

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!isAuthenticated(auth)) return auth;

  const body = await request.json().catch(() => null);
  if (!body?.event_id || !body?.result) {
    return NextResponse.json(
      { error: "event_id and result are required" },
      { status: 400 },
    );
  }

  const { data, error } = await insertEnrichment(
    auth.supabase,
    body.event_id,
    body.result,
    auth.user.id,
  );

  if (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }

  return NextResponse.json({ data }, { status: 201 });
}
