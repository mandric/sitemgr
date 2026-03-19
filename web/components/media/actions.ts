"use server";

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export type MediaEvent = {
  id: string;
  timestamp: string;
  device_id: string;
  type: string;
  content_type: string | null;
  content_hash: string | null;
  remote_path: string | null;
  metadata: Record<string, unknown> | null;
  bucket_config_id: string | null;
  enrichment?: {
    description: string;
    objects: string[];
    context: string;
    tags: string[];
  } | null;
};

export type MediaQueryResult = {
  events: MediaEvent[];
  total: number;
};

export async function getMediaEvents(opts: {
  search?: string;
  type?: string;
  offset?: number;
  limit?: number;
}): Promise<MediaQueryResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const limit = opts.limit ?? 24;
  const offset = opts.offset ?? 0;

  if (opts.search) {
    const { data, error } = await supabase.rpc("search_events", {
      p_user_id: user.id,
      query_text: opts.search,
      content_type_filter: opts.type ?? null,
      since_filter: null,
      until_filter: null,
      result_limit: limit,
    });
    if (error) throw error;

    const events = (data ?? []) as MediaEvent[];
    // Attach enrichments for search results
    for (const evt of events) {
      if (!(evt as Record<string, unknown>).enrichment) {
        const { data: enrichment } = await supabase
          .from("enrichments")
          .select("description, objects, context, tags")
          .eq("event_id", evt.id)
          .maybeSingle();
        if (enrichment) evt.enrichment = enrichment;
      }
    }
    return { events, total: events.length };
  }

  let query = supabase
    .from("events")
    .select("*", { count: "exact" })
    .eq("user_id", user.id)
    .eq("type", "create")
    .order("timestamp", { ascending: false })
    .range(offset, offset + limit - 1);

  if (opts.type) query = query.eq("content_type", opts.type);

  const { data, count, error } = await query;
  if (error) throw error;

  const events = (data ?? []) as MediaEvent[];

  // Batch-fetch enrichments
  const eventIds = events.map((e) => e.id);
  if (eventIds.length > 0) {
    const { data: enrichments } = await supabase
      .from("enrichments")
      .select("event_id, description, objects, context, tags")
      .in("event_id", eventIds);

    const enrichmentMap = new Map(
      (enrichments ?? []).map((e) => [e.event_id, e]),
    );
    for (const evt of events) {
      const enrichment = enrichmentMap.get(evt.id);
      if (enrichment) {
        evt.enrichment = {
          description: enrichment.description,
          objects: enrichment.objects,
          context: enrichment.context,
          tags: enrichment.tags,
        };
      }
    }
  }

  return { events, total: count ?? events.length };
}

export async function getMediaEvent(
  eventId: string,
): Promise<MediaEvent | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: event, error } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) throw error;
  if (!event) return null;

  const { data: enrichment } = await supabase
    .from("enrichments")
    .select("description, objects, context, tags")
    .eq("event_id", eventId)
    .maybeSingle();

  return {
    ...event,
    enrichment: enrichment ?? null,
  } as MediaEvent;
}
