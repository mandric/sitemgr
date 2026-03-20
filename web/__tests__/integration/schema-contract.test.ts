/**
 * Schema contract tests — validates database schema matches application expectations.
 * Uses the schema_info() RPC function (section-01 migration).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getAdminClient } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

interface SchemaInfo {
  tables: Array<{ table_name: string; has_rls: boolean }>;
  columns: Array<{
    table_name: string;
    column_name: string;
    is_nullable: boolean;
    data_type: string;
  }>;
  indexes: Array<{ index_name: string; table_name: string }>;
  functions: Array<{
    function_name: string;
    argument_types: string;
    return_type: string;
  }>;
  policies: Array<{
    table_name: string;
    policy_name: string;
    command: string;
    roles: string[];
  }>;
}

let admin: SupabaseClient;
let schema: SchemaInfo;

beforeAll(async () => {
  admin = getAdminClient();
  const { data, error } = await admin.rpc("schema_info");
  if (error) {
    throw new Error(
      `schema_info() RPC failed — migration may not be applied: ${error.message}`,
    );
  }
  schema = data as SchemaInfo;
});

function columnsFor(table: string) {
  return schema.columns.filter((c) => c.table_name === table);
}

function columnNames(table: string) {
  return columnsFor(table).map((c) => c.column_name);
}

describe("database tables", () => {
  it("should have all expected application tables", () => {
    const tableNames = schema.tables.map((t) => t.table_name);
    for (const expected of [
      "events",
      "enrichments",
      "watched_keys",
      "bucket_configs",
      "conversations",
      "user_profiles",
    ]) {
      expect(tableNames).toContain(expected);
    }
  });
});

describe("table columns", () => {
  describe("events", () => {
    it("should have all expected columns", () => {
      const cols = columnNames("events");
      for (const expected of [
        "id",
        "timestamp",
        "device_id",
        "type",
        "content_type",
        "content_hash",
        "local_path",
        "remote_path",
        "metadata",
        "parent_id",
        "user_id",
      ]) {
        expect(cols).toContain(expected);
      }
    });

    it("should have user_id as NOT NULL", () => {
      const col = columnsFor("events").find(
        (c) => c.column_name === "user_id",
      );
      expect(col).toBeDefined();
      expect(col!.is_nullable).toBe(false);
    });
  });

  describe("bucket_configs", () => {
    it("should have all expected columns", () => {
      const cols = columnNames("bucket_configs");
      for (const expected of [
        "user_id",
        "bucket_name",
        "endpoint_url",
        "access_key_id",
        "secret_access_key",
        "encryption_key_version",
      ]) {
        expect(cols).toContain(expected);
      }
    });

    it("should NOT have phone_number column", () => {
      const cols = columnNames("bucket_configs");
      expect(cols).not.toContain("phone_number");
    });

    it("should have user_id as NOT NULL", () => {
      const col = columnsFor("bucket_configs").find(
        (c) => c.column_name === "user_id",
      );
      expect(col).toBeDefined();
      expect(col!.is_nullable).toBe(false);
    });
  });

  describe("enrichments", () => {
    it("should have all expected columns", () => {
      const cols = columnNames("enrichments");
      for (const expected of [
        "event_id",
        "description",
        "objects",
        "context",
        "tags",
        "fts",
        "user_id",
      ]) {
        expect(cols).toContain(expected);
      }
    });

    it("should have user_id as NOT NULL", () => {
      const col = columnsFor("enrichments").find(
        (c) => c.column_name === "user_id",
      );
      expect(col).toBeDefined();
      expect(col!.is_nullable).toBe(false);
    });
  });

  describe("watched_keys", () => {
    it("should have all expected columns", () => {
      const cols = columnNames("watched_keys");
      for (const expected of [
        "s3_key",
        "first_seen",
        "event_id",
        "etag",
        "size_bytes",
        "user_id",
      ]) {
        expect(cols).toContain(expected);
      }
    });

    it("should have user_id as NOT NULL", () => {
      const col = columnsFor("watched_keys").find(
        (c) => c.column_name === "user_id",
      );
      expect(col).toBeDefined();
      expect(col!.is_nullable).toBe(false);
    });
  });

  describe("conversations", () => {
    it("should have user_id as NOT NULL", () => {
      const col = columnsFor("conversations").find(
        (c) => c.column_name === "user_id",
      );
      expect(col).toBeDefined();
      expect(col!.is_nullable).toBe(false);
    });

    it("should still have phone_number as a nullable column", () => {
      const col = columnsFor("conversations").find(
        (c) => c.column_name === "phone_number",
      );
      expect(col).toBeDefined();
      expect(col!.is_nullable).toBe(true);
    });
  });

  describe("user_profiles", () => {
    it("should have expected columns", () => {
      const cols = columnNames("user_profiles");
      for (const expected of ["id", "phone_number"]) {
        expect(cols).toContain(expected);
      }
    });
  });
});

describe("database indexes", () => {
  it("should have FTS index on enrichments", () => {
    const indexNames = schema.indexes.map((i) => i.index_name);
    expect(indexNames).toContain("idx_enrichments_fts");
  });

  it("should have user_id index on events", () => {
    const indexNames = schema.indexes.map((i) => i.index_name);
    expect(indexNames).toContain("idx_events_user_id");
  });

  it("should have timestamp index on events", () => {
    const indexNames = schema.indexes.map((i) => i.index_name);
    expect(indexNames).toContain("idx_events_timestamp");
  });

  it("should have unique user_bucket index on bucket_configs", () => {
    const indexNames = schema.indexes.map((i) => i.index_name);
    expect(indexNames).toContain("idx_bucket_configs_user_bucket");
  });

  it("should have user_id index on watched_keys", () => {
    const indexNames = schema.indexes.map((i) => i.index_name);
    expect(indexNames).toContain("idx_watched_keys_user_id");
  });
});

describe("row level security", () => {
  it("should be enabled on all user-data tables", () => {
    const rlsTables = [
      "events",
      "enrichments",
      "watched_keys",
      "bucket_configs",
      "conversations",
      "user_profiles",
    ];
    for (const tableName of rlsTables) {
      const table = schema.tables.find((t) => t.table_name === tableName);
      expect(table, `${tableName} should exist`).toBeDefined();
      expect(table!.has_rls, `${tableName} should have RLS enabled`).toBe(
        true,
      );
    }
  });
});

describe("NOT NULL constraints", () => {
  it("should reject events with null user_id", async () => {
    const { error } = await admin.from("events").insert({
      id: "null-test-evt",
      timestamp: new Date().toISOString(),
      device_id: "test",
      type: "photo",
      user_id: null,
    });
    expect(error).not.toBeNull();
  });

  it("should reject enrichments with null user_id", async () => {
    const { error } = await admin.from("enrichments").insert({
      event_id: "nonexistent-evt",
      user_id: null,
    });
    expect(error).not.toBeNull();
  });

  it("should reject watched_keys with null user_id", async () => {
    const { error } = await admin.from("watched_keys").insert({
      s3_key: "null-test-key",
      first_seen: new Date().toISOString(),
      user_id: null,
    });
    expect(error).not.toBeNull();
  });

  it("should reject bucket_configs with null user_id", async () => {
    const { error } = await admin.from("bucket_configs").insert({
      bucket_name: "null-test",
      endpoint_url: "http://localhost",
      access_key_id: "x",
      secret_access_key: "x",
      user_id: null,
    });
    expect(error).not.toBeNull();
  });
});

describe("RPC functions", () => {
  it("should have search_events", () => {
    const fns = schema.functions.map((f) => f.function_name);
    expect(fns).toContain("search_events");
  });

  it("should have stats_by_content_type", () => {
    const fns = schema.functions.map((f) => f.function_name);
    expect(fns).toContain("stats_by_content_type");
  });

  it("should have stats_by_event_type", () => {
    const fns = schema.functions.map((f) => f.function_name);
    expect(fns).toContain("stats_by_event_type");
  });

  it("should have get_user_id_from_phone", () => {
    const fns = schema.functions.map((f) => f.function_name);
    expect(fns).toContain("get_user_id_from_phone");
  });

  it("should have schema_info", () => {
    const fns = schema.functions.map((f) => f.function_name);
    expect(fns).toContain("schema_info");
  });
});

describe("RLS policy structure", () => {
  it("should not have redundant SELECT + ALL policies on watched_keys", () => {
    const wkPolicies = schema.policies.filter(
      (p) => p.table_name === "watched_keys",
    );
    const commands = wkPolicies.map((p) => p.command);
    if (commands.includes("ALL")) {
      expect(commands).not.toContain("SELECT");
    }
  });

  it("should not have redundant SELECT + ALL policies on enrichments", () => {
    const policies = schema.policies.filter(
      (p) => p.table_name === "enrichments",
    );
    const commands = policies.map((p) => p.command);
    if (commands.includes("ALL")) {
      expect(commands).not.toContain("SELECT");
    }
  });

  it("should not have redundant SELECT + ALL policies on conversations", () => {
    const policies = schema.policies.filter(
      (p) => p.table_name === "conversations",
    );
    const commands = policies.map((p) => p.command);
    if (commands.includes("ALL")) {
      expect(commands).not.toContain("SELECT");
    }
  });
});
