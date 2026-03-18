/**
 * Database operations for the media event store (Supabase Postgres)
 */

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/** Creates a Supabase client with the service role key (bypasses RLS). */
export function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.replace(/\s+/g, "");
  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");
  }
  if (!key) {
    throw new Error("SUPABASE_SECRET_KEY is required for admin client");
  }
  return createSupabaseClient(url, key);
}

/** Creates a Supabase client with the publishable key (respects RLS). */
export function getUserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.replace(/\s+/g, "");
  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");
  }
  if (!key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required for user client");
  }
  return createSupabaseClient(url, key);
}

export interface EventRow {
  id: string;
  timestamp: string;
  device_id: string;
  type: string;
  content_type: string | null;
  content_hash: string | null;
  local_path: string | null;
  remote_path: string | null;
  metadata: Record<string, unknown> | null;
  parent_id: string | null;
  bucket_config_id?: string | null;
  user_id: string;
}

// ── Query ──────────────────────────────────────────────────────

export interface QueryOptions {
  userId?: string;
  search?: string;
  type?: string;
  since?: string;
  until?: string;
  device?: string;
  limit?: number;
  offset?: number;
}

export async function queryEvents(opts: QueryOptions) {
  const supabase = getUserClient();

  // Full-text search via RPC
  if (opts.search) {
    const { data, error } = await supabase.rpc("search_events", {
      p_user_id: opts.userId,
      query_text: opts.search,
      content_type_filter: opts.type ?? null,
      since_filter: opts.since ?? null,
      until_filter: opts.until ?? null,
      result_limit: opts.limit ?? 20,
    });
    if (error) throw error;
    return { events: data ?? [], total: (data ?? []).length };
  }

  // Standard query
  let query = supabase
    .from("events")
    .select("*", { count: "exact" })
    .eq("type", "create")
    .order("timestamp", { ascending: false })
    .range(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 20) - 1);

  if (opts.userId) query = query.eq("user_id", opts.userId);
  if (opts.type) query = query.eq("content_type", opts.type);
  if (opts.since) query = query.gte("timestamp", opts.since);
  if (opts.until) query = query.lte("timestamp", opts.until);
  if (opts.device) query = query.eq("device_id", opts.device);

  const { data, count, error } = await query;
  if (error) throw error;

  // Attach enrichments
  const events = data ?? [];
  for (const evt of events) {
    const { data: enrichment } = await supabase
      .from("enrichments")
      .select("description, objects, context, tags")
      .eq("event_id", evt.id)
      .maybeSingle();
    if (enrichment) {
      (evt as Record<string, unknown>).enrichment = enrichment;
    }
  }

  return { events, total: count ?? events.length };
}

// ── Show ───────────────────────────────────────────────────────

export async function showEvent(eventId: string, userId?: string) {
  const supabase = getUserClient();

  let query = supabase
    .from("events")
    .select("*")
    .eq("id", eventId);
  if (userId) query = query.eq("user_id", userId);
  const { data: event, error } = await query.maybeSingle();

  if (error) throw error;
  if (!event) return null;

  if (event.type === "create") {
    const { data: enrichment } = await supabase
      .from("enrichments")
      .select("description, objects, context, tags")
      .eq("event_id", eventId)
      .maybeSingle();
    if (enrichment) {
      event.enrichment = enrichment;
    }
  }

  return event;
}

// ── Stats ──────────────────────────────────────────────────────

export async function getStats(userId?: string) {
  const supabase = getUserClient();

  let eventsQuery = supabase.from("events").select("*", { count: "exact", head: true });
  let enrichmentsQuery = supabase.from("enrichments").select("*", { count: "exact", head: true });
  let watchedQuery = supabase.from("watched_keys").select("*", { count: "exact", head: true });

  if (userId) {
    eventsQuery = eventsQuery.eq("user_id", userId);
    enrichmentsQuery = enrichmentsQuery.eq("user_id", userId);
    watchedQuery = watchedQuery.eq("user_id", userId);
  }

  const [byContentType, byEventType, totalRes, enrichedRes, watchedRes] =
    await Promise.all([
      supabase.rpc("stats_by_content_type", { p_user_id: userId }),
      supabase.rpc("stats_by_event_type", { p_user_id: userId }),
      eventsQuery,
      enrichmentsQuery,
      watchedQuery,
    ]);

  const contentTypeCounts: Record<string, number> = {};
  for (const row of byContentType.data ?? []) {
    contentTypeCounts[row.content_type ?? "unknown"] = Number(row.count);
  }

  const eventTypeCounts: Record<string, number> = {};
  for (const row of byEventType.data ?? []) {
    eventTypeCounts[row.type] = Number(row.count);
  }

  const total = totalRes.count ?? 0;
  const enriched = enrichedRes.count ?? 0;
  const watched = watchedRes.count ?? 0;
  const photoCount = contentTypeCounts["photo"] ?? 0;

  return {
    total_events: total,
    by_content_type: contentTypeCounts,
    by_event_type: eventTypeCounts,
    watched_s3_keys: watched,
    enriched,
    pending_enrichment: Math.max(0, photoCount - enriched),
    device_id: process.env.SMGR_DEVICE_ID ?? "default",
  };
}

// ── Enrich Status ──────────────────────────────────────────────

export async function getEnrichStatus(userId?: string) {
  const supabase = getUserClient();

  let eventsQuery = supabase
    .from("events")
    .select("*", { count: "exact", head: true })
    .eq("type", "create")
    .eq("content_type", "photo");
  let enrichmentsQuery = supabase
    .from("enrichments")
    .select("*", { count: "exact", head: true });

  if (userId) {
    eventsQuery = eventsQuery.eq("user_id", userId);
    enrichmentsQuery = enrichmentsQuery.eq("user_id", userId);
  }

  const [totalRes, enrichedRes] = await Promise.all([
    eventsQuery,
    enrichmentsQuery,
  ]);

  const total = totalRes.count ?? 0;
  const enriched = enrichedRes.count ?? 0;

  return {
    total_media: total,
    enriched,
    pending: total - enriched,
  };
}

// ── Insert Event ───────────────────────────────────────────────

export async function insertEvent(event: Omit<EventRow, "timestamp"> & { timestamp?: string }) {
  const supabase = getAdminClient();
  const { error } = await supabase.from("events").insert({
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  });
  if (error) throw error;
}

// ── Insert Enrichment ──────────────────────────────────────────

export async function insertEnrichment(
  eventId: string,
  result: { description: string; objects: string[]; context: string; suggested_tags: string[] },
  userId?: string,
) {
  const supabase = getAdminClient();
  const { error } = await supabase.from("enrichments").insert({
    event_id: eventId,
    description: result.description,
    objects: result.objects,
    context: result.context,
    tags: result.suggested_tags,
    ...(userId ? { user_id: userId } : {}),
  });
  if (error) throw error;
}

// ── Upsert Watched Key ────────────────────────────────────────

export async function upsertWatchedKey(
  s3Key: string,
  eventId: string | null,
  etag: string,
  sizeBytes: number,
  userId?: string,
) {
  const supabase = getAdminClient();
  const { error } = await supabase.from("watched_keys").upsert(
    {
      s3_key: s3Key,
      first_seen: new Date().toISOString(),
      event_id: eventId,
      etag,
      size_bytes: sizeBytes,
      ...(userId ? { user_id: userId } : {}),
    },
    { onConflict: "s3_key", ignoreDuplicates: true }
  );
  if (error) throw error;
}

// ── Get Watched Keys ──────────────────────────────────────────

export async function getWatchedKeys(userId?: string): Promise<Set<string>> {
  const supabase = getAdminClient();
  let query = supabase.from("watched_keys").select("s3_key");
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query;
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.s3_key));
}

// ── Check Duplicate by Hash ───────────────────────────────────

export async function findEventByHash(hash: string, userId?: string): Promise<string | null> {
  const supabase = getUserClient();
  let query = supabase
    .from("events")
    .select("id")
    .eq("type", "create")
    .eq("content_hash", hash);
  if (userId) query = query.eq("user_id", userId);
  const { data } = await query
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

// ── Get Pending Enrichments ───────────────────────────────────

export async function getPendingEnrichments(userId?: string) {
  const supabase = getAdminClient();

  // Get photo events that don't have enrichments
  let photosQuery = supabase
    .from("events")
    .select("id, content_hash, content_type, local_path, remote_path, metadata")
    .eq("type", "create")
    .eq("content_type", "photo")
    .order("timestamp", { ascending: false });
  if (userId) photosQuery = photosQuery.eq("user_id", userId);
  const { data: photos, error: photosErr } = await photosQuery;

  if (photosErr) throw photosErr;

  let enrichedQuery = supabase.from("enrichments").select("event_id");
  if (userId) enrichedQuery = enrichedQuery.eq("user_id", userId);
  const { data: enriched, error: enrichedErr } = await enrichedQuery;

  if (enrichedErr) throw enrichedErr;

  const enrichedIds = new Set((enriched ?? []).map((e) => e.event_id));
  return (photos ?? []).filter((p) => !enrichedIds.has(p.id));
}
