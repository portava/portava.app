/**
 * §10 "Media visibility is independent from Memory visibility" — a photo's own
 * audience (migration 3672, `memory_items.visibility`). Census H80.
 *
 * Over the real routers: the owner keeps one photo of a public Memory to
 * themselves; a non-owner is served neither its URL nor its caption on the
 * detail read, the list covers or the trip Memory cover, while the owner still
 * sees it. A hidden-set read that fails refuses (fail closed); a database
 * without 3672 (the column absent) serves today's behaviour, which is true —
 * no photo can be hidden there.
 *
 * Run: node --import tsx/esm --test src/test/memoryItemVisibility.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import itemVisibilityRouter from "../routes/memoryItemVisibility.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEM = "11111111-1111-4111-8111-111111111111";
const TRIP = "44444444-4444-4444-8444-444444444444";
const ITEM_COVER = "21111111-1111-4111-8111-111111111111";
const ITEM_OTHER = "21111111-1111-4111-8111-111111111112";
const COVER_URL = "post-media/memories/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cover-PRIVATE.jpg";
const OTHER_URL = "post-media/memories/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/second.jpg";

function seed(coverVisibility: string | null = "only_me"): Record<string, any[]> {
  return {
    feature_flags: [], blocks: [],
    memories: [{
      id: MEM, owner_id: OWNER, title: "Dinner", caption: null, visibility: "public",
      allowed_user_ids: [], hidden_user_ids: [], trip_id: TRIP, event_id: null, place_id: null,
      location_city: null, location_country: null, location_lat: null, location_lng: null,
      canonical_location_id: null, starts_at: null, ends_at: null, state: "published",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    }],
    memory_items: [
      { id: ITEM_COVER, memory_id: MEM, media_url: COVER_URL, media_type: "image/jpeg", caption: "SECRET-CAPTION", position: 0, created_at: "2026-01-01T00:00:00.000Z", visibility: coverVisibility },
      { id: ITEM_OTHER, memory_id: MEM, media_url: OTHER_URL, media_type: "image/jpeg", caption: "fine", position: 1, created_at: "2026-01-01T00:00:00.000Z", visibility: null },
    ],
    memory_tags: [], memory_likes: [], memory_saves: [{ memory_id: MEM, user_id: VIEWER, created_at: "2026-01-02T00:00:00.000Z" }],
    trips: [{ id: TRIP, owner_id: OWNER, title: "T", status: "active", visibility: "public" }],
    trip_members: [
      { trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" },
    ],
    profiles: [
      { id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null },
      { id: VIEWER, account_status: "active", name: "Viewer", handle: "viewer", avatar_url: null },
    ],
  };
}

interface FakeOpts {
  /** 3672 not applied: naming `visibility` on memory_items is a 42703. */
  noColumn?: boolean;
  /** The hidden-set read fails (only the read that filters on visibility). */
  failHiddenRead?: boolean;
}

function makeClient(store: Record<string, any[]>, opts: FakeOpts = {}) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const named: string[] = [];
    let mode: "select" | "update" | "insert" | "delete" | "upsert" = "select";
    let payload: any = null; let wantRows = false; let single = false; let countMode = false;
    const f = (c: string, p: (r: any) => boolean) => { named.push(c); filters.push(p); return obj; };
    const obj: any = {
      select(_c?: string, o?: any) { if (mode !== "select") wantRows = true; if (o?.count === "exact" && o?.head) countMode = true; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      upsert(d: any) { mode = "upsert"; payload = d; return obj; },
      delete() { mode = "delete"; return obj; },
      eq: (c: string, v: any) => f(c, (r) => r[c] === v),
      neq: (c: string, v: any) => f(c, (r) => r[c] !== v),
      in: (c: string, vs: any[]) => f(c, (r) => vs.includes(r[c])),
      is: (c: string, v: any) => f(c, (r) => (v === null ? r[c] == null : r[c] === v)),
      gte() { return obj; }, lte() { return obj; }, gt() { return obj; }, lt() { return obj; },
      not() { return obj; }, or() { return obj; }, order() { return obj; }, limit() { return obj; }, range() { return obj; },
      contains() { return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(ok: any, bad: any) { return run().then(ok, bad); },
    };
    async function run(): Promise<any> {
      const touchesColumn = table === "memory_items" && (named.includes("visibility") || (payload && Object.prototype.hasOwnProperty.call(payload, "visibility")));
      if (touchesColumn && opts.noColumn) return { data: null, error: { code: "42703", message: "column memory_items.visibility does not exist" } };
      if (touchesColumn && mode === "select" && opts.failHiddenRead) return { data: null, error: { code: "57014", message: "memory_items read failed" } };
      const all = (store[table] ??= []);
      const matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode === "update") { for (const r of matched) Object.assign(r, payload); return { data: wantRows ? matched.map((x) => ({ ...x })) : null, error: null }; }
      if (mode === "insert" || mode === "upsert") return { data: null, error: null };
      if (mode === "delete") return { data: null, error: null };
      if (countMode) return { data: null, error: null, count: matched.length };
      if (single) return { data: matched[0] ? { ...matched[0] } : null, error: null };
      return { data: matched.map((x) => ({ ...x })), error: null };
    }
    return obj;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: [], error: null }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App { base: string; store: Record<string, any[]>; close: () => Promise<void> }
async function start(store: Record<string, any[]>, opts: FakeOpts = {}): Promise<App> {
  _setTestClient(makeClient(store, opts) as any, true);
  const ex = express();
  ex.use(express.json());
  ex.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  ex.use("/api", itemVisibilityRouter);
  ex.use("/api", memoriesRouter);
  const srv = http.createServer(ex);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
async function call(a: App, method: string, path: string, actor: string, body?: unknown) {
  const res = await fetch(`${a.base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

let app: App | null = null;
afterEach(async () => { if (app) { await app.close(); app = null; } });

describe("GET /memories/:id — a photo kept only_me", () => {
  it("a non-owner gets neither its URL nor its caption, and still gets the other photo", async () => {
    app = await start(seed());
    const r = await call(app, "GET", `/memories/${MEM}`, VIEWER);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(!r.text.includes(COVER_URL), "the private photo's URL");
    assert.ok(!r.text.includes("SECRET-CAPTION"), "the private photo's caption");
    assert.ok(r.text.includes(OTHER_URL), "the inherited photo is still served");
  });

  it("the owner sees every photo", async () => {
    app = await start(seed());
    const r = await call(app, "GET", `/memories/${MEM}`, OWNER);
    assert.ok(r.text.includes(COVER_URL) && r.text.includes("SECRET-CAPTION") && r.text.includes(OTHER_URL));
  });

  it("FAIL CLOSED: the hidden-set read fails ⇒ 503, never the photos unchecked", async () => {
    app = await start(seed(), { failHiddenRead: true });
    const r = await call(app, "GET", `/memories/${MEM}`, VIEWER);
    assert.equal(r.status, 503, r.text.slice(0, 300));
    assert.ok(!r.text.includes(COVER_URL));
  });

  it("3672 not applied (the column is absent): today's behaviour — no photo can be hidden, so all are served", async () => {
    app = await start(seed(null), { noColumn: true });
    const r = await call(app, "GET", `/memories/${MEM}`, VIEWER);
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(COVER_URL) && r.text.includes(OTHER_URL));
  });
});

describe("the covers — a non-owner never gets a private photo as a Memory's cover", () => {
  for (const [site, path] of [
    ["the feed", "/memories"],
    ["a profile's Memories", `/users/${OWNER}/memories`],
    ["the saved shelf", "/me/saved-memories"],
    ["a trip's Memory", `/trips/${TRIP}/memory`],
  ] as const) {
    it(`${site}: the private cover is withheld from a non-owner (and served when the photo inherits)`, async () => {
      app = await start(seed(null));
      const control = await call(app, "GET", path, VIEWER);
      assert.equal(control.status, 200, `${path} control: ${control.text.slice(0, 300)}`);
      assert.ok(control.text.includes(COVER_URL), `${path} control must serve the cover, or this case proves nothing: ${control.text.slice(0, 300)}`);
      await app.close();
      app = await start(seed("only_me"));
      const r = await call(app, "GET", path, VIEWER);
      assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 300)}`);
      assert.ok(r.text.includes(MEM), `${path} still serves the Memory`);
      assert.ok(!r.text.includes(COVER_URL), `${path} served a private cover`);
    });
  }

  it("a list whose hidden-set read fails refuses (503) rather than serving covers it could not check", async () => {
    app = await start(seed(), { failHiddenRead: true });
    const r = await call(app, "GET", `/users/${OWNER}/memories`, VIEWER);
    assert.equal(r.status, 503, r.text.slice(0, 300));
  });
});

describe("PUT /memories/:id/items/:itemId/visibility — the owner's switch", () => {
  it("the owner keeps a photo private, then shares it again", async () => {
    app = await start(seed(null));
    assert.equal((await call(app, "PUT", `/memories/${MEM}/items/${ITEM_OTHER}/visibility`, OWNER, { visibility: "only_me" })).status, 204);
    assert.equal(app.store.memory_items.find((i) => i.id === ITEM_OTHER).visibility, "only_me");
    assert.equal((await call(app, "PUT", `/memories/${MEM}/items/${ITEM_OTHER}/visibility`, OWNER, { visibility: null })).status, 204);
    assert.equal(app.store.memory_items.find((i) => i.id === ITEM_OTHER).visibility, null);
  });

  it("someone else, a photo not on this Memory, and an unknown value are refused, and nothing changes", async () => {
    app = await start(seed(null));
    assert.equal((await call(app, "PUT", `/memories/${MEM}/items/${ITEM_OTHER}/visibility`, VIEWER, { visibility: "only_me" })).status, 404);
    assert.equal((await call(app, "PUT", `/memories/${MEM}/items/31111111-1111-4111-8111-111111111111/visibility`, OWNER, { visibility: "only_me" })).status, 404);
    assert.equal((await call(app, "PUT", `/memories/${MEM}/items/${ITEM_OTHER}/visibility`, OWNER, { visibility: "public" })).status, 400);
    assert.equal(app.store.memory_items.find((i) => i.id === ITEM_OTHER).visibility, null);
  });

  it("3672 not applied: feature_disabled (404)", async () => {
    app = await start(seed(null), { noColumn: true });
    assert.equal((await call(app, "PUT", `/memories/${MEM}/items/${ITEM_OTHER}/visibility`, OWNER, { visibility: "only_me" })).status, 404);
  });
});
