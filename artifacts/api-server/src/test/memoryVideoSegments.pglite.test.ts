import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { videoSegmentReplySchema } from "../services/memory/memoryVideoSegments.js";

const modulePath = process.env.MEMORY_VIDEO_SEGMENTS_PGLITE_MODULE ?? process.env.DISCOVERY_PGLITE_MODULE;
const migration = readFileSync(new URL("../migrations/3991_memory_video_segments.sql", import.meta.url), "utf8");
const canonicalMigration = readFileSync(new URL("../migrations/3320_media_canonical_contract_constraints.sql", import.meta.url), "utf8");
const versionTrigger = canonicalMigration.slice(canonicalMigration.indexOf("CREATE OR REPLACE FUNCTION public.media_assets_bump_version()"), canonicalMigration.indexOf("-- ── Postconditions"));
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMORY = "10000000-0000-4000-8000-000000000001";
const ITEM = "20000000-0000-4000-8000-000000000001";
const ASSET = "30000000-0000-4000-8000-000000000001";
const SEGMENT = "40000000-0000-4000-8000-000000000001";
const SOURCE = { assetId: ASSET, assetVersion: 3, durationMs: 4000, storageBucket: "post-media", storagePath: `${OWNER}/original.mp4`, itemMediaUrl: `post-media/${OWNER}/original.mp4` };
const SEGMENT_INPUT = { operationId: SEGMENT, assetId: ASSET, assetVersion: 3, startMs: 1000, endMs: 2500, label: "First turn" };
const COMMAND = { contractVersion: 1, ownerId: OWNER, memoryId: MEMORY, itemId: ITEM, source: SOURCE };

interface Database {
  exec(sql: string): Promise<unknown>;
  query<Row = Record<string, any>>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[] }>;
  close(): Promise<void>;
}

describe("3991 executable isolated SQL contract", { skip: !modulePath, concurrency: 1 }, () => {
  let database: Database;

  async function execute(command: Record<string, unknown>) {
    await database.exec("SET ROLE service_role");
    try {
      const result = await database.query("SELECT public.memory_video_segments_execute($1::jsonb) AS result", [JSON.stringify(command)]);
      return result.rows[0].result;
    } finally { await database.exec("RESET ROLE"); }
  }

  async function count(table: "memory_video_segments" | "memory_video_segment_operations" | "media_assets" | "memory_items") {
    return Number((await database.query(`SELECT count(*) AS count FROM public.${table}`)).rows[0].count);
  }

  const create = (segment = SEGMENT_INPUT) => execute({ ...COMMAND, operation: "create", segment });
  const list = () => execute({ ...COMMAND, operation: "list" });

  before(async () => {
    const runtime = await import(pathToFileURL(modulePath!).href);
    database = new runtime.PGlite() as Database;
    await database.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE TABLE public.feature_flags (flag text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text);
      INSERT INTO public.feature_flags (flag, enabled) VALUES ('memory_kernel_enabled', true);
      CREATE TABLE public.memories (id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, state text, caption text);
      CREATE TABLE public.memory_items (id uuid PRIMARY KEY, memory_id uuid NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE, media_url text, caption text);
      CREATE TABLE public.media_assets (
        id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        storage_bucket text NOT NULL, storage_path text NOT NULL, media_type text NOT NULL,
        version integer NOT NULL DEFAULT 1, duration_ms integer, processing_status text, moderation_status text, deleted_at timestamptz,
        UNIQUE (storage_bucket, storage_path)
      );
    `);
    await database.exec(versionTrigger);
    await assert.rejects(database.query("SELECT public.memory_video_segments_execute('{}'::jsonb)"), (error: any) => error.code === "42883");
    await database.exec(migration);
    assert.equal((await database.query("SELECT enabled FROM public.feature_flags WHERE flag = 'memory_video_segments_enabled'")).rows[0].enabled, false);
  });

  beforeEach(async () => {
    await database.exec(versionTrigger);
    await database.exec(migration);
    await database.exec("TRUNCATE auth.users CASCADE; UPDATE public.feature_flags SET enabled = true;");
    await database.query("INSERT INTO auth.users VALUES ($1), ($2)", [OWNER, OTHER]);
    await database.query("INSERT INTO public.memories (id, owner_id, state) VALUES ($1, $2, 'published')", [MEMORY, OWNER]);
    await database.query("INSERT INTO public.memory_items (id, memory_id, media_url) VALUES ($1, $2, $3)", [ITEM, MEMORY, SOURCE.itemMediaUrl]);
    await database.query("INSERT INTO public.media_assets (id, owner_user_id, storage_bucket, storage_path, media_type, version, duration_ms, processing_status, moderation_status) VALUES ($1, $2, 'post-media', $3, 'video', 3, 4000, 'ready', 'active')", [ASSET, OWNER, SOURCE.storagePath]);
  });

  after(async () => { await database?.close(); });

  it("creates, lists, replays and erases references, never copied files or originals", async () => {
    const first = await create();
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.segment.source, "owner_asserted");
    assert.equal(first.segment.assetId, ASSET);
    assert.equal(first.segment.durationMs, 4000);
    assert.equal(videoSegmentReplySchema.safeParse(first).success, true);
    assert.equal((await create()).created, false);
    assert.deepEqual((await list()).segments, [first.segment]);
    assert.equal((await create({ ...SEGMENT_INPUT, label: "Different" })).reason, "idempotency_conflict");
    assert.equal((await execute({ ...COMMAND, operation: "delete", segmentId: SEGMENT })).deleted, true);
    assert.equal((await execute({ ...COMMAND, operation: "delete", segmentId: SEGMENT })).deleted, false);
    assert.equal((await create()).reason, "idempotency_conflict");
    assert.equal(await count("memory_video_segments"), 0);
    assert.equal(await count("memory_video_segment_operations"), 1);
    assert.equal(await count("media_assets"), 1);
    assert.equal(await count("memory_items"), 1);
    assert.equal((await database.query("SELECT version FROM public.media_assets")).rows[0].version, 3);
  });

  it("requires BOTH flags at the transaction boundary and seeds only OFF", async () => {
    for (const flag of ["memory_kernel_enabled", "memory_video_segments_enabled"]) {
      await database.query("UPDATE public.feature_flags SET enabled = false WHERE flag = $1", [flag]);
      assert.equal((await create()).reason, "disabled");
      assert.equal((await list()).reason, "disabled");
      assert.equal((await execute({ ...COMMAND, operation: "delete", segmentId: SEGMENT })).reason, "disabled");
      await database.exec(migration);
      assert.equal((await database.query("SELECT enabled FROM public.feature_flags WHERE flag = $1", [flag])).rows[0].enabled, false);
      await database.query("UPDATE public.feature_flags SET enabled = true WHERE flag = $1", [flag]);
    }
    assert.equal(await count("memory_video_segments"), 0);
  });

  it("records scoped cancellation before CREATE arrives so acknowledged DELETE cannot be undone", async () => {
    assert.equal((await execute({ ...COMMAND, operation: "delete", segmentId: SEGMENT, ownerId: OTHER })).reason, "not_found");
    assert.equal(await count("memory_video_segment_operations"), 0);
    assert.deepEqual(await execute({ ...COMMAND, operation: "delete", segmentId: SEGMENT }), {
      contractVersion: 1, ok: true, operation: "delete", deleted: false,
    });
    assert.equal((await create()).reason, "idempotency_conflict");
    assert.equal(await count("memory_video_segments"), 0);
    assert.equal(await count("memory_video_segment_operations"), 1);
    const receipt = (await database.query("SELECT * FROM public.memory_video_segment_operations WHERE id = $1", [SEGMENT])).rows[0];
    assert.deepEqual(receipt, { id: SEGMENT, memory_id: MEMORY, item_id: ITEM, owner_id: OWNER, asset_id: null });
    assert.equal((await execute({ ...COMMAND, operation: "delete", segmentId: SEGMENT })).deleted, false);
    assert.equal((await create({ ...SEGMENT_INPUT, label: "Delayed replacement" })).reason, "idempotency_conflict");
    await database.exec("DELETE FROM public.memory_items");
    assert.equal(await count("memory_video_segment_operations"), 0);
  });

  it("cannot cancel or rebind another owner's operation ID through an owned item", async () => {
    const otherMemory = "10000000-0000-4000-8000-000000000002";
    const otherItem = "20000000-0000-4000-8000-000000000002";
    await database.query("INSERT INTO public.memories (id, owner_id, state) VALUES ($1, $2, 'published')", [otherMemory, OTHER]);
    await database.query("INSERT INTO public.memory_items (id, memory_id, media_url) VALUES ($1, $2, $3)", [otherItem, otherMemory, SOURCE.itemMediaUrl]);
    assert.equal((await create()).ok, true);
    assert.equal((await execute({ ...COMMAND, operation: "delete", segmentId: SEGMENT, ownerId: OTHER, memoryId: otherMemory, itemId: otherItem })).reason, "not_found");
    assert.equal((await create()).created, false);
    assert.equal((await list()).segments.length, 1);
    assert.equal((await database.query("SELECT owner_id FROM public.memory_video_segment_operations WHERE id = $1", [SEGMENT])).rows[0].owner_id, OWNER);
  });

  it("denies direct table access and RPC execution to all client roles; service has RPC only", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      await database.exec(`SET ROLE ${role}`);
      try {
        await assert.rejects(database.query("SELECT * FROM public.memory_video_segments"), (error: any) => error.code === "42501");
        await assert.rejects(database.query("DELETE FROM public.memory_video_segments"), (error: any) => error.code === "42501");
        await assert.rejects(database.query("SELECT * FROM public.memory_video_segment_operations"), (error: any) => error.code === "42501");
        if (role !== "service_role") {
          await assert.rejects(database.query("SELECT public.memory_video_segments_execute($1::jsonb)", [JSON.stringify({ ...COMMAND, operation: "list" })]), (error: any) => error.code === "42501");
        }
      } finally { await database.exec("RESET ROLE"); }
    }
    assert.equal((await create()).ok, true);
    const policies = await database.query("SELECT policyname FROM pg_policies WHERE tablename IN ('memory_video_segments', 'memory_video_segment_operations')");
    assert.equal(policies.rows.length, 0);
  });

  it("checks actual Memory/item/asset ownership and source revision inside SQL", async () => {
    for (const patch of [{ ownerId: OTHER }, { memoryId: OTHER }, { itemId: OTHER }]) {
      assert.equal((await execute({ ...COMMAND, ...patch, operation: "create", segment: SEGMENT_INPUT })).reason, "not_found");
    }
    for (const patch of [{ assetVersion: 2 }, { durationMs: 999999 }, { storagePath: "another.mp4" }, { itemMediaUrl: "post-media/other.mp4" }]) {
      assert.equal((await execute({ ...COMMAND, source: { ...SOURCE, ...patch }, operation: "create", segment: SEGMENT_INPUT })).reason, "source_changed");
    }
    await database.query("UPDATE public.media_assets SET owner_user_id = $1 WHERE id = $2", [OTHER, ASSET]);
    assert.equal((await create()).reason, "not_found");
    assert.equal(await count("memory_video_segments"), 0);
  });

  it("validates raw RPC bounds and types, rejecting injected recognition or duration", async () => {
    for (const patch of [{ startMs: -1 }, { startMs: 2500 }, { endMs: 4001 }]) {
      assert.equal((await create({ ...SEGMENT_INPUT, ...patch })).reason, "invalid_bounds");
    }
    for (const patch of [{ startMs: "1000" }, { startMs: 1.5 }, { endMs: null }, { endMs: 2147483648 }, { label: {} }, { label: " " }, { label: "x".repeat(161) }, { source: "automatic" }, { durationMs: 999999 }]) {
      assert.equal((await execute({ ...COMMAND, operation: "create", segment: { ...SEGMENT_INPUT, ...patch } })).reason, "invalid_payload", JSON.stringify(patch));
    }
    assert.equal((await create({ ...SEGMENT_INPUT, startMs: 0, endMs: 4000 })).ok, true);
  });

  it("serializes the 100-reference cap per item while allowing replay and removal", async () => {
    for (let position = 0; position < 100; position++) {
      const operationId = `50000000-0000-4000-8000-${String(position).padStart(12, "0")}`;
      assert.equal((await create({ ...SEGMENT_INPUT, operationId })).ok, true);
    }
    assert.equal((await create()).reason, "limit_reached");
    const operationId = "50000000-0000-4000-8000-000000000000";
    assert.equal((await create({ ...SEGMENT_INPUT, operationId })).created, false);
    assert.equal((await list()).segments.length, 100);
    await execute({ ...COMMAND, operation: "delete", segmentId: operationId });
    assert.equal((await create()).ok, true);
    assert.equal(await count("media_assets"), 1);
  });

  for (const change of ["version = version", "duration_ms = 3000", "moderation_status = 'removed'", "processing_status = 'failed'", "deleted_at = now()", "storage_path = 'replacement.mp4'"]) {
    it(`invalidates references on canonical source mutation: ${change}`, async () => {
      assert.equal((await create()).ok, true);
      await database.exec(`UPDATE public.media_assets SET ${change}`);
      assert.equal(await count("memory_video_segments"), 0);
      assert.equal(await count("memory_video_segment_operations"), 1);
      assert.equal((await database.query("SELECT version FROM public.media_assets")).rows[0].version, 4);
      assert.notEqual((await create()).ok, true);
    });
  }

  it("invalidates item retargeting but not unrelated captions; old retries cannot restore references", async () => {
    assert.equal((await create()).ok, true);
    await database.exec("UPDATE public.memory_items SET caption = 'edited'; UPDATE public.memories SET caption = 'edited';");
    assert.equal(await count("memory_video_segments"), 1);
    await database.exec("UPDATE public.memory_items SET media_url = 'post-media/replacement.mp4'");
    assert.equal(await count("memory_video_segments"), 0);
    await database.query("UPDATE public.memory_items SET media_url = $1", [SOURCE.itemMediaUrl]);
    assert.equal((await create()).reason, "idempotency_conflict");
  });

  for (const state of ["deleted", "removed"]) {
    it(`erases references and replay receipts when a Memory becomes ${state}`, async () => {
      assert.equal((await create()).ok, true);
      await database.query("UPDATE public.memories SET state = $1", [state]);
      assert.equal(await count("memory_video_segments"), 0);
      assert.equal(await count("memory_video_segment_operations"), 0);
      assert.equal((await list()).reason, "not_found");
    });
  }

  for (const table of ["media_assets", "memory_items", "memories", "auth.users"]) {
    it(`cascades erasure from ${table}`, async () => {
      assert.equal((await create()).ok, true);
      await database.exec(`DELETE FROM ${table}`);
      assert.equal(await count("memory_video_segments"), 0);
      assert.equal(await count("memory_video_segment_operations"), 0);
    });
  }

  it("refuses runtime activation when lifecycle or RLS enforcement is missing", async () => {
    for (const [table, trigger] of [
      ["media_assets", "media_assets_version_bump"], ["media_assets", "memory_video_segments_asset_invalidation"],
      ["memory_items", "memory_video_segments_item_invalidation"], ["memories", "memory_video_segments_memory_invalidation"],
    ]) {
      await database.exec(`ALTER TABLE public.${table} DISABLE TRIGGER ${trigger}`);
      assert.equal((await create()).reason, "unavailable");
      await database.exec(`ALTER TABLE public.${table} ENABLE TRIGGER ${trigger}`);
    }
    await database.exec("ALTER TABLE public.memory_video_segments DISABLE ROW LEVEL SECURITY");
    assert.equal((await list()).reason, "unavailable");
    assert.equal(await count("memory_video_segments"), 0);
  });

  it("refuses schema installation without canonical asset revision enforcement", async () => {
    await database.exec("ALTER TABLE public.media_assets DISABLE TRIGGER media_assets_version_bump");
    await assert.rejects(database.exec(migration), /3991 requires the 3320 canonical asset revision trigger/);
    await database.exec("ROLLBACK");
    assert.equal((await create()).reason, "unavailable");
  });
});
