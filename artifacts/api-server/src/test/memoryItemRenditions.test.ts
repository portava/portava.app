/**
 * H182 — a Memory read selects the image ladder's renditions, behind the ladder's own gates.
 *
 * census-highlights-memories H182 ("Distinct original / viewer / card / tiny
 * signed renditions"). The selector is `services/memory/memoryItemRenditions.ts`;
 * the read is `GET /api/memories/:id` in `routes/memories.ts`.
 *
 * Run: node --import tsx/esm --test src/test/memoryItemRenditions.test.ts
 */
import { describe, it, afterEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import {
  _setMemoryRenditionReaderForTest,
  isImageItem,
  selectRenditionTiers,
  withMemoryItemRenditions,
  type RenditionDescriptorReader,
} from "../services/memory/memoryItemRenditions.js";
import { createImageVariantsService } from "../services/media/ImageVariantsService.js";
import { createImageVariantsRuntime } from "../lib/media/imageVariants/runtime.js";
import type { ImageVariantDescriptor } from "../lib/media/imageVariants/descriptor.js";
import { imageVariantsFixture } from "./helpers/imageVariantsFixture.js";

const ASSET = "40000000-0000-4000-8000-000000000001";
const FILES = ["feed.jpg", "image-1600.avif", "image-1600.webp", "image-320.avif", "image-320.webp", "image-800.avif", "image-800.webp", "thumb.jpg"];
const variant = (filename: string) => ({
  filename, url: `/api/media/image-variants/${ASSET}/4/${filename}`,
  mime: filename.endsWith(".jpg") ? "image/jpeg" : `image/${filename.split(".").pop()}`, width: 10, height: 5, bytes: 100,
});
const ready = (names = FILES): ImageVariantDescriptor =>
  ({ state: "ready", assetId: ASSET, sourceVersion: 4, width: 64, height: 32, variants: names.map(variant) }) as ImageVariantDescriptor;
const ORIGINAL = "post-media/30000000-0000-4000-8000-000000000001/a.png";

afterEach(() => { _setMemoryRenditionReaderForTest(undefined); _setTestClient(null as any, false); });

// ── Selection ────────────────────────────────────────────────────────────────

describe("selectRenditionTiers", () => {
  it("a published ladder: tiny 320, card 800, viewer 1600, all WebP; the original stays the item's URL", () => {
    const r = selectRenditionTiers(ready(), ORIGINAL)!;
    assert.equal(r.tiny!.url, `/api/media/image-variants/${ASSET}/4/image-320.webp`);
    assert.equal(r.card!.url, `/api/media/image-variants/${ASSET}/4/image-800.webp`);
    assert.equal(r.viewer!.url, `/api/media/image-variants/${ASSET}/4/image-1600.webp`);
    assert.equal(r.original, ORIGINAL);
    assert.equal(r.assetId, ASSET);
    assert.equal(r.sourceVersion, 4);
  });

  it("without the WebP rungs it falls back to the JPEG thumb and feed", () => {
    const r = selectRenditionTiers(ready(["thumb.jpg", "feed.jpg"]), ORIGINAL)!;
    assert.ok(r.tiny!.url.endsWith("/thumb.jpg"));
    assert.ok(r.card!.url.endsWith("/feed.jpg"));
    assert.ok(r.viewer!.url.endsWith("/feed.jpg"));
  });

  it("an unpublished generation, an empty ladder, or a URL off the relay selects nothing", () => {
    assert.equal(selectRenditionTiers({ state: "original", reason: "not_ready", assetId: ASSET, sourceVersion: 4, variants: [] }, ORIGINAL), null);
    assert.equal(selectRenditionTiers(ready([]), ORIGINAL), null);
    assert.equal(selectRenditionTiers({ ...ready(), state: "original" } as any, ORIGINAL), null, "only a READY generation is selected, whatever it carries");
    const off = ready(); for (const v of off.variants) (v as any).url = `https://cdn.example/${v.filename}`;
    assert.equal(selectRenditionTiers(off, ORIGINAL), null);
  });
});

describe("withMemoryItemRenditions", () => {
  const items = () => [
    { id: "i1", mediaUrl: ORIGINAL, mediaType: "image/jpeg" },
    { id: "i2", mediaUrl: "post-media/x/v.mp4", mediaType: "video/mp4" },
  ];
  const sc = { from() { throw new Error("the selector must not read the database itself"); } } as any;

  it("the environment switch is off by default: items come back untouched and nothing is read", async () => {
    delete process.env.MEDIA_IMAGE_VARIANTS_ENABLED;
    const out = await withMemoryItemRenditions(sc, "viewer", items());
    assert.deepEqual(out, items());
  });

  it("image items are told apart by the MIME type the column holds", () => {
    assert.equal(isImageItem("image/jpeg"), true);
    assert.equal(isImageItem("image"), true);
    assert.equal(isImageItem("video/mp4"), false);
    assert.equal(isImageItem(null), false);
  });

  it("only image items are looked up, and a ready ladder is attached to them", async () => {
    const asked: string[] = [];
    _setMemoryRenditionReaderForTest(() => async (_v, ref) => { asked.push(ref); return ready(); });
    const out = await withMemoryItemRenditions(sc, "viewer", items());
    assert.deepEqual(asked, [ORIGINAL]);
    assert.ok(out[0]!.renditions);
    assert.equal(out[1]!.renditions, undefined);
    assert.equal(out[0]!.mediaUrl, ORIGINAL, "the original is never replaced");
  });

  it("a refusal, a throw or a spent budget leaves the original alone", async () => {
    _setMemoryRenditionReaderForTest(() => async () => { throw new Error("not_found"); });
    assert.deepEqual(await withMemoryItemRenditions(sc, "viewer", items()), items());
    _setMemoryRenditionReaderForTest(() => (_v, _r, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const t0 = Date.now();
    assert.deepEqual(await withMemoryItemRenditions(sc, "viewer", items(), undefined, 50), items());
    assert.ok(Date.now() - t0 < 2000, "the budget bounds the read");
    _setMemoryRenditionReaderForTest(() => () => new Promise(() => {}));
    assert.deepEqual(await withMemoryItemRenditions(sc, "viewer", items(), undefined, 50), items(), "a reader that ignores the signal is still bounded");
  });
});

// ── The real ladder, its own gates ───────────────────────────────────────────

describe("against the Media lane's ladder (real service, real published files)", () => {
  async function ladder(context: TestContext) {
    const fixture = await imageVariantsFixture();
    context.after(() => fixture.cleanup());
    const service = createImageVariantsService(fixture.sc, fixture.config);
    const reader: RenditionDescriptorReader = (viewer, reference, signal) => service.descriptor(viewer, { reference }, signal);
    _setMemoryRenditionReaderForTest(() => reader);
    const ref = `${fixture.source.bucket}/${fixture.source.path}`;
    const item = () => [{ id: "i1", mediaUrl: ref, mediaType: "image/png" }];
    return { fixture, item, ref };
  }
  async function publish(fixture: Awaited<ReturnType<typeof imageVariantsFixture>>) {
    const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
    fixture.state.ready = (await runtime.handler.handle(fixture.context)).result;
  }

  it("published, read by its owner: three tiers on the authenticated relay", async (context) => {
    const { fixture, item, ref } = await ladder(context);
    await publish(fixture);
    const [out] = await withMemoryItemRenditions(fixture.sc as any, fixture.ownerId, item(), undefined, 10_000);
    const r = out!.renditions!;
    assert.ok(r, "renditions selected");
    assert.equal(r.tiny!.url, `/api/media/image-variants/${fixture.source.assetId}/4/image-320.webp`);
    assert.equal(r.viewer!.mime, "image/webp");
    assert.equal(r.original, ref);
  });

  it("the canonical asset's own audience still decides: another viewer of a private asset gets none", async (context) => {
    const { fixture, item } = await ladder(context);
    await publish(fixture);
    const [out] = await withMemoryItemRenditions(fixture.sc as any, fixture.viewerId, item(), undefined, 10_000);
    assert.equal(out!.renditions, undefined);
  });

  it("either database flag off (3980's media_derivative_jobs_enabled, media_canonical_enabled): none", async (context) => {
    for (const flag of ["media_derivative_jobs_enabled", "media_canonical_enabled"]) {
      const { fixture, item } = await ladder(context);
      await publish(fixture);
      fixture.tables.feature_flags!.find((f: any) => f.flag === flag)!.enabled = false;
      const [out] = await withMemoryItemRenditions(fixture.sc as any, fixture.ownerId, item(), undefined, 10_000);
      assert.equal(out!.renditions, undefined, flag);
    }
  });

  it("not yet published: none, and nothing is encoded or signed by the read", async (context) => {
    const { fixture, item } = await ladder(context);
    const [out] = await withMemoryItemRenditions(fixture.sc as any, fixture.ownerId, item(), undefined, 10_000);
    assert.equal(out!.renditions, undefined);
    assert.equal(fixture.signs.length, 0);
    assert.equal(fixture.enqueued.length, 0);
  });
});

// ── GET /api/memories/:id ────────────────────────────────────────────────────

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function store(): Record<string, any[]> {
  return {
    memories: [{
      id: MEM, owner_id: OWNER, title: "Lisbon rooftop", caption: null, visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
      trip_id: null, event_id: null, place_id: null, location_city: "Lisbon", location_country: "PT", location_lat: null, location_lng: null,
      canonical_location_id: null, starts_at: "2026-01-02T10:00:00.000Z", ends_at: null, state: "published",
      created_at: "2026-01-02T10:00:00.000Z", updated_at: "2026-01-02T10:00:00.000Z",
    }],
    memory_items: [
      { id: "item-1", memory_id: MEM, media_url: ORIGINAL, media_type: "image/jpeg", caption: null, position: 0, created_at: "2026-01-02T10:00:00.000Z" },
      { id: "item-2", memory_id: MEM, media_url: "post-media/x/clip.mp4", media_type: "video/mp4", caption: null, position: 1, created_at: "2026-01-02T10:00:00.000Z" },
    ],
    memory_tags: [], memory_likes: [], memory_saves: [],
    profiles: [{ id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null }],
    blocks: [], feature_flags: [], hidden_gems: [],
  };
}

function client(db: Record<string, any[]>) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false;
    let head = false;
    const obj: any = {
      select(_c?: string, o?: any) { if (o?.head) head = true; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      gt() { return obj; }, lt() { return obj; }, not() { return obj; }, ilike() { return obj; }, or() { return obj; }, filter() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
      insert() { return obj; }, update() { return obj; }, upsert() { return obj; }, delete() { return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(f: any, r: any) { return run().then(f, r); },
    };
    async function run() {
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

async function getMemory(context: TestContext): Promise<{ status: number; body: any }> {
  _setTestClient(client(store()) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error() {}, info() {}, warn() {} }; n(); });
  app.use("/api", memoriesRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  context.after(() => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }));
  const res = await fetch(`http://127.0.0.1:${(srv.address() as any).port}/api/memories/${MEM}`, { headers: { Authorization: `Bearer ${OWNER}`, connection: "close" } });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/memories/:id selects renditions", () => {
  it("with the ladder on and published, the image item carries tiny/card/viewer and keeps its original", async (context) => {
    _setMemoryRenditionReaderForTest(() => async () => ready());
    const r = await getMemory(context);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [img, vid] = r.body.memory.items;
    assert.equal(img.mediaUrl, ORIGINAL);
    assert.ok(img.renditions.card.url.endsWith("/image-800.webp"));
    assert.equal(img.renditions.original, ORIGINAL);
    assert.equal(vid.renditions, undefined);
  });

  it("with the ladder off (the default), the read is byte-for-byte the one it was: no renditions key", async (context) => {
    delete process.env.MEDIA_IMAGE_VARIANTS_ENABLED;
    const r = await getMemory(context);
    assert.equal(r.status, 200);
    for (const it of r.body.memory.items) assert.equal("renditions" in it, false);
  });

  it("a failing ladder never fails the read", async (context) => {
    _setMemoryRenditionReaderForTest(() => async () => { throw new Error("degraded_unavailable"); });
    const r = await getMemory(context);
    assert.equal(r.status, 200);
    assert.equal(r.body.memory.items[0].mediaUrl, ORIGINAL);
    assert.equal(r.body.memory.items[0].renditions, undefined);
  });
});
