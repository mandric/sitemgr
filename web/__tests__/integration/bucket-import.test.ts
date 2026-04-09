/**
 * Integration tests for `importBucket` — creates s3:put events for S3
 * objects that live in the bucket but have no matching event.
 *
 * Exercises the real Supabase/events + real S3 (local Supabase Storage),
 * no mocks. Asserts the classification reuses scanBucket and that the
 * inserted rows are shaped correctly for `enrich --pending`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAdminClient,
  createTestUser,
  getS3Config,
  TINY_JPEG,
} from "./setup";
import {
  createS3Client,
  uploadS3Object,
} from "../../lib/media/s3";
import {
  importBucket,
  scanBucket,
  type BucketConfig,
} from "../../lib/media/bucket-service";
import { getPendingEnrichments } from "../../lib/media/db";
import { CONTENT_TYPE_PHOTO } from "../../lib/media/constants";

let admin: SupabaseClient;
let userId: string;
let userClient: SupabaseClient;
let s3: ReturnType<typeof createS3Client>;
let bucketName: string;
let bucketConfig: BucketConfig;
const uploadedKeys: string[] = [];

beforeAll(async () => {
  admin = getAdminClient();
  const s3Config = getS3Config();

  const user = await createTestUser();
  userId = user.userId;
  userClient = user.client;

  bucketName = `test-import-${Date.now()}`;
  await admin.storage.createBucket(bucketName, { public: false });

  const { data: bc, error: bcErr } = await admin
    .from("bucket_configs")
    .insert({
      user_id: userId,
      bucket_name: bucketName,
      endpoint_url: s3Config.endpoint,
      access_key_id: s3Config.accessKeyId,
      secret_access_key: s3Config.secretAccessKey,
    })
    .select("*")
    .single();
  if (bcErr || !bc) {
    throw new Error(`Failed to seed bucket_config: ${bcErr?.message ?? "no row"}`);
  }
  // bucket_configs stores secret encrypted; the importBucket helper needs
  // a decrypted config. For tests we bypass encryption and hand-build the
  // BucketConfig shape the service expects.
  bucketConfig = {
    id: bc.id,
    bucket_name: bucketName,
    endpoint_url: s3Config.endpoint,
    region: s3Config.region,
    access_key_id: s3Config.accessKeyId,
    secret_access_key: s3Config.secretAccessKey,
  };

  s3 = createS3Client({
    endpoint: s3Config.endpoint,
    region: s3Config.region,
    accessKeyId: s3Config.accessKeyId,
    secretAccessKey: s3Config.secretAccessKey,
  });
}, 30000);

afterAll(async () => {
  if (uploadedKeys.length > 0) {
    await admin.storage.from(bucketName).remove(uploadedKeys);
  }
  await admin.storage.deleteBucket(bucketName).catch(() => {});

  await admin.from("enrichments").delete().eq("user_id", userId);
  await admin.from("events").delete().eq("user_id", userId);
  await admin.from("bucket_configs").delete().eq("user_id", userId);
  await admin.auth.admin.deleteUser(userId);

  await userClient.auth.signOut();
  await Promise.all([
    admin.removeAllChannels(),
    userClient.removeAllChannels(),
  ]);
});

/**
 * Wipes events between tests so each assertion starts from a known state.
 * S3 objects are left in place — tests decide when to upload.
 */
beforeEach(async () => {
  await admin.from("events").delete().eq("user_id", userId);
});

describe("importBucket — untracked objects", () => {
  it("creates an s3:put event for every untracked object", async () => {
    const prefix = `untracked-${Date.now()}`;
    const keys = [`${prefix}/a.jpg`, `${prefix}/b.jpg`, `${prefix}/c.jpg`];
    for (const key of keys) {
      await uploadS3Object(s3, bucketName, key, TINY_JPEG, "image/jpeg");
      uploadedKeys.push(key);
    }

    const result = await importBucket(admin, s3, bucketConfig, userId, {
      prefix: `${prefix}/`,
    });

    expect(result.bucket).toBe(bucketName);
    expect(result.untracked_count).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.errors).toBe(0);
    expect(result.dry_run).toBe(false);

    // Verify rows landed in the events table with the expected shape
    const { data: events } = await admin
      .from("events")
      .select("*")
      .eq("user_id", userId)
      .eq("bucket_config_id", bucketConfig.id);

    expect(events).toHaveLength(3);
    for (const event of events ?? []) {
      expect(event.op).toBe("s3:put");
      expect(event.content_type).toBe(CONTENT_TYPE_PHOTO);
      expect(event.content_hash).toMatch(/^etag:/);
      expect(event.remote_path).toMatch(new RegExp(`^s3://${bucketName}/${prefix}/`));
      expect(event.metadata).toBeDefined();
      expect((event.metadata as Record<string, unknown>).source).toBe("s3-import");
    }
  });

  it("is idempotent — a second import inserts nothing", async () => {
    const prefix = `idempotent-${Date.now()}`;
    const key = `${prefix}/only.jpg`;
    await uploadS3Object(s3, bucketName, key, TINY_JPEG, "image/jpeg");
    uploadedKeys.push(key);

    const first = await importBucket(admin, s3, bucketConfig, userId, {
      prefix: `${prefix}/`,
    });
    expect(first.imported).toBe(1);

    const second = await importBucket(admin, s3, bucketConfig, userId, {
      prefix: `${prefix}/`,
    });
    expect(second.untracked_count).toBe(0);
    expect(second.imported).toBe(0);

    // Only one event should exist for this key
    const { data: events } = await admin
      .from("events")
      .select("id")
      .eq("user_id", userId)
      .eq("remote_path", `s3://${bucketName}/${key}`);
    expect(events).toHaveLength(1);
  });

  it("respects --prefix and only imports matching objects", async () => {
    const ts = Date.now();
    const fooKeys = [`prefix-foo-${ts}/1.jpg`, `prefix-foo-${ts}/2.jpg`];
    const barKeys = [`prefix-bar-${ts}/1.jpg`, `prefix-bar-${ts}/2.jpg`];
    for (const key of [...fooKeys, ...barKeys]) {
      await uploadS3Object(s3, bucketName, key, TINY_JPEG, "image/jpeg");
      uploadedKeys.push(key);
    }

    const result = await importBucket(admin, s3, bucketConfig, userId, {
      prefix: `prefix-foo-${ts}/`,
    });
    expect(result.imported).toBe(2);

    const { data: events } = await admin
      .from("events")
      .select("remote_path")
      .eq("user_id", userId)
      .eq("bucket_config_id", bucketConfig.id);
    expect(events).toHaveLength(2);
    for (const e of events ?? []) {
      expect(e.remote_path).toContain(`prefix-foo-${ts}/`);
      expect(e.remote_path).not.toContain(`prefix-bar-${ts}/`);
    }
  });
});

describe("importBucket — dry run", () => {
  it("dry_run returns counts without writing", async () => {
    const prefix = `dryrun-${Date.now()}`;
    const keys = [`${prefix}/a.jpg`, `${prefix}/b.jpg`];
    for (const key of keys) {
      await uploadS3Object(s3, bucketName, key, TINY_JPEG, "image/jpeg");
      uploadedKeys.push(key);
    }

    const result = await importBucket(admin, s3, bucketConfig, userId, {
      prefix: `${prefix}/`,
      dry_run: true,
    });

    expect(result.untracked_count).toBe(2);
    expect(result.imported).toBe(0);
    expect(result.dry_run).toBe(true);

    const { data: events } = await admin
      .from("events")
      .select("id")
      .eq("user_id", userId)
      .eq("bucket_config_id", bucketConfig.id);
    expect(events ?? []).toHaveLength(0);
  });
});

describe("importBucket — modified objects", () => {
  it("does not import modified objects (only untracked)", async () => {
    const prefix = `modified-${Date.now()}`;
    const key = `${prefix}/stable.jpg`;
    await uploadS3Object(s3, bucketName, key, TINY_JPEG, "image/jpeg");
    uploadedKeys.push(key);

    // Seed an event with an intentionally wrong etag so scan classifies the
    // object as `modified` (S3 ETag differs from the recorded hash).
    await admin.from("events").insert({
      id: `mod-test-${Date.now()}`,
      timestamp: new Date().toISOString(),
      device_id: "test",
      op: "s3:put",
      content_type: CONTENT_TYPE_PHOTO,
      content_hash: "etag:stale-hash-that-wont-match",
      remote_path: `s3://${bucketName}/${key}`,
      metadata: { source: "test" },
      bucket_config_id: bucketConfig.id,
      user_id: userId,
    });

    // Sanity check: scan sees it as modified
    const scan = await scanBucket(admin, s3, bucketConfig, userId, {
      prefix: `${prefix}/`,
    });
    expect(scan.modified_count).toBe(1);
    expect(scan.untracked_count).toBe(0);

    const result = await importBucket(admin, s3, bucketConfig, userId, {
      prefix: `${prefix}/`,
    });
    expect(result.untracked_count).toBe(0);
    expect(result.imported).toBe(0);

    // Still only the original stale event
    const { data: events } = await admin
      .from("events")
      .select("content_hash")
      .eq("user_id", userId)
      .eq("remote_path", `s3://${bucketName}/${key}`);
    expect(events).toHaveLength(1);
    expect(events![0].content_hash).toBe("etag:stale-hash-that-wont-match");
  });
});

describe("importBucket — edge cases", () => {
  it("batch_size: 0 is clamped to 1 (no infinite loop)", async () => {
    const prefix = `edge-batch-${Date.now()}`;
    const key = `${prefix}/zero.jpg`;
    await uploadS3Object(s3, bucketName, key, TINY_JPEG, "image/jpeg");
    uploadedKeys.push(key);

    const result = await importBucket(admin, s3, bucketConfig, userId, {
      prefix: `${prefix}/`,
      batch_size: 0,
    });

    expect(result.imported).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("concurrency: 0 is clamped to 1 (no deadlock)", async () => {
    const prefix = `edge-conc-${Date.now()}`;
    const key = `${prefix}/zero.jpg`;
    await uploadS3Object(s3, bucketName, key, TINY_JPEG, "image/jpeg");
    uploadedKeys.push(key);

    const result = await importBucket(admin, s3, bucketConfig, userId, {
      prefix: `${prefix}/`,
      concurrency: 0,
    });

    expect(result.imported).toBe(1);
    expect(result.errors).toBe(0);
  });
});

describe("importBucket — enrich compatibility", () => {
  it("imported image events appear in getPendingEnrichments", async () => {
    const prefix = `enrich-compat-${Date.now()}`;
    const key = `${prefix}/photo.jpg`;
    await uploadS3Object(s3, bucketName, key, TINY_JPEG, "image/jpeg");
    uploadedKeys.push(key);

    await importBucket(admin, s3, bucketConfig, userId, {
      prefix: `${prefix}/`,
    });

    const { data: pending, error } = await getPendingEnrichments(admin, userId);
    expect(error).toBeNull();
    const match = (pending ?? []).find(
      (p) => p.remote_path === `s3://${bucketName}/${key}`,
    );
    expect(match).toBeDefined();
    expect(match!.content_type).toBe(CONTENT_TYPE_PHOTO);
  });
});
