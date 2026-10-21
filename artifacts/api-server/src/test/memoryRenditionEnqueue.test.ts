/**
 * H182 (census-highlights-memories), wave 5 lane 5 — the image ladder is
 * ENQUEUED where a Memory photo is stored, and LIST covers select renditions.
 *
 * `enqueueMemoryItemRenditions` (services/memory/memoryItemRenditions.ts) runs
 * after `POST /memories/:id/items` and `POST /memories/:id/items/from-post`
 * store an item. Its gates are the reader's own: the environment switch
 * (MEDIA_IMAGE_VARIANTS_ENABLED), 3980's two flags read through the ladder's
 * `access.enabled`, a canonical `post-media` object of the Memory owner's, and
 * the bridge's own re-check. It is idempotent per asset generation and never
 * fails the attach.
 *
 * `withMemoryCoverRenditions` gives the list serializer (`enrichMemories`) the
 * same selection `GET /memories/:id` has; the original URL always stays.
 *
 * Part 1 drives the enqueue against the Media lane's real access + bridge
 * (helpers/imageVariantsFixture, sharp), with only the queue RPC captured.
 * Part 2 drives both HTTP paths.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryRenditionEnqueue.test.ts
 */
import { describe, it, afterEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";

import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import {
  enqueueMemoryItemRenditions,
  withMemoryCoverRenditions,
  _resetMemoryRenditionEnqueueMemo,
  _setMemoryRenditionEnqueueForTest,
  _setMemoryRenditionReaderForTest,
} from "../services/memory/memoryItemRenditions.js";
import type { ImageVariantDescriptor } from "../lib/media/imageVariants/descriptor.js";
import { imageVariantsFixture } from "./helpers/imageVariantsFixture.js";

afterEach(() => {
  _resetMemoryRenditionEnqueueMemo();
  _setMemoryRenditionEnqueueForTest(undefined);
  _setMemoryRenditionReaderForTest(undefined);
  _setTestClient(null as any, false);
});

// ── Part 1: the enqueue, against the real access + bridge ────────────────────

async function ladder(context: TestContext) {
  const fixture = await imageVariantsFixture();
  context.after(() => fixture.cleanup());
  const env = { MEDIA_IMAGE_VARIANTS_ENABLED: "1", MEDIA_IMAGE_VARIANTS_ROOT: fixture.config.root, SUPABASE_URL: fixture.config.storageOrigin };
  const calls: Record<string, unknown>[] = [];
  const jobId = randomUUID();
  const rpc = fixture.sc.rpc.bind(fixture.sc);
  fixture.sc.rpc = (name: string, args: Record<string, unknown>) => name !== "media_derivative_enqueue" ? rpc(name, args) : {
    abortSignal() { calls.push(args); return Promise.resolve({ data: jobId, error: null }); },
  };
  const reads: string[] = [];
  const from = fixture.sc.from.bind(fixture.sc);
  fixture.sc.from = (t: string) => { reads.push(t); return from(t); };
  const ref = `${fixture.source.bucket}/${fixture.source.path}`;
  const item = (over: Record<string, unknown> = {}) => ({ mediaUrl: ref, mediaType: "image/png", ownerId: fixture.ownerId, ...over });
  return { fixture, env, calls, jobId, reads, ref, item };
}

describe("enqueueMemoryItemRenditions — the reader's own gates, then the ladder", () => {
  it("OFF (the default): nothing is read — the client is never touched", async () => {
    const untouchable = new Proxy({}, { get() { throw new Error("OFF touched the client"); } });
    assert.deepEqual(await enqueueMemoryItemRenditions(untouchable as any, { mediaUrl: "post-media/x/y.png", mediaType: "image/png", ownerId: "x" }, { env: {} }), { outcome: "off" });
    assert.deepEqual(await enqueueMemoryItemRenditions(untouchable as any, { mediaUrl: "post-media/x/y.mp4", mediaType: "video/mp4", ownerId: "x" }, { env: { MEDIA_IMAGE_VARIANTS_ENABLED: "1" } }), { outcome: "not_image" });
  });

  it("an image the Memory owner uploaded: enqueued once for its exact canonical generation", async (context) => {
    const { env, calls, jobId, item, fixture } = await ladder(context);
    const r = await enqueueMemoryItemRenditions(fixture.sc, item(), { env });
    assert.deepEqual(r, { outcome: "enqueued", jobId });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].p_asset_id, fixture.source.assetId);
    assert.equal(calls[0].p_source_version, 4);
    assert.equal(calls[0].p_owner_user_id, fixture.ownerId);
  });

  it("IDEMPOTENT per asset: attaching the same photo again does not enqueue again", async (context) => {
    const { env, calls, jobId, item, fixture } = await ladder(context);
    await enqueueMemoryItemRenditions(fixture.sc, item(), { env });
    const again = await enqueueMemoryItemRenditions(fixture.sc, item(), { env });
    assert.deepEqual(again, { outcome: "already_enqueued", jobId });
    assert.equal(calls.length, 1);
  });

  it("the storage URL form of the same object is the same object", async (context) => {
    const { env, calls, item, fixture } = await ladder(context);
    const url = `${fixture.config.storageOrigin}/storage/v1/object/public/post-media/${fixture.source.path}`;
    assert.equal((await enqueueMemoryItemRenditions(fixture.sc, item({ mediaUrl: url }), { env })).outcome, "enqueued");
    assert.equal(calls.length, 1);
  });

  it("EITHER 3980 flag off: off, and nothing past the flags is read or queued", async (context) => {
    for (const flag of ["media_canonical_enabled", "media_derivative_jobs_enabled"]) {
      const { env, calls, reads, item, fixture } = await ladder(context);
      fixture.tables.feature_flags!.find((f: any) => f.flag === flag)!.enabled = false;
      assert.deepEqual(await enqueueMemoryItemRenditions(fixture.sc, item(), { env }), { outcome: "off" }, flag);
      assert.ok(!reads.includes("media_assets"), `${flag}: media_assets was read with the flag off`);
      assert.equal(calls.length, 0);
    }
  });

  it("not ours, or not the owner's: an external URL and another person's upload are not enqueued", async (context) => {
    const { env, calls, reads, item, fixture } = await ladder(context);
    assert.equal((await enqueueMemoryItemRenditions(fixture.sc, item({ mediaUrl: "https://cdn.example/a.png" }), { env })).outcome, "not_canonical");
    assert.equal((await enqueueMemoryItemRenditions(fixture.sc, item({ ownerId: fixture.viewerId }), { env })).outcome, "not_canonical");
    assert.deepEqual([calls.length, reads.length], [0, 0]);
  });

  it("no canonical row (an upload from before canonical recording): not_found, nothing queued", async (context) => {
    const { env, calls, item, fixture } = await ladder(context);
    assert.equal((await enqueueMemoryItemRenditions(fixture.sc, item({ mediaUrl: `post-media/${fixture.ownerId}/other.png` }), { env })).outcome, "not_found");
    assert.equal(calls.length, 0);
  });

  it("an item labelled an image whose canonical row is a video is not_image, and nothing is queued", async (context) => {
    const { env, calls, item, fixture } = await ladder(context);
    fixture.asset.media_type = "video";
    assert.equal((await enqueueMemoryItemRenditions(fixture.sc, item(), { env })).outcome, "not_image");
    assert.equal(calls.length, 0);
  });

  it("the bridge's own refusal stands: a moderation hold is not queued", async (context) => {
    const { env, calls, item, fixture } = await ladder(context);
    fixture.asset.moderation_status = "pending";
    assert.equal((await enqueueMemoryItemRenditions(fixture.sc, item(), { env })).outcome, "refused");
    assert.equal(calls.length, 0);
  });

  it("an unreadable canonical table is 'failed' — logged, never thrown", async (context) => {
    const { env, calls, item, fixture } = await ladder(context);
    fixture.failures.add("media_assets");
    const warned: string[] = [];
    const r = await enqueueMemoryItemRenditions(fixture.sc, item(), { env, log: { warn: (_o, m) => warned.push(m) } });
    assert.equal(r.outcome, "failed");
    assert.equal(warned.length, 1);
    assert.equal(calls.length, 0);
  });
});

// ── Part 2: the HTTP paths ───────────────────────────────────────────────────

const ORIGIN = "https://image-synthetic.supabase.co";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ASSET = "40000000-0000-4000-8000-000000000001";
const PHOTO = `${ORIGIN}/storage/v1/object/public/post-media/${OWNER}/a.png`;

function world(): Record<string, any[]> {
  return {
    memories: [{
      id: MEM, owner_id: OWNER, title: "Lisbon rooftop", caption: null, visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
      trip_id: null, event_id: null, place_id: null, location_city: "Lisbon", location_country: "PT", location_lat: null, location_lng: null,
      canonical_location_id: null, starts_at: "2026-01-02T10:00:00.000Z", ends_at: null, state: "published",
      created_at: "2026-01-02T10:00:00.000Z", updated_at: "2026-01-02T10:00:00.000Z",
    }],
    memory_items: [{ id: "item-0", memory_id: MEM, media_url: PHOTO, media_type: "image/png", caption: null, position: 0, created_at: "2026-01-02T10:00:00.000Z" }],
    media_assets: [{ id: ASSET, version: 4, media_type: "image", storage_bucket: "post-media", storage_path: `${OWNER}/b.png` }],
    feature_flags: [{ flag: "media_canonical_enabled", enabled: true }, { flag: "media_derivative_jobs_enabled", enabled: true }],
    memory_tags: [], memory_likes: [], memory_saves: [], blocks: [], hidden_gems: [],
    profiles: [{ id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null, show_name_publicly: true }],
  };
}

function client(db: Record<string, any[]>) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false;
    let head = false;
    let inserted: any = null;
    const obj: any = {
      select(_c?: string, o?: any) { if (o?.head) head = true; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      gt() { return obj; }, gte() { return obj; }, lt() { return obj; }, lte() { return obj; }, not() { return obj; }, ilike() { return obj; }, or() { return obj; }, filter() { return obj; }, contains() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; }, abortSignal() { return obj; },
      insert(row: any) { inserted = { id: `row-${randomUUID()}`, created_at: "2026-01-03T00:00:00.000Z", ...(Array.isArray(row) ? row[0] : row) }; (db[table] ??= []).push(inserted); return obj; },
      update() { return obj; }, upsert() { return obj; }, delete() { return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(f: any, r: any) { return run().then(f, r); },
    };
    async function run() {
      if (inserted) return { data: single ? inserted : [inserted], error: null, count: null };
      const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (single) return { data: rows[0] ?? null, error: null, count: null };
      return { data: rows, error: null, count: head ? rows.length : null };
    }
    return obj;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: { message: "no rpc" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

async function serve(context: TestContext, db: Record<string, any[]>) {
  _setTestClient(client(db) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error() {}, info() {}, warn() {} }; n(); });
  app.use("/api", memoriesRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  context.after(() => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }));
  return `http://127.0.0.1:${(srv.address() as any).port}`;
}

function withEnv(context: TestContext, env: Record<string, string | undefined>) {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  context.after(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

async function waitFor<T>(f: () => T | undefined, ms = 1000): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v !== undefined || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 10)); }
}

describe("POST /api/memories/:id/items enqueues the stored photo's ladder", () => {
  async function attach(context: TestContext, env: Record<string, string | undefined>) {
    withEnv(context, { SUPABASE_URL: ORIGIN, ...env });
    const enqueued: any[] = [];
    _setMemoryRenditionEnqueueForTest(async (_sc, subject) => { enqueued.push(subject); return "job-1"; });
    const db = world();
    const base = await serve(context, db);
    const res = await fetch(`${base}/api/memories/${MEM}/items`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER}`, "content-type": "application/json", "Idempotency-Key": randomUUID(), connection: "close" },
      body: JSON.stringify({ mediaUrl: `${ORIGIN}/storage/v1/object/public/post-media/${OWNER}/b.png`, mediaType: "image/png", position: 1 }),
    });
    return { res, body: await res.json(), enqueued };
  }

  it("ON: the attach answers 201 and the ladder is enqueued for the canonical asset", async (context) => {
    const { res, body, enqueued } = await attach(context, { MEDIA_IMAGE_VARIANTS_ENABLED: "1" });
    assert.equal(res.status, 201, JSON.stringify(body));
    const subject = await waitFor(() => enqueued[0]);
    assert.ok(subject, "the enqueue ran");
    assert.deepEqual([subject.assetId, subject.sourceVersion, subject.bucket, subject.path], [ASSET, 4, "post-media", `${OWNER}/b.png`]);
  });

  it("OFF (the default): the same attach enqueues nothing", async (context) => {
    const { res, enqueued } = await attach(context, { MEDIA_IMAGE_VARIANTS_ENABLED: undefined });
    assert.equal(res.status, 201);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(enqueued.length, 0);
  });

  it("a failing ladder never fails the attach", async (context) => {
    withEnv(context, { MEDIA_IMAGE_VARIANTS_ENABLED: "1", SUPABASE_URL: ORIGIN });
    _setMemoryRenditionEnqueueForTest(async () => { throw new Error("queue unavailable"); });
    const base = await serve(context, world());
    const res = await fetch(`${base}/api/memories/${MEM}/items`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER}`, "content-type": "application/json", "Idempotency-Key": randomUUID(), connection: "close" },
      body: JSON.stringify({ mediaUrl: `${ORIGIN}/storage/v1/object/public/post-media/${OWNER}/b.png`, mediaType: "image/png", position: 1 }),
    });
    assert.equal(res.status, 201);
  });
});

const ready = (): ImageVariantDescriptor => ({
  state: "ready", assetId: ASSET, sourceVersion: 4, width: 64, height: 32,
  variants: ["image-320.webp", "image-800.webp", "image-1600.webp"].map((filename) => ({
    filename, url: `/api/media/image-variants/${ASSET}/4/${filename}`, mime: "image/webp", width: 10, height: 5, bytes: 100,
  })),
}) as ImageVariantDescriptor;

describe("list covers select renditions (GET /users/:id/memories, through enrichMemories)", () => {
  async function list(context: TestContext) {
    const base = await serve(context, world());
    const res = await fetch(`${base}/api/users/${OWNER}/memories`, { headers: { Authorization: `Bearer ${OWNER}`, connection: "close" } });
    return { status: res.status, body: await res.json() as any };
  }

  it("ON and published: the cover carries tiny/card/viewer and keeps its original URL", async (context) => {
    const asked: string[] = [];
    _setMemoryRenditionReaderForTest(() => async (_v, ref) => { asked.push(ref); return ready(); });
    const r = await list(context);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const cover = r.body.memories[0].cover;
    assert.equal(cover.mediaUrl, PHOTO, "the original is never replaced");
    assert.ok(cover.renditions.card.url.endsWith("/image-800.webp"));
    assert.equal(cover.renditions.original, PHOTO);
    assert.deepEqual(asked, [PHOTO]);
  });

  it("OFF (the default): the cover is exactly what it was — no renditions key", async (context) => {
    withEnv(context, { MEDIA_IMAGE_VARIANTS_ENABLED: undefined });
    const r = await list(context);
    assert.equal(r.status, 200);
    assert.equal("renditions" in r.body.memories[0].cover, false);
    assert.equal(r.body.memories[0].cover.mediaUrl, PHOTO);
  });

  it("a failing ladder never fails the list", async (context) => {
    _setMemoryRenditionReaderForTest(() => async () => { throw new Error("degraded_unavailable"); });
    const r = await list(context);
    assert.equal(r.status, 200);
    assert.equal(r.body.memories[0].cover.renditions, undefined);
  });

  it("withMemoryCoverRenditions keeps every cover and its key", async () => {
    _setMemoryRenditionReaderForTest(() => async () => ready());
    const covers = { a: { mediaUrl: PHOTO, mediaType: "image/png" }, b: { mediaUrl: "post-media/x/v.mp4", mediaType: "video/mp4" } };
    const out = await withMemoryCoverRenditions({} as any, OWNER, covers);
    assert.deepEqual(Object.keys(out).sort(), ["a", "b"]);
    assert.ok(out.a.renditions);
    assert.equal(out.b.renditions, undefined);
  });
});

describe("both Memory photo writers call the enqueue (static pin)", () => {
  it("POST /memories/:id/items and POST /memories/:id/items/from-post each enqueue the item they stored, after it is stored", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../routes/memories.ts"), "utf8");
    const items = src.slice(src.indexOf('router.post("/memories/:id/items", '), src.indexOf('router.delete("/memories/:id/items/:itemId"'));
    assert.match(items, /if \(!outcome\.ok\) \{ sendCommandFailure\(req, res, outcome\); return; \}\n\n  void enqueueMemoryItemRenditions\(sc, \{ mediaUrl: parsed\.data\.mediaUrl, mediaType: parsed\.data\.mediaType, ownerId: user\.id \}/);
    const fromPost = src.slice(src.indexOf('router.post("/memories/:id/items/from-post"'));
    assert.match(fromPost, /recordMemoryCreatedFromMediaSignal\(sc, \{ userId: user\.id, postId \}\); void enqueueMemoryItemRenditions\(sc, \{ mediaUrl, mediaType, ownerId: user\.id \}/);
    // Exactly those two writers, so a third Memory photo writer must decide too.
    assert.equal((src.match(/\.from\("memory_items"\)\s*\n\s*\.insert\(/g) ?? []).length, 2);
  });
});
