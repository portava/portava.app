/**
 * §20 "Video scenes as logical segments without duplicating originals" —
 * census-highlights-memories H184 (§BP), migration 3809, B58 cluster
 * MEM-SEGMENTS. Over the real routers (routes/memorySegments.ts, and
 * routes/memories.ts for the detail read a segment's reference must equal).
 *
 * What this suite pins, each against a fake that RECORDS every storage call and
 * every write:
 *   A. creating (and deleting) a segment performs ZERO storage operations and
 *      writes exactly one row; the reference it is served with is the item's own
 *      stored `media_url`, the value GET /memories/:id serves for that item;
 *   B. the window is checked against the MEASURED duration
 *      (media_assets.duration_ms): past the end ⇒ 422; unknown in every way it
 *      can be unknown ⇒ 422; an image ⇒ 422; a client-claimed length is refused;
 *   C. a viewer who cannot read the item gets no segments: a Memory they cannot
 *      read is the SAME 404 as a missing one (and no failure behind it leaks
 *      existence); a photo kept only_me makes the response byte-identical to one
 *      where that item has no segments, and to one where it does not exist;
 *   D. owner-only writes: everyone else gets a missing Memory's 404 and nothing
 *      is written or removed;
 *   E. the shape: bounds, the label, duplicates, the per-item cap, the order.
 *
 * Run: node --import tsx/esm --test src/test/memorySegments.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import memorySegmentsRouter from "../routes/memorySegments.js";
import {
  SEGMENTS_PER_ITEM_MAX,
  SEGMENT_LABEL_MAX,
  isVideoMediaType,
  measuredDurationFor,
  toSegmentRow,
  windowWithin,
} from "../services/memory/memorySegments.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEM = "11111111-1111-4111-8111-111111111111";
const MEM_OTHER = "11111111-1111-4111-8111-111111111112";
const MISSING = "11111111-1111-4111-8111-1111111111ff";
const TRIP = "44444444-4444-4444-8444-444444444444";
const ITEM_VIDEO = "21111111-1111-4111-8111-111111111111";
const ITEM_HIDDEN = "21111111-1111-4111-8111-111111111112";
const ITEM_PHOTO = "21111111-1111-4111-8111-111111111113";
const ITEM_EXTERNAL = "21111111-1111-4111-8111-111111111114";
const ITEM_ABSOLUTE = "21111111-1111-4111-8111-111111111115";
const ITEM_ON_OTHER = "21111111-1111-4111-8111-111111111116";
const SEG_A = "51111111-1111-4111-8111-111111111111";
const SEG_B = "51111111-1111-4111-8111-111111111112";
const SEG_HIDDEN = "51111111-1111-4111-8111-111111111113";

const VIDEO_PATH = `${OWNER}/1760000000000.mp4`;
const VIDEO_URL = `post-media/${VIDEO_PATH}`;
const HIDDEN_PATH = `${OWNER}/1760000000001.mp4`;
const HIDDEN_URL = `post-media/${HIDDEN_PATH}`;
const ABSOLUTE_PATH = `${OWNER}/1760000000002.mov`;
const ABSOLUTE_URL = `https://abcd.supabase.co/storage/v1/object/public/post-media/${ABSOLUTE_PATH}`;
const PHOTO_URL = `post-media/${OWNER}/1760000000003.jpg`;
const EXTERNAL_URL = "https://cdn.example.com/clip.mp4";
const DURATION = 30_000;

type Store = Record<string, any[]>;

function memoryRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, owner_id: OWNER, title: "Night market", caption: null, visibility: "public",
    allowed_user_ids: [], hidden_user_ids: [], trip_id: TRIP, event_id: null, place_id: null,
    location_city: null, location_country: null, location_lat: null, location_lng: null,
    canonical_location_id: null, starts_at: null, ends_at: null, state: "published",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...over,
  };
}
const item = (id: string, memoryId: string, url: string, type: string, position: number, visibility: string | null = null, caption: string | null = null) => ({
  id, memory_id: memoryId, media_url: url, media_type: type, caption, position, created_at: "2026-01-01T00:00:00.000Z", visibility,
});
const asset = (path: string, over: Record<string, unknown> = {}) => ({
  id: `asset-${path}`, owner_user_id: OWNER, storage_bucket: "post-media", storage_path: path, media_type: "video", duration_ms: DURATION, ...over,
});
const segment = (id: string, itemId: string, startMs: number, endMs: number, label: string | null, memoryId = MEM) => ({
  id, memory_id: memoryId, item_id: itemId, owner_id: OWNER, start_ms: startMs, end_ms: endMs, label, created_at: "2026-01-02T00:00:00.000Z",
});

function seed(over: { memory?: Record<string, unknown>; segments?: any[]; hiddenVisibility?: string | null } = {}): Store {
  return {
    feature_flags: [], blocks: [], user_follows: [], circle_memberships: [],
    memories: [memoryRow(MEM, over.memory ?? {}), memoryRow(MEM_OTHER)],
    memory_items: [
      item(ITEM_VIDEO, MEM, VIDEO_URL, "video/mp4", 0, null, "the whole clip"),
      item(ITEM_HIDDEN, MEM, HIDDEN_URL, "video/mp4", 1, over.hiddenVisibility === undefined ? "only_me" : over.hiddenVisibility, "HIDDEN-CAPTION"),
      item(ITEM_PHOTO, MEM, PHOTO_URL, "image/jpeg", 2),
      item(ITEM_EXTERNAL, MEM, EXTERNAL_URL, "video/mp4", 3),
      item(ITEM_ABSOLUTE, MEM, ABSOLUTE_URL, "video/quicktime", 4),
      item(ITEM_ON_OTHER, MEM_OTHER, `post-media/${OWNER}/1760000000009.mp4`, "video/mp4", 0),
    ],
    media_assets: [
      asset(VIDEO_PATH), asset(HIDDEN_PATH), asset(ABSOLUTE_PATH, { duration_ms: 12_345 }),
      asset(`${OWNER}/1760000000003.jpg`, { media_type: "image", duration_ms: null }),
      asset(`${OWNER}/1760000000009.mp4`),
    ],
    memory_media_segments: over.segments ?? [],
    memory_tags: [], memory_likes: [], memory_saves: [],
    trips: [{ id: TRIP, owner_id: OWNER, title: "T", status: "active", visibility: "public" }],
    trip_members: [
      { trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" },
    ],
    profiles: [
      { id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null },
      { id: VIEWER, account_status: "active", name: "Viewer", handle: "viewer", avatar_url: null },
      { id: STRANGER, account_status: "active", name: "Stranger", handle: "stranger", avatar_url: null },
    ],
  };
}

interface FakeOpts {
  /** 3809 not applied: every touch of memory_media_segments is 42P01. */
  noSegmentsTable?: boolean;
  /** "<table>:<mode>" reads/writes that fail with a non-absence error; "memory_items:hidden" is only the 3672 hidden-set read. */
  fail?: string[];
}

interface Recorder { storage: string[]; writes: Array<{ table: string; mode: string }> }

function makeClient(store: Store, rec: Recorder, opts: FakeOpts = {}) {
  const fails = new Set(opts.fail ?? []);
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const named: string[] = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let mode: "select" | "update" | "insert" | "delete" | "upsert" = "select";
    let payload: any = null; let selected: string | null = null; let wantRows = false; let single = false; let countMode = false; let limit: number | null = null;
    const f = (c: string, p: (r: any) => boolean) => { named.push(c); filters.push(p); return obj; };
    const obj: any = {
      select(c?: string, o?: any) { if (mode !== "select") wantRows = true; else if (typeof c === "string") selected = c; if (o?.count === "exact" && o?.head) countMode = true; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      upsert(d: any) { mode = "upsert"; payload = d; return obj; },
      delete() { mode = "delete"; return obj; },
      eq: (c: string, v: any) => f(c, (r) => r[c] === v),
      neq: (c: string, v: any) => f(c, (r) => r[c] !== v),
      in: (c: string, vs: any[]) => f(c, (r) => vs.includes(r[c])),
      is: (c: string, v: any) => f(c, (r) => (v === null ? r[c] == null : r[c] === v)),
      gte() { return obj; }, lte() { return obj; }, gt() { return obj; }, lt() { return obj; },
      not() { return obj; }, or() { return obj; }, range() { return obj; }, contains() { return obj; },
      order(c: string, o?: { ascending?: boolean }) { orders.push({ col: c, asc: o?.ascending !== false }); return obj; },
      limit(n: number) { limit = n; return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(ok: any, bad: any) { return run().then(ok, bad); },
    };
    async function run(): Promise<any> {
      if (table === "memory_media_segments" && opts.noSegmentsTable) {
        return { data: null, error: { code: "42P01", message: 'relation "public.memory_media_segments" does not exist' }, count: null };
      }
      const hiddenRead = table === "memory_items" && named.includes("visibility");
      if (hiddenRead && fails.has("memory_items:hidden")) return { data: null, error: { code: "57014", message: "memory_items hidden read failed" } };
      if (!hiddenRead && fails.has(`${table}:${mode}`)) return { data: null, error: { code: "57014", message: `${table} ${mode} failed` }, count: null };
      const all = (store[table] ??= []);
      let matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode !== "select") rec.writes.push({ table, mode });
      if (mode === "update") { for (const r of matched) Object.assign(r, payload); return { data: wantRows ? matched.map((x) => ({ ...x })) : null, error: null }; }
      if (mode === "insert" || mode === "upsert") {
        const written: any[] = [];
        for (const r of (Array.isArray(payload) ? payload : [payload])) {
          if (table === "memory_media_segments" && all.some((x) => x.item_id === r.item_id && x.start_ms === r.start_ms && x.end_ms === r.end_ms)) {
            return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "memory_media_segments_window_unique"' } };
          }
          const row = { id: r.id ?? `5${String(all.length + 1).padStart(7, "0")}-1111-4111-8111-111111111111`, ...r };
          all.push(row); written.push(row);
        }
        const out = written.map((x) => ({ ...x }));
        return { data: wantRows ? (single ? out[0] : out) : null, error: null };
      }
      if (mode === "delete") {
        for (const r of matched) all.splice(all.indexOf(r), 1);
        return { data: wantRows ? matched.map((x) => ({ ...x })) : null, error: null };
      }
      if (countMode) return { data: null, error: null, count: matched.length };
      for (const o of [...orders].reverse()) matched = [...matched].sort((a, b) => (a[o.col] < b[o.col] ? -1 : a[o.col] > b[o.col] ? 1 : 0) * (o.asc ? 1 : -1));
      if (limit !== null) matched = matched.slice(0, limit);
      const project = (r: any) => (selected && !/[*()]/.test(selected) ? Object.fromEntries(selected.split(",").map((k) => k.trim()).filter((k) => k in r).map((k) => [k, r[k]])) : { ...r });
      if (single) return { data: matched[0] ? project(matched[0]) : null, error: null };
      return { data: matched.map((x) => project(x)), error: null };
    }
    return obj;
  }
  const storageBucket = (bucket: string) => new Proxy({}, {
    get: (_t, method) => (..._args: unknown[]) => { rec.storage.push(`${bucket}.${String(method)}`); return Promise.resolve({ data: null, error: null }); },
  });
  return {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: [], error: null }),
    storage: { from: (bucket: string) => { rec.storage.push(`from:${bucket}`); return storageBucket(bucket); } },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App { base: string; store: Store; rec: Recorder; close: () => Promise<void> }
async function start(store: Store, opts: FakeOpts = {}): Promise<App> {
  const rec: Recorder = { storage: [], writes: [] };
  _setTestClient(makeClient(store, rec, opts) as any, true);
  const ex = express();
  ex.use(express.json());
  ex.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  ex.use("/api", memorySegmentsRouter);
  ex.use("/api", memoriesRouter);
  const srv = http.createServer(ex);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, rec, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
async function call(a: App, method: string, path: string, actor: string, body?: unknown) {
  const res = await fetch(`${a.base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}
const json = (r: { text: string }) => JSON.parse(r.text);
const post = (a: App, actor: string, itemId: string, body: unknown, memoryId = MEM) => call(a, "POST", `/memories/${memoryId}/items/${itemId}/segments`, actor, body);

let app: App | null = null;
afterEach(async () => { if (app) { await app.close(); app = null; } });

describe("A. a segment is a window over the item's own object: nothing is written to storage", () => {
  it("POST performs ZERO storage operations, writes one row with no reference of its own, and serves the item's own media_url", async () => {
    app = await start(seed());
    const r = await post(app, OWNER, ITEM_VIDEO, { startMs: 1_000, endMs: 5_000, label: "  Sunset  " });
    assert.equal(r.status, 201, r.text);
    const { segment: s } = json(r);
    assert.equal(s.mediaUrl, VIDEO_URL, "the served ref is the item's stored path");
    assert.deepEqual([s.itemId, s.startMs, s.endMs, s.label], [ITEM_VIDEO, 1_000, 5_000, "Sunset"]);
    assert.deepEqual(app.rec.storage, [], "no storage call of any kind");
    assert.deepEqual(app.rec.writes, [{ table: "memory_media_segments", mode: "insert" }], "exactly one write");
    const stored = app.store.memory_media_segments;
    assert.equal(stored.length, 1);
    assert.deepEqual(Object.keys(stored[0]).sort(), ["end_ms", "id", "item_id", "label", "memory_id", "owner_id", "start_ms"].sort(),
      "the row holds two ids of the Memory, the owner, two integers and a label — no path, URL or bucket");
    assert.ok(!JSON.stringify(stored[0]).includes(VIDEO_PATH), "the stored row carries no copy of the object reference");
    assert.equal(stored[0].owner_id, OWNER);
    assert.equal(app.store.memory_items.length, 6, "no item was created");
    assert.equal(app.store.media_assets.length, 5, "no asset was created");
  });

  it("GET serves every reader the SAME reference GET /memories/:id serves them for that item, and touches no storage", async () => {
    app = await start(seed({ segments: [segment(SEG_A, ITEM_VIDEO, 1_000, 5_000, "Sunset"), segment(SEG_B, ITEM_ABSOLUTE, 0, 2_000, null)] }));
    for (const who of [OWNER, VIEWER]) {
      const segs = json(await call(app, "GET", `/memories/${MEM}/segments`, who));
      const detail = json(await call(app, "GET", `/memories/${MEM}`, who));
      const itemUrl = new Map<string, string>(detail.memory.items.map((i: any) => [i.id, i.mediaUrl]));
      assert.equal(segs.segments.length, 2, who);
      for (const s of segs.segments) assert.equal(s.mediaUrl, itemUrl.get(s.itemId), `${who}: ${s.id}`);
      assert.equal(segs.segments[0].mediaUrl, VIDEO_URL);
      assert.equal(segs.segments[1].mediaUrl, ABSOLUTE_URL);
    }
    assert.deepEqual(app.rec.storage, []);
    assert.deepEqual(app.rec.writes, [], "a read writes nothing");
  });

  it("DELETE removes the row and nothing else: no storage call, the item and its asset stay", async () => {
    app = await start(seed({ segments: [segment(SEG_A, ITEM_VIDEO, 1_000, 5_000, "Sunset")] }));
    const r = await call(app, "DELETE", `/memories/${MEM}/segments/${SEG_A}`, OWNER);
    assert.equal(r.status, 204, r.text);
    assert.equal(app.store.memory_media_segments.length, 0);
    assert.deepEqual(app.rec.storage, []);
    assert.deepEqual(app.rec.writes, [{ table: "memory_media_segments", mode: "delete" }]);
    assert.ok(app.store.memory_items.some((i) => i.id === ITEM_VIDEO) && app.store.media_assets.some((x) => x.storage_path === VIDEO_PATH));
  });
});

describe("B. the window is checked against the MEASURED duration", () => {
  it("end past the measured end ⇒ 422 segment_out_of_range; exactly the end is accepted", async () => {
    app = await start(seed());
    const over = await post(app, OWNER, ITEM_VIDEO, { startMs: 29_000, endMs: DURATION + 1 });
    assert.equal(over.status, 422, over.text);
    assert.equal(json(over).error, "segment_out_of_range");
    assert.equal(app.store.memory_media_segments.length, 0, "nothing written");
    const edge = await post(app, OWNER, ITEM_VIDEO, { startMs: 29_000, endMs: DURATION });
    assert.equal(edge.status, 201, edge.text);
  });

  it("the absolute-URL spelling of an item resolves to the same asset and its own length", async () => {
    app = await start(seed());
    assert.equal((await post(app, OWNER, ITEM_ABSOLUTE, { startMs: 0, endMs: 12_346 })).status, 422);
    assert.equal((await post(app, OWNER, ITEM_ABSOLUTE, { startMs: 0, endMs: 12_345 })).status, 201);
  });

  for (const [name, mutate] of [
    ["no media_assets row (the canonical writer was off when it was uploaded)", (s: Store) => { s.media_assets = s.media_assets.filter((a) => a.storage_path !== VIDEO_PATH); }],
    ["duration_ms is null (never probed)", (s: Store) => { s.media_assets.find((a) => a.storage_path === VIDEO_PATH).duration_ms = null; }],
    ["duration_ms is 0", (s: Store) => { s.media_assets.find((a) => a.storage_path === VIDEO_PATH).duration_ms = 0; }],
    ["duration_ms is not a whole number", (s: Store) => { s.media_assets.find((a) => a.storage_path === VIDEO_PATH).duration_ms = 1234.5; }],
    ["the asset is another person's", (s: Store) => { s.media_assets.find((a) => a.storage_path === VIDEO_PATH).owner_user_id = STRANGER; }],
  ] as const) {
    it(`unknown duration — ${name} ⇒ 422 duration_unknown, nothing written`, async () => {
      const s = seed(); mutate(s);
      app = await start(s);
      const r = await post(app, OWNER, ITEM_VIDEO, { startMs: 0, endMs: 1_000 });
      assert.equal(r.status, 422, r.text);
      assert.equal(json(r).error, "duration_unknown");
      assert.equal(app.store.memory_media_segments.length, 0);
      assert.deepEqual(app.rec.storage, []);
    });
  }

  it("unknown duration — an external URL has no measured asset at all ⇒ 422 duration_unknown", async () => {
    app = await start(seed());
    const r = await post(app, OWNER, ITEM_EXTERNAL, { startMs: 0, endMs: 1_000 });
    assert.equal(r.status, 422, r.text);
    assert.equal(json(r).error, "duration_unknown");
    assert.equal(app.store.memory_media_segments.length, 0);
  });

  it("a photo, by the item's stored type or by its measured asset, ⇒ 422 not_a_video", async () => {
    app = await start(seed());
    const photo = await post(app, OWNER, ITEM_PHOTO, { startMs: 0, endMs: 1_000 });
    assert.equal(photo.status, 422); assert.equal(json(photo).error, "not_a_video");
    await app.close();
    const s = seed(); s.media_assets.find((a) => a.storage_path === VIDEO_PATH).media_type = "image";
    app = await start(s);
    const lying = await post(app, OWNER, ITEM_VIDEO, { startMs: 0, endMs: 1_000 });
    assert.equal(lying.status, 422); assert.equal(json(lying).error, "not_a_video");
    assert.equal(app.store.memory_media_segments.length, 0);
  });

  it("an unreadable media_assets is a 503, never 'unknown' and never accepted", async () => {
    app = await start(seed(), { fail: ["media_assets:select"] });
    const r = await post(app, OWNER, ITEM_VIDEO, { startMs: 0, endMs: 1_000 });
    assert.equal(r.status, 503, r.text);
    assert.equal(app.store.memory_media_segments.length, 0);
  });

  it("a length the client claims is not an input: the body is strict", async () => {
    app = await start(seed());
    const r = await post(app, OWNER, ITEM_VIDEO, { startMs: 0, endMs: 60_000, durationMs: 90_000 });
    assert.equal(r.status, 400, r.text);
    assert.equal(app.store.memory_media_segments.length, 0);
  });
});

describe("C. a viewer who cannot read the item gets no segments", () => {
  const withSegments = () => [segment(SEG_A, ITEM_VIDEO, 1_000, 5_000, "SECRET-LABEL"), segment(SEG_HIDDEN, ITEM_HIDDEN, 0, 3_000, "HIDDEN-LABEL")];

  for (const [name, memory, store, viewer] of [
    ["an only_me Memory", { visibility: "only_me" }, null, VIEWER],
    ["a draft", { state: "draft" }, null, VIEWER],
    ["a viewer the owner hid", { hidden_user_ids: [VIEWER] }, null, VIEWER],
    ["a custom list the viewer is not on", { visibility: "custom", allowed_user_ids: [STRANGER] }, null, VIEWER],
    ["a trip-crew Memory, viewer not crew", { visibility: "trip_crew" }, null, STRANGER],
    ["the owner blocked the viewer", {}, (s: Store) => { s.blocks.push({ blocker_id: OWNER, blocked_id: VIEWER }); }, VIEWER],
    ["the viewer blocked the owner", {}, (s: Store) => { s.blocks.push({ blocker_id: VIEWER, blocked_id: OWNER }); }, VIEWER],
    ["a deleted Memory", { state: "deleted" }, null, VIEWER],
  ] as const) {
    it(`${name}: the same 404 a missing Memory gets, and no label`, async () => {
      const s = seed({ memory, segments: withSegments() }); if (store) store(s);
      app = await start(s);
      const r = await call(app, "GET", `/memories/${MEM}/segments`, viewer);
      const missing = await call(app, "GET", `/memories/${MISSING}/segments`, viewer);
      assert.equal(r.status, 404, r.text);
      assert.equal(r.text, missing.text, "byte-identical to a Memory that does not exist");
      assert.ok(!r.text.includes("SECRET-LABEL") && !r.text.includes(VIDEO_URL));
    });
  }

  it("a video the owner keeps only_me: its segments are absent, byte-identical to that video having none, and to it not existing", async () => {
    app = await start(seed({ segments: withSegments() }));
    const hidden = await call(app, "GET", `/memories/${MEM}/segments`, VIEWER);
    await app.close();
    app = await start(seed({ segments: withSegments().filter((x) => x.id !== SEG_HIDDEN) }));
    const none = await call(app, "GET", `/memories/${MEM}/segments`, VIEWER);
    await app.close();
    const gone = seed({ segments: withSegments().filter((x) => x.id !== SEG_HIDDEN) });
    gone.memory_items = gone.memory_items.filter((i) => i.id !== ITEM_HIDDEN);
    app = await start(gone);
    const missingItem = await call(app, "GET", `/memories/${MEM}/segments`, VIEWER);
    assert.equal(hidden.status, 200, hidden.text);
    assert.equal(hidden.text, none.text);
    assert.equal(hidden.text, missingItem.text);
    assert.ok(!hidden.text.includes("HIDDEN-LABEL") && !hidden.text.includes(HIDDEN_URL) && !hidden.text.includes(ITEM_HIDDEN));
    assert.deepEqual(json(hidden).segments.map((x: any) => x.label), ["SECRET-LABEL"], "the readable video's label travels with it");
  });

  it("the owner sees every segment, the hidden video's too", async () => {
    app = await start(seed({ segments: withSegments() }));
    const r = json(await call(app, "GET", `/memories/${MEM}/segments`, OWNER));
    assert.deepEqual(r.segments.map((x: any) => x.label), ["SECRET-LABEL", "HIDDEN-LABEL"]);
  });

  it("when the video inherits the Memory's audience, the viewer gets its segment (the control for the case above)", async () => {
    app = await start(seed({ segments: withSegments(), hiddenVisibility: null }));
    const r = json(await call(app, "GET", `/memories/${MEM}/segments`, VIEWER));
    assert.deepEqual(r.segments.map((x: any) => x.label), ["SECRET-LABEL", "HIDDEN-LABEL"]);
  });

  it("FAIL CLOSED: the hidden-set read fails ⇒ 503 for a reader; a non-reader still gets the missing Memory's 404", async () => {
    app = await start(seed({ segments: withSegments() }), { fail: ["memory_items:hidden"] });
    const r = await call(app, "GET", `/memories/${MEM}/segments`, VIEWER);
    assert.equal(r.status, 503, r.text);
    assert.ok(!r.text.includes("LABEL"));
    await app.close();
    app = await start(seed({ memory: { visibility: "only_me" }, segments: withSegments() }), { fail: ["memory_items:hidden"] });
    const nr = await call(app, "GET", `/memories/${MEM}/segments`, VIEWER);
    assert.equal(nr.status, 404);
    assert.equal(nr.text, (await call(app, "GET", `/memories/${MISSING}/segments`, VIEWER)).text);
  });

  it("an unreadable segments table is a 503 for a reader (never 'no segments'), and the missing Memory's 404 for a non-reader", async () => {
    app = await start(seed({ segments: withSegments() }), { fail: ["memory_media_segments:select"] });
    const r = await call(app, "GET", `/memories/${MEM}/segments`, VIEWER);
    assert.equal(r.status, 503, r.text);
    await app.close();
    app = await start(seed({ memory: { visibility: "only_me" }, segments: withSegments() }), { fail: ["memory_media_segments:select"] });
    const nr = await call(app, "GET", `/memories/${MEM}/segments`, VIEWER);
    assert.equal(nr.text, (await call(app, "GET", `/memories/${MISSING}/segments`, VIEWER)).text);
  });

  it("an unreadable item list is a 503, never segments served without their items", async () => {
    app = await start(seed({ segments: withSegments() }), { fail: ["memory_items:select"] });
    const r = await call(app, "GET", `/memories/${MEM}/segments`, VIEWER);
    assert.equal(r.status, 503, r.text);
    assert.ok(!r.text.includes("LABEL"));
  });

  it("an unreadable memories row is the same 503 for a Memory that exists and one that does not", async () => {
    app = await start(seed({ segments: withSegments() }), { fail: ["memories:select"] });
    const a = await call(app, "GET", `/memories/${MEM}/segments`, STRANGER);
    const b = await call(app, "GET", `/memories/${MISSING}/segments`, STRANGER);
    assert.equal(a.status, 503);
    assert.equal(a.text, b.text);
  });

  it("3809 not applied: a reader is told none are available (true: none can exist); a non-reader gets the missing Memory's 404", async () => {
    app = await start(seed(), { noSegmentsTable: true });
    const r = await call(app, "GET", `/memories/${MEM}/segments`, VIEWER);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(json(r), { memoryId: MEM, available: false, segments: [] });
    await app.close();
    app = await start(seed({ memory: { visibility: "only_me" } }), { noSegmentsTable: true });
    const nr = await call(app, "GET", `/memories/${MEM}/segments`, VIEWER);
    assert.equal(nr.text, (await call(app, "GET", `/memories/${MISSING}/segments`, VIEWER)).text);
  });
});

describe("D. only the owner writes", () => {
  it("a viewer who may READ the Memory cannot mark a segment: the missing Memory's 404, nothing written", async () => {
    app = await start(seed());
    const r = await post(app, VIEWER, ITEM_VIDEO, { startMs: 0, endMs: 1_000 });
    const missing = await post(app, VIEWER, ITEM_VIDEO, { startMs: 0, endMs: 1_000 }, MISSING);
    assert.equal(r.status, 404, r.text);
    assert.equal(r.text, missing.text, "byte-identical: the status is no existence oracle");
    assert.deepEqual(app.rec.writes, []);
    assert.deepEqual(app.rec.storage, []);
  });

  it("nor remove the owner's: the missing Memory's 404, and the row stays", async () => {
    app = await start(seed({ segments: [segment(SEG_A, ITEM_VIDEO, 1_000, 5_000, "Sunset")] }));
    const r = await call(app, "DELETE", `/memories/${MEM}/segments/${SEG_A}`, VIEWER);
    const missing = await call(app, "DELETE", `/memories/${MISSING}/segments/${SEG_A}`, VIEWER);
    assert.equal(r.status, 404);
    assert.equal(r.text, missing.text);
    assert.equal(app.store.memory_media_segments.length, 1);
    assert.deepEqual(app.rec.writes, []);
  });

  it("the owner's own deleted Memory is the same 404", async () => {
    app = await start(seed({ memory: { state: "deleted" } }));
    const r = await post(app, OWNER, ITEM_VIDEO, { startMs: 0, endMs: 1_000 });
    assert.equal(r.text, (await post(app, OWNER, ITEM_VIDEO, { startMs: 0, endMs: 1_000 }, MISSING)).text);
    assert.equal(app.store.memory_media_segments.length, 0);
  });

  it("an item of the owner's OTHER Memory cannot be marked through this one", async () => {
    app = await start(seed());
    const r = await post(app, OWNER, ITEM_ON_OTHER, { startMs: 0, endMs: 1_000 });
    assert.equal(r.status, 404, r.text);
    assert.equal(json(r).message, "Item not found");
    assert.equal(app.store.memory_media_segments.length, 0);
  });

  it("a segment of the owner's other Memory cannot be removed through this one", async () => {
    app = await start(seed({ segments: [segment(SEG_A, ITEM_ON_OTHER, 0, 1_000, null, MEM_OTHER)] }));
    const r = await call(app, "DELETE", `/memories/${MEM}/segments/${SEG_A}`, OWNER);
    assert.equal(r.status, 404, r.text);
    assert.equal(json(r).message, "Segment not found");
    assert.equal(app.store.memory_media_segments.length, 1);
  });

  it("3809 not applied: the owner's writes answer 404 feature_disabled", async () => {
    app = await start(seed(), { noSegmentsTable: true });
    const p = await post(app, OWNER, ITEM_VIDEO, { startMs: 0, endMs: 1_000 });
    assert.equal(p.status, 404); assert.equal(json(p).error, "feature_disabled");
    const d = await call(app, "DELETE", `/memories/${MEM}/segments/${SEG_A}`, OWNER);
    assert.equal(d.status, 404); assert.equal(json(d).error, "feature_disabled");
  });

  it("a failed insert or delete is a 503, never a success", async () => {
    app = await start(seed({ segments: [segment(SEG_A, ITEM_VIDEO, 1_000, 5_000, null)] }), { fail: ["memory_media_segments:insert", "memory_media_segments:delete"] });
    assert.equal((await post(app, OWNER, ITEM_VIDEO, { startMs: 0, endMs: 1_000 })).status, 503);
    assert.equal((await call(app, "DELETE", `/memories/${MEM}/segments/${SEG_A}`, OWNER)).status, 503);
  });
});

describe("E. the shape", () => {
  it("start must be before end, both whole and non-negative; a label is trimmed, bounded, and empty means none", async () => {
    app = await start(seed());
    for (const body of [
      { startMs: 5_000, endMs: 5_000 }, { startMs: 6_000, endMs: 5_000 }, { startMs: -1, endMs: 5_000 },
      { startMs: 0.5, endMs: 5_000 }, { startMs: "0", endMs: 5_000 }, { endMs: 5_000 },
      { startMs: 0, endMs: 5_000, label: "x".repeat(SEGMENT_LABEL_MAX + 1) }, { startMs: 0, endMs: 5_000, label: 7 },
    ]) {
      const r = await post(app, OWNER, ITEM_VIDEO, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.text}`);
    }
    assert.equal(app.store.memory_media_segments.length, 0);
    const blank = await post(app, OWNER, ITEM_VIDEO, { startMs: 0, endMs: 1_000, label: "   " });
    assert.equal(json(blank).segment.label, null);
    const full = await post(app, OWNER, ITEM_VIDEO, { startMs: 0, endMs: 2_000, label: "y".repeat(SEGMENT_LABEL_MAX) });
    assert.equal(full.status, 201);
  });

  it("the same window twice is a 409, not a second row", async () => {
    app = await start(seed());
    assert.equal((await post(app, OWNER, ITEM_VIDEO, { startMs: 0, endMs: 1_000 })).status, 201);
    const again = await post(app, OWNER, ITEM_VIDEO, { startMs: 0, endMs: 1_000, label: "again" });
    assert.equal(again.status, 409, again.text);
    assert.equal(app.store.memory_media_segments.length, 1);
  });

  it(`a video carries at most ${SEGMENTS_PER_ITEM_MAX} segments`, async () => {
    const segs = Array.from({ length: SEGMENTS_PER_ITEM_MAX }, (_, i) => segment(`6${String(i).padStart(7, "0")}-1111-4111-8111-111111111111`, ITEM_VIDEO, i * 100, i * 100 + 50, null));
    app = await start(seed({ segments: segs }));
    const r = await post(app, OWNER, ITEM_VIDEO, { startMs: 20_000, endMs: 21_000 });
    assert.equal(r.status, 409, r.text);
    assert.equal(app.store.memory_media_segments.length, SEGMENTS_PER_ITEM_MAX);
    app.store.memory_media_segments.pop();
    assert.equal((await post(app, OWNER, ITEM_VIDEO, { startMs: 20_000, endMs: 21_000 })).status, 201, "one under the cap is accepted");
  });

  it("GET orders by the item's place in the Memory, then by start and end", async () => {
    app = await start(seed({ segments: [
      segment(SEG_B, ITEM_ABSOLUTE, 0, 1_000, "abs"),
      segment(SEG_A, ITEM_VIDEO, 9_000, 10_000, "late"),
      segment(SEG_HIDDEN, ITEM_VIDEO, 1_000, 3_000, "early"),
    ] }));
    const r = json(await call(app, "GET", `/memories/${MEM}/segments`, OWNER));
    assert.deepEqual(r.segments.map((x: any) => x.label), ["early", "late", "abs"]);
    assert.deepEqual(Object.keys(r.segments[0]).sort(), ["endMs", "id", "itemId", "label", "mediaType", "mediaUrl", "startMs"]);
  });
});

describe("the pure rules", () => {
  it("toSegmentRow drops a row the CHECKs forbid rather than serving it", () => {
    const ok = { id: SEG_A, item_id: ITEM_VIDEO, start_ms: 0, end_ms: 10, label: null };
    assert.deepEqual(toSegmentRow(ok), { id: SEG_A, itemId: ITEM_VIDEO, startMs: 0, endMs: 10, label: null });
    for (const bad of [
      { ...ok, start_ms: 10 }, { ...ok, start_ms: -1 }, { ...ok, end_ms: 10.5 }, { ...ok, start_ms: "0" },
      { ...ok, label: "" }, { ...ok, label: "z".repeat(SEGMENT_LABEL_MAX + 1) }, { ...ok, label: 3 }, { ...ok, item_id: null }, null,
    ]) assert.equal(toSegmentRow(bad), null, JSON.stringify(bad));
  });
  it("windowWithin: the end may equal the measured length, never pass it", () => {
    assert.deepEqual(windowWithin(0, 1_000, 1_000), { ok: true });
    assert.equal(windowWithin(0, 1_001, 1_000).ok, false);
    assert.equal(windowWithin(500, 500, 1_000).ok, false);
  });
  it("isVideoMediaType reads the stored type, case-insensitively", () => {
    for (const t of ["video", "video/mp4", "VIDEO/QUICKTIME", " video/webm "]) assert.equal(isVideoMediaType(t), true, t);
    for (const t of ["image/jpeg", "videos/mp4", "", null, undefined, 5]) assert.equal(isVideoMediaType(t), false, String(t));
  });
  it("measuredDurationFor never reads an object outside our storage, and names why a length is unknown", async () => {
    const rec: Recorder = { storage: [], writes: [] };
    const sc = makeClient(seed(), rec);
    assert.deepEqual(await measuredDurationFor(sc, OWNER, EXTERNAL_URL), { state: "unknown", why: "external_media" });
    assert.deepEqual(await measuredDurationFor(sc, OWNER, VIDEO_URL), { state: "measured", durationMs: DURATION });
    assert.deepEqual(await measuredDurationFor(sc, STRANGER, VIDEO_URL), { state: "unknown", why: "not_owners_asset" });
    assert.deepEqual(await measuredDurationFor(sc, OWNER, `post-media/${OWNER}/nope.mp4`), { state: "unknown", why: "no_asset" });
    assert.deepEqual(rec.storage, []);
  });
});
