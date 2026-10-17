import assert from "node:assert/strict";
import { describe, it } from "node:test";
import http from "node:http";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { _clearTestClient, _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import router from "../routes/memoryVideoSegments.js";
import { createMemoryVideoSegment, deleteMemoryVideoSegment, listMemoryVideoSegments } from "../services/memory/memoryVideoSegmentsService.js";
import { videoSegmentCreateSchema, segmentMatchesSource } from "../services/memory/memoryVideoSegments.js";

export const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const MEMORY = "10000000-0000-4000-8000-000000000001";
export const ITEM = "20000000-0000-4000-8000-000000000001";
export const ASSET = "30000000-0000-4000-8000-000000000001";
export const SEGMENT = "40000000-0000-4000-8000-000000000001";
export const CREATE = { operationId: SEGMENT, assetId: ASSET, assetVersion: 3, startMs: 1000, endMs: 2500, label: "First turn" };
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SCOPE = { ownerId: OWNER, memoryId: MEMORY, itemId: ITEM };
type Row = Record<string, any>;

function fixture() {
  const tables: Record<string, Row[]> = {
    feature_flags: [{ flag: "memory_kernel_enabled", enabled: true }, { flag: "memory_video_segments_enabled", enabled: true }],
    memories: [{ id: MEMORY, owner_id: OWNER, state: "published", visibility: "public" }],
    memory_items: [{ id: ITEM, memory_id: MEMORY, media_url: `post-media/${OWNER}/original.mp4` }],
    media_assets: [{ id: ASSET, owner_user_id: OWNER, storage_bucket: "post-media", storage_path: `${OWNER}/original.mp4`, media_type: "video", version: 3, duration_ms: 4000, deleted_at: null, processing_status: "ready", moderation_status: "active" }],
    profiles: [{ id: OWNER, account_status: "active", user_account_states: [] }, { id: OTHER, account_status: "active", user_account_states: [] }],
    stories: [],
  };
  const segments = new Map<string, Row>();
  const operations = new Set<string>();
  const calls: Row[] = [];
  const faults = { table: "", rpc: false, unavailable: false, malformed: false, before: undefined as (() => void) | undefined, after: undefined as (() => void) | undefined, reply: undefined as Row | undefined };
  const client = {
    auth: { async getUser(token: string) { return { data: { user: { id: token } }, error: null }; } },
    from(table: string) {
      assert.ok(Object.hasOwn(tables, table), `unexpected table ${table}`);
      const filters: Array<(row: Row) => boolean> = [];
      let single = false;
      const result = () => faults.table === table ? { data: null, error: { code: "57014" } }
        : { data: single ? tables[table].filter((row) => filters.every((filter) => filter(row)))[0] ?? null
          : tables[table].filter((row) => filters.every((filter) => filter(row))), error: null };
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) { filters.push((row) => row[column] === value); return query; },
        in(column: string, values: unknown[]) { filters.push((row) => values.includes(row[column])); return query; },
        limit() { return query; },
        async maybeSingle() { single = true; return result(); },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return query;
    },
    async rpc(name: string, args: { p_command: Row }) {
      assert.equal(name, "memory_video_segments_execute");
      const command = args.p_command;
      calls.push(structuredClone(command));
      faults.before?.();
      if (faults.rpc) return { data: null, error: { code: "PGRST202", message: "private SQL details" } };
      if (faults.unavailable) return { data: { contractVersion: 1, ok: false, reason: "unavailable" }, error: null };
      if (faults.malformed) return { data: {}, error: null };
      const base = { contractVersion: 1, ok: true, operation: command.operation };
      let data: Row;
      if (command.operation === "create") {
        const incoming = command.segment;
        const existing = segments.get(incoming.operationId);
        if (operations.has(incoming.operationId) && (!existing || existing.startMs !== incoming.startMs || existing.label !== incoming.label)) {
          data = { contractVersion: 1, ok: false, reason: "idempotency_conflict" };
        } else {
          const segment = existing ?? { ...SCOPE, id: incoming.operationId, assetId: ASSET, assetVersion: 3, durationMs: 4000,
            startMs: incoming.startMs, endMs: incoming.endMs, label: incoming.label, source: "owner_asserted", createdAt: "2026-10-16T12:00:00Z" };
          segments.set(segment.id, segment);
          operations.add(segment.id);
          data = { ...base, segment, created: !existing };
        }
      } else if (command.operation === "list") {
        data = { ...base, segments: [...segments.values()] };
      } else {
        operations.add(command.segmentId);
        data = { ...base, deleted: segments.delete(command.segmentId) };
      }
      faults.after?.();
      return { data: faults.reply ?? data, error: null };
    },
  };
  return { client: client as unknown as SupabaseClient, tables, calls, faults, segments };
}

async function refused(work: Promise<unknown>, reason: string) {
  await assert.rejects(work, (error: unknown) => typeof error === "object" && error !== null && "reason" in error && error.reason === reason);
}

describe("owner-created logical video segments", () => {
  it("accepts bounded integer timestamps, never fabricated recognition or media", () => {
    assert.equal(videoSegmentCreateSchema.safeParse(CREATE).success, true);
    for (const patch of [
      { startMs: -1 }, { startMs: 1.5 }, { startMs: "1" }, { endMs: Infinity },
      { endMs: NaN }, { endMs: 1000 }, { endMs: 0 }, { endMs: 2147483648 },
      { assetVersion: 0 }, { assetVersion: 1.5 }, { durationMs: 900000 },
      { source: "automatic" }, { mediaUrl: "https://example.com/video.mp4" },
      { ownerId: OWNER }, { label: "x".repeat(161) }, { operationId: "not-a-uuid" },
    ]) assert.equal(videoSegmentCreateSchema.safeParse({ ...CREATE, ...patch }).success, false, JSON.stringify(patch));
  });

  it("binds a segment to the exact existing item, asset revision and duration", () => {
    const source = { memoryId: MEMORY, itemId: ITEM, ownerId: OWNER, assetId: ASSET, assetVersion: 3, durationMs: 4000 };
    const segment = { ...source, id: SEGMENT, startMs: 1000, endMs: 2500, label: "First turn", source: "owner_asserted" as const, createdAt: "2026-10-16T12:00:00Z" };
    assert.equal(segmentMatchesSource(segment, source), true);
    for (const patch of [
      { assetVersion: 4 }, { assetId: MEMORY }, { itemId: MEMORY }, { memoryId: ITEM },
      { ownerId: ITEM }, { durationMs: 5000 }, { durationMs: 2000 },
    ]) assert.equal(segmentMatchesSource(segment, { ...source, ...patch }), false);
  });
});

describe("canonical source and persistence boundary", () => {
  it("requires the existing Memory kernel and segment gate without legacy fallback", async () => {
    for (const flag of ["memory_kernel_enabled", "memory_video_segments_enabled"]) {
      const state = fixture();
      state.tables.feature_flags.find((row) => row.flag === flag)!.enabled = false;
      await refused(createMemoryVideoSegment(state.client, SCOPE, CREATE), "disabled");
      await refused(listMemoryVideoSegments(state.client, SCOPE), "disabled");
      await refused(deleteMemoryVideoSegment(state.client, SCOPE, SEGMENT), "disabled");
      state.tables.feature_flags = state.tables.feature_flags.filter((row) => row.flag !== flag);
      await refused(listMemoryVideoSegments(state.client, SCOPE), "disabled");
      assert.equal(state.calls.length, 0);
    }
    const state = fixture();
    state.faults.table = "feature_flags";
    await refused(listMemoryVideoSegments(state.client, SCOPE), "disabled");
    assert.equal(state.calls.length, 0);
  });

  it("creates, replays, lists and deletes a reference without changing or copying originals", async () => {
    const state = fixture();
    const originals = structuredClone(state.tables);
    assert.equal((await createMemoryVideoSegment(state.client, SCOPE, CREATE)).created, true);
    assert.equal((await createMemoryVideoSegment(state.client, SCOPE, CREATE)).created, false);
    const listed = await listMemoryVideoSegments(state.client, SCOPE);
    assert.deepEqual(listed.source, { assetId: ASSET, assetVersion: 3, durationMs: 4000, mediaRef: `post-media/${OWNER}/original.mp4` });
    assert.equal(listed.segments.length, 1);
    assert.ok(!JSON.stringify(listed.segments).includes("original.mp4"));
    assert.ok(!JSON.stringify(listed).includes("https://"));
    assert.equal((await deleteMemoryVideoSegment(state.client, SCOPE, SEGMENT)).deleted, true);
    assert.equal((await deleteMemoryVideoSegment(state.client, SCOPE, SEGMENT)).deleted, false);
    await refused(createMemoryVideoSegment(state.client, SCOPE, CREATE), "idempotency_conflict");
    assert.deepEqual(state.tables, originals);
  });

  it("rejects unauthorized, withdrawn, unready and noncanonical sources before persistence", async () => {
    const mutations: Array<(tables: Record<string, Row[]>) => void> = [
      (tables) => { tables.memories[0].owner_id = OTHER; },
      (tables) => { tables.memories[0].state = "deleted"; },
      (tables) => { tables.memories[0].state = "removed"; },
      (tables) => { tables.memory_items[0].memory_id = OTHER; },
      (tables) => { tables.memory_items[0].media_url = "https://external.invalid/video.mp4"; },
      (tables) => { tables.memory_items[0].media_url = `https://external.invalid/storage/v1/object/public/post-media/${OWNER}/original.mp4`; },
      (tables) => { tables.media_assets[0].owner_user_id = OTHER; },
      (tables) => { tables.media_assets[0].deleted_at = "2026-10-16T12:00:00Z"; },
      (tables) => { tables.media_assets[0].media_type = "image"; },
      (tables) => { tables.media_assets[0].processing_status = "processing"; },
      (tables) => { tables.media_assets[0].moderation_status = "rejected"; },
      (tables) => { tables.media_assets[0].moderation_status = "limited"; },
      (tables) => { tables.media_assets = []; },
      (tables) => { tables.stories = [{ owner_id: OWNER, state: "deleted", media_url: tables.memory_items[0].media_url, deleted_at: "2000-01-01T00:00:00Z", expires_at: "2000-01-01T00:00:00Z" }]; },
    ];
    for (const mutate of mutations) {
      const state = fixture();
      mutate(state.tables);
      await refused(createMemoryVideoSegment(state.client, SCOPE, CREATE), "not_found");
      assert.equal(state.calls.length, 0);
    }
  });

  it("uses only canonical positive duration and revision; refuses unverified legacy rows", async () => {
    for (const duration of [null, undefined, 0, -1, 2.5, "4000", Infinity, NaN]) {
      const state = fixture();
      state.tables.media_assets[0].duration_ms = duration;
      await refused(createMemoryVideoSegment(state.client, SCOPE, CREATE), "unavailable");
      assert.equal(state.calls.length, 0);
    }
    const state = fixture();
    await refused(createMemoryVideoSegment(state.client, SCOPE, { ...CREATE, endMs: 4001 }), "invalid_bounds");
    await refused(createMemoryVideoSegment(state.client, SCOPE, { ...CREATE, assetVersion: 2 }), "source_changed");
    await refused(createMemoryVideoSegment(state.client, SCOPE, { ...CREATE, assetId: OTHER }), "source_changed");
    assert.equal(state.calls.length, 0);
    assert.equal((await createMemoryVideoSegment(state.client, SCOPE, { ...CREATE, startMs: 0, endMs: 4000 })).created, true);
    assert.equal(state.calls[0].source.durationMs, 4000);
    assert.equal(state.calls[0].source.itemMediaUrl, state.tables.memory_items[0].media_url);
  });

  it("rechecks source changes and deletion after the storage round trip", async () => {
    for (const operation of ["list", "create"] as const) {
      for (const mutation of ["revision", "duration", "path", "memory", "item", "asset"]) {
        const state = fixture();
        state.faults.after = () => {
          if (mutation === "revision") state.tables.media_assets[0].version++;
          if (mutation === "duration") state.tables.media_assets[0].duration_ms++;
          if (mutation === "path") state.tables.memory_items[0].media_url = "post-media/other.mp4";
          if (mutation === "memory") state.tables.memories[0].state = "deleted";
          if (mutation === "item") state.tables.memory_items = [];
          if (mutation === "asset") state.tables.media_assets[0].deleted_at = "2026-10-16T00:00:00Z";
        };
        await refused(operation === "list" ? listMemoryVideoSegments(state.client, SCOPE)
          : createMemoryVideoSegment(state.client, SCOPE, CREATE), ["revision", "duration"].includes(mutation) ? "source_changed" : "not_found");
      }
    }
  });

  it("fails closed for database errors, absent RPC, malformed replies and mismatched references", async () => {
    for (const table of ["memories", "memory_items", "media_assets"]) {
      const state = fixture();
      state.faults.table = table;
      await refused(listMemoryVideoSegments(state.client, SCOPE), "unavailable");
    }
    for (const flag of ["rpc", "malformed"] as const) {
      const state = fixture();
      state.faults[flag] = true;
      await refused(createMemoryVideoSegment(state.client, SCOPE, CREATE), "unavailable");
    }
    for (const patch of [{ ownerId: OTHER }, { assetVersion: 2 }, { durationMs: 5000 }, { source: "automatic" }, { endMs: 9000 }, { mediaUrl: "secret" }]) {
      const state = fixture();
      await createMemoryVideoSegment(state.client, SCOPE, CREATE);
      Object.assign(state.segments.get(SEGMENT)!, patch);
      await refused(listMemoryVideoSegments(state.client, SCOPE), "unavailable");
    }
    const state = fixture();
    state.faults.reply = { contractVersion: 2, ok: true, operation: "list", segments: [] };
    await refused(listMemoryVideoSegments(state.client, SCOPE), "unavailable");
  });

  it("deletes stale references without requiring playable media or deleting any bytes", async () => {
    const state = fixture();
    await createMemoryVideoSegment(state.client, SCOPE, CREATE);
    state.tables.media_assets = [];
    assert.equal((await deleteMemoryVideoSegment(state.client, SCOPE, SEGMENT)).deleted, true);
    assert.equal(state.calls.at(-1)?.source, undefined);
  });
});

describe("mounted dedicated route", () => {
  it("requires account authorization and offers complete private reference CRUD with schema refusal", async () => {
    const state = fixture();
    _setTestClient(state.client, true);
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const address = `http://127.0.0.1:${port}/api/memories/${MEMORY}/items/${ITEM}/video-segments`;
    const call = (method: string, owner = OWNER, body?: unknown, suffix = "") => fetch(address + suffix, {
      method, headers: { ...(owner ? { Authorization: `Bearer ${owner}` } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      assert.equal((await call("GET", "")).status, 401);
      assert.equal((await call("GET", OTHER)).status, 404);
      state.tables.profiles[0].user_account_states = [{ state: "banned", expires_at: null }];
      assert.equal((await call("POST", OWNER, CREATE)).status, 403);
      state.tables.profiles[0].user_account_states = [];
      state.tables.feature_flags[1].enabled = false;
      const disabled = await call("GET");
      assert.equal(disabled.status, 404);
      assert.equal((await disabled.json() as Row).error, "feature_disabled");
      state.tables.feature_flags[1].enabled = true;
      assert.equal((await call("POST", OWNER, { ...CREATE, mediaUrl: "https://example.com/a" })).status, 400);
      assert.equal((await call("POST", OWNER, { ...CREATE, ownerId: OTHER })).status, 400);
      state.faults.unavailable = true;
      for (const response of [await call("POST", OWNER, CREATE), await call("DELETE", OWNER, undefined, `/${SEGMENT}`)]) {
        assert.equal(response.status, 503);
        assert.equal((await response.json() as Row).error, "degraded_unavailable");
      }
      assert.equal(state.segments.size, 0);
      state.faults.unavailable = false;
      assert.equal((await call("POST", OWNER, CREATE)).status, 201);
      assert.equal((await call("POST", OWNER, CREATE)).status, 200);
      const listed = await call("GET");
      assert.equal(listed.status, 200);
      assert.equal(listed.headers.get("cache-control"), "private, no-store");
      assert.match(listed.headers.get("vary") ?? "", /Authorization/);
      assert.equal((await listed.json() as Row).segments[0].source, "owner_asserted");
      assert.equal((await call("DELETE", OWNER, undefined, `/${SEGMENT}`)).status, 204);
      state.faults.rpc = true;
      const unavailable = await call("GET");
      assert.equal(unavailable.status, 503);
      assert.ok(!(await unavailable.text()).includes("private SQL details"));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      _clearTestClient();
      _setTestServiceClient(null);
    }
  });
});
