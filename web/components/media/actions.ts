"use server";

import { createClient } from "@/lib/supabase/server";
import { EVENT_OP_S3_PUT } from "@/lib/media/constants";
import { redirect } from "next/navigation";

export type MediaEvent = {
  id: string;
  timestamp: string;
  device_id: string;
  op: string;
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
  data: MediaEvent[];
  count: number;
  error: unknown;
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
    if (error) return { data: [], count: 0, error };

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
    return { data: events, count: events.length, error: null };
  }

  let query = supabase
    .from("events")
    .select("*", { count: "exact" })
    .eq("user_id", user.id)
    .eq("op", EVENT_OP_S3_PUT)
    .order("timestamp", { ascending: false })
    .range(offset, offset + limit - 1);

  if (opts.type) query = query.eq("content_type", opts.type);

  const { data, count, error } = await query;
  if (error) return { data: [], count: 0, error };

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

  return { data: events, count: count ?? events.length, error: null };
}

export async function getMediaEvent(
  eventId: string,
): Promise<{ data: MediaEvent | null; error: unknown }> {
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

  if (error) return { data: null, error };
  if (!event) return { data: null, error: null };

  const { data: enrichment } = await supabase
    .from("enrichments")
    .select("description, objects, context, tags")
    .eq("event_id", eventId)
    .maybeSingle();

  return {
    data: {
      ...event,
      enrichment: enrichment ?? null,
    } as MediaEvent,
    error: null,
  };
}
