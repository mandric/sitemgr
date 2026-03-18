import { describe, it } from "vitest";

describe("RLS audit acceptance criteria", () => {
  // ── Finding 1: Service role key bypass ──────────────────────────
  describe("client key separation (Finding 1)", () => {
    it.todo("getAdminClient() uses service role key");
    it.todo("getUserClient() uses publishable key with auth context");
    it.todo(
      "queryEvents called via getUserClient returns only that user's events"
    );
    it.todo(
      "queryEvents called via getAdminClient returns all events (for background jobs)"
    );
  });

  // ── Finding 5: anon user blocking ──────────────────────────────
  describe("anon user blocking (Finding 5)", () => {
    it.todo("anon user cannot SELECT from events table");
    it.todo("anon user cannot SELECT from bucket_configs table");
    it.todo("anon user cannot SELECT from enrichments table");
    it.todo("anon user cannot SELECT from watched_keys table");
    it.todo("anon user cannot SELECT from conversations table");
    it.todo("anon user cannot SELECT from user_profiles table");

    it.todo("anon user cannot INSERT into events table");
    it.todo("anon user cannot INSERT into bucket_configs table");
    it.todo("anon user cannot INSERT into enrichments table");
    it.todo("anon user cannot INSERT into watched_keys table");
    it.todo("anon user cannot INSERT into conversations table");
    it.todo("anon user cannot INSERT into user_profiles table");
  });

  // ── Finding 3 & general: cross-tenant isolation ────────────────
  describe("cross-tenant isolation (Findings 1, 3)", () => {
    it.todo("user A cannot SELECT user B's events");
    it.todo("user A cannot SELECT user B's bucket_configs");
    it.todo("user A cannot SELECT user B's enrichments");
    it.todo("user A cannot SELECT user B's watched_keys");
    it.todo("user A cannot SELECT user B's conversations");
    it.todo("user A cannot SELECT user B's user_profiles");

    it.todo("user A cannot INSERT event with user B's user_id");
    it.todo("user A cannot UPDATE user B's events");
    it.todo("user A cannot DELETE user B's bucket_configs");
  });

  // ── Finding 4: NULL user_id / phone_number edge cases ──────────
  describe("NULL auth column edge cases (Finding 4)", () => {
    it.todo(
      "NULL user_id + NULL phone_number does not grant universal access on bucket_configs"
    );
    it.todo(
      "phone_number auth path grants access to matching records only on bucket_configs"
    );
    it.todo(
      "user with matching phone claim cannot access bucket_config that has a non-NULL user_id belonging to another user"
    );
  });

  // ── Finding 2: get_user_id_from_phone() info disclosure ────────
  describe("SECURITY DEFINER function restrictions (Finding 2)", () => {
    it.todo("get_user_id_from_phone() is not callable by anon role");
    it.todo(
      "get_user_id_from_phone() is not callable by authenticated user for arbitrary phone numbers"
    );
    it.todo(
      "get_user_id_from_phone() restricted to service_role or private schema only"
    );
  });

  // ── Finding 3: RPC function user isolation ─────────────────────
  describe("RPC function user isolation (Finding 3)", () => {
    it.todo(
      "search_events() returns only the calling user's events when called with user JWT"
    );
    it.todo(
      "stats_by_content_type() returns only the calling user's stats when called with user JWT"
    );
    it.todo(
      "stats_by_event_type() returns only the calling user's stats when called with user JWT"
    );
  });

  // ── Finding 7: policy structure ────────────────────────────────
  describe("policy structure (Finding 7)", () => {
    it.todo(
      "watched_keys does not have redundant SELECT + ALL policies after cleanup"
    );
    it.todo(
      "enrichments does not have redundant SELECT + ALL policies after cleanup"
    );
    it.todo(
      "conversations does not have redundant SELECT + ALL policies after cleanup"
    );
  });

  // ── Finding 9: events append-only enforcement ──────────────────
  describe("events table append-only (Finding 9)", () => {
    it.todo("authenticated user cannot UPDATE own events");
    it.todo("authenticated user cannot DELETE own events");
  });
});
