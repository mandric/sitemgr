/**
 * Database operations for the media event store (Supabase Postgres)
 *
 * All functions return Supabase's { data, error } shape as-is.
 * Callers decide how to handle errors — the db layer's job is
 * query encapsulation and retry on writes.
 *
 * Client factories are parameterized — callers provide config explicitly.
 * This module has zero dependency on cli-auth.
 */

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { createLogger, LogComponent } from "@/lib/logger";
import { withRetry } from "@/lib/retry";
import { CONTENT_TYPE_PHOTO } from "@/lib/media/constants";

const logger = createLogger(LogComponent.DB);

// ── Config types ──────────────────────────────────────────────

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

export interface SupabaseUserConfig {
  url: string;
  anonKey: string;
}

// ── Retry support ──────────────────────────────────────────────

const NON_RETRYABLE_CODES = new Set(["23505", "23503", "42501", "PGRST301", "PGRST302"]);

function shouldRetryDbError(error: unknown): boolean {
  const code = (error as Record<string, unknown>)?.code as string | undefined;
  if (code && NON_RETRYABLE_CODES.has(code)) return false;
  return true;
}

/**
 * Adapt withRetry for Supabase's { data, error } pattern.
 * Retries when error is present and retryable; returns { data, error } in all cases.
 */
async function withRetryDb<T>(
  fn: () => Promise<{ data: T; error: unknown }>,
): Promise<{ data: T; error: unknown }> {
  try {
    return await withRetry(async () => {
      const result = await fn();
      if (result.error) throw result.error;
      return result;
    }, { shouldRetry: shouldRetryDbError });
  } catch (error) {
    return { data: null as T, error };
  }
}

// ── Clients ────────────────────────────────────────────────────

/** Creates a Supabase client with the service role key (bypasses RLS). */
export function getAdminClient(config: SupabaseConfig) {
  if (!config.url) throw new Error("url is required for admin client");
  if (!config.serviceKey) throw new Error("serviceKey is required for admin client");
  return createSupabaseClient(config.url, config.serviceKey);
}

/** Creates a Supabase client with the publishable/anon key (respects RLS). */
export function getUserClient(config: SupabaseUserConfig) {
  if (!config.url) throw new Error("url is required for user client");
  if (!config.anonKey) throw new Error("anonKey is required for user client");
  return createSupabaseClient(config.url, config.anonKey);
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

export async function queryEvents(client: SupabaseClient, opts: QueryOptions) {
  const start = Date.now();

  // Empty search guard
  if (opts.search !== undefined && opts.search.trim() === "") {
    logger.info("queryEvents", {
      has_search: true,
      result_count: 0,
      duration_ms: Date.now() - start,
    });
    return { data: [], count: 0, error: null };
  }

  // Full-text search via RPC
  if (opts.search) {
    const { data, error } = await client.rpc("search_events", {
      p_user_id: opts.userId,
      query_text: opts.search,
      content_type_filter: opts.type ?? null,
      since_filter: opts.since ?? null,
      until_filter: opts.until ?? null,
      result_limit: Math.min(opts.limit ?? 20, 100),
    });

    logger.info("queryEvents", {
      has_search: true,
      result_count: (data ?? []).length,
      duration_ms: Date.now() - start,
    });
    return { data: data ?? [], count: (data ?? []).length, error };
  }

  // Standard query with joined enrichments (no N+1)
  const effectiveLimit = Math.min(opts.limit ?? 20, 100);
  let query = client
    .from("events")
    .select("*, enrichments(description, objects, context, tags)", { count: "exact" })
    .eq("type", "create")
    .order("timestamp", { ascending: false })
    .range(opts.offset ?? 0, (opts.offset ?? 0) + effectiveLimit - 1);

  if (opts.userId) query = query.eq("user_id", opts.userId);
  if (opts.type) query = query.eq("content_type", opts.type);
  if (opts.since) query = query.gte("timestamp", opts.since);
  if (opts.until) query = query.lte("timestamp", opts.until);
  if (opts.device) query = query.eq("device_id", opts.device);

  const { data, count, error } = await query;

  // Normalize enrichments join → single "enrichment" property.
  // PostgREST returns an object (one-to-one) or array (one-to-many)
  // depending on FK uniqueness. Handle both.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events = (data ?? []).map((evt: any) => {
    const e = evt.enrichments;
    if (Array.isArray(e) && e.length > 0) {
      evt.enrichment = e[0];
    } else if (e && typeof e === "object" && !Array.isArray(e)) {
      evt.enrichment = e;
    }
    delete evt.enrichments;
    return evt;
  });

  logger.info("queryEvents", {
    has_search: false,
    result_count: events.length,
    duration_ms: Date.now() - start,
  });

  return { data: events, count: count ?? events.length, error };
}

// ── Show ───────────────────────────────────────────────────────

export async function showEvent(client: SupabaseClient, eventId: string, userId?: string) {
  let query = client
    .from("events")
    .select("*, enrichments(description, objects, context, tags)")
    .eq("id", eventId);
  if (userId) query = query.eq("user_id", userId);

  const { data: event, error } = await query.maybeSingle();
  if (error || !event) return { data: event, error };

  // Normalize enrichments join → single "enrichment" property
  const e = event.enrichments;
  if (Array.isArray(e) && e.length > 0) {
    event.enrichment = e[0];
  } else if (e && typeof e === "object" && !Array.isArray(e)) {
    event.enrichment = e;
  }
  delete event.enrichments;

  return { data: event, error };
}

// ── Stats ──────────────────────────────────────────────────────

export async function getStats(client: SupabaseClient, opts?: { userId?: string; deviceId?: string }) {
  const userId = opts?.userId;

  let eventsQuery = client.from("events").select("*", { count: "exact", head: true });
  let enrichmentsQuery = client.from("enrichments").select("*", { count: "exact", head: true });
  let watchedQuery = client.from("watched_keys").select("*", { count: "exact", head: true });

  if (userId) {
    eventsQuery = eventsQuery.eq("user_id", userId);
    enrichmentsQuery = enrichmentsQuery.eq("user_id", userId);
    watchedQuery = watchedQuery.eq("user_id", userId);
  }

  const [byContentType, byEventType, totalRes, enrichedRes, watchedRes] =
    await Promise.all([
      client.rpc("stats_by_content_type", { p_user_id: userId }),
      client.rpc("stats_by_event_type", { p_user_id: userId }),
      eventsQuery,
      enrichmentsQuery,
      watchedQuery,
    ]);

  // Return first error if any sub-query failed
  const firstError = [byContentType, byEventType, totalRes, enrichedRes, watchedRes]
    .find(r => r.error)?.error ?? null;
  if (firstError) {
    return { data: null, error: firstError };
  }

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

  // Count "photo" content type as media for pending enrichment calculation
  const photoCount = contentTypeCounts[CONTENT_TYPE_PHOTO] ?? 0;

  return {
    data: {
      total_events: total,
      by_content_type: contentTypeCounts,
      by_event_type: eventTypeCounts,
      watched_s3_keys: watched,
      enriched,
      pending_enrichment: Math.max(0, photoCount - enriched),
      device_id: opts?.deviceId ?? "default",
    },
    error: null,
  };
}

// ── Enrich Status ──────────────────────────────────────────────

export async function getEnrichStatus(client: SupabaseClient, userId?: string, contentType = CONTENT_TYPE_PHOTO) {
  let eventsQuery = client
    .from("events")
    .select("*", { count: "exact", head: true })
    .eq("type", "create")
    .eq("content_type", contentType);
  let enrichmentsQuery = client
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

  const firstError = [totalRes, enrichedRes].find(r => r.error)?.error ?? null;
  if (firstError) {
    return { data: null, error: firstError };
  }

  const total = totalRes.count ?? 0;
  const enriched = enrichedRes.count ?? 0;

  return {
    data: {
      total_media: total,
      enriched,
      pending: Math.max(0, total - enriched),
    },
    error: null,
  };
}

// ── Insert Event ───────────────────────────────────────────────

export async function insertEvent(client: SupabaseClient, event: Omit<EventRow, "timestamp"> & { timestamp?: string }) {
  const result = await withRetryDb(async () => {
    return client.from("events").insert({
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    });
  });

  if (!result.error) {
    logger.debug("insertEvent", { event_id: event.id, content_type: event.content_type });
  }

  return result;
}

// ── Insert Enrichment ──────────────────────────────────────────

export async function insertEnrichment(
  client: SupabaseClient,
  eventId: string,
  result: { description: string; objects: string[]; context: string; suggested_tags: string[] },
  userId?: string,
) {
  const dbResult = await withRetryDb(async () => {
    return client.from("enrichments").insert({
      event_id: eventId,
      description: result.description,
      objects: result.objects,
      context: result.context,
      tags: result.suggested_tags,
      ...(userId ? { user_id: userId } : {}),
    });
  });

  if (!dbResult.error) {
    logger.debug("insertEnrichment", { event_id: eventId });
  }

  return dbResult;
}

// ── Upsert Watched Key ────────────────────────────────────────

export async function upsertWatchedKey(
  client: SupabaseClient,
  s3Key: string,
  eventId: string | null,
  etag: string,
  sizeBytes: number,
  userId?: string,
  bucketConfigId?: string,
) {
  const result = await withRetryDb(async () => {
    return client.from("watched_keys").upsert(
      {
        s3_key: s3Key,
        first_seen: new Date().toISOString(),
        event_id: eventId,
        etag,
        size_bytes: sizeBytes,
        ...(userId ? { user_id: userId } : {}),
        ...(bucketConfigId !== undefined ? { bucket_config_id: bucketConfigId } : {}),
      },
      { onConflict: "s3_key" },
    );
  });

  if (!result.error) {
    logger.debug("upsertWatchedKey", { s3_key: s3Key, etag });
  }

  return result;
}

// ── Get Watched Keys ──────────────────────────────────────────

export async function getWatchedKeys(client: SupabaseClient, userId?: string) {
  let query = client.from("watched_keys").select("s3_key");
  if (userId) query = query.eq("user_id", userId);
  return query;
}

// ── Check Duplicate by Hash ───────────────────────────────────

export async function findEventByHash(client: SupabaseClient, hash: string, userId?: string) {
  let query = client
    .from("events")
    .select("id")
    .eq("type", "create")
    .eq("content_hash", hash);
  if (userId) query = query.eq("user_id", userId);
  return query
    .limit(1)
    .maybeSingle();
}

// ── Get Pending Enrichments ───────────────────────────────────

export async function getPendingEnrichments(client: SupabaseClient, userId?: string) {
  let photosQuery = client
    .from("events")
    .select("id, content_hash, content_type, local_path, remote_path, metadata")
    .eq("type", "create")
    .eq("content_type", CONTENT_TYPE_PHOTO)
    .order("timestamp", { ascending: false });
  if (userId) photosQuery = photosQuery.eq("user_id", userId);
  const { data: photos, error: photosErr } = await photosQuery;

  if (photosErr) return { data: null, error: photosErr };

  let enrichedQuery = client.from("enrichments").select("event_id");
  if (userId) enrichedQuery = enrichedQuery.eq("user_id", userId);
  const { data: enriched, error: enrichedErr } = await enrichedQuery;

  if (enrichedErr) return { data: null, error: enrichedErr };

  const enrichedIds = new Set((enriched ?? []).map((e) => e.event_id));
  return { data: (photos ?? []).filter((p) => !enrichedIds.has(p.id)), error: null };
}

// ── Model Config ──────────────────────────────────────────────

export interface ModelConfigRow {
  id: string;
  user_id: string;
  provider: string;
  base_url: string | null;
  model: string;
  api_key_encrypted: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export async function getModelConfig(client: SupabaseClient, userId: string, provider?: string) {
  let query = client
    .from("model_configs")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (provider) query = query.eq("provider", provider);

  return await query.maybeSingle();
}
