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
import { deriveProjection, rebuildProjection, projectionStaleness } from "../services/memoryProjections/derivativeRegistry.js"; import { recapAdmits, sharedAudienceAdmits } from "../services/memoryProjections/projectionRegistry.js";
import { hiddenItemKeys, ITEM_PAGE } from "../services/memory/memoryItemVisibility.js";
import { readMemoryControls, readRecapControls, CONTROLS_PAGE } from "../services/memory/memoryResurfacingControls.js";

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
    let payload: any = null; let selected: string | null = null; let wantRows = false; let single = false; let countMode = false; let onConflict: string[] = [];
    const f = (c: string, p: (r: any) => boolean) => { named.push(c); filters.push(p); return obj; };
    const obj: any = {
      select(c?: string, o?: any) { if (mode !== "select") wantRows = true; else if (typeof c === "string") selected = c; if (o?.count === "exact" && o?.head) countMode = true; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      upsert(d: any, o?: any) { mode = "upsert"; payload = d; onConflict = String(o?.onConflict ?? "").split(",").filter(Boolean); return obj; },
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
      if (mode === "insert" || mode === "upsert") {
        const written: any[] = [];
        for (const r of (Array.isArray(payload) ? payload : [payload])) {
          const had = onConflict.length ? all.find((x) => onConflict.every((k) => x[k] === r[k])) : null;
          if (had) { Object.assign(had, r); written.push(had); } else { const row = { id: r.id ?? `row-${all.length + 1}`, ...r }; all.push(row); written.push(row); }
        }
        return { data: wantRows ? written.map((x) => ({ ...x })) : null, error: null };
      }
      if (mode === "delete") return { data: null, error: null };
      if (countMode) return { data: null, error: null, count: matched.length };
      const project = (r: any) => (table === "memory_items" && selected && !/[*()]/.test(selected) ? Object.fromEntries(selected.split(",").map((k) => k.trim()).filter((k) => k in r).map((k) => [k, r[k]])) : { ...r }); /* VERIFY-H4 H4-2: a memory_items read gets only the columns it selected, as from PostgREST */ if (single) return { data: matched[0] ? project(matched[0]) : null, error: null };
      return { data: matched.map((x) => project(x)), error: null };
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

// ── §AN: a hidden photo is never COUNTED for a non-owner ─────────────────────
const countOf = (text: string) => { const m = /"media_count":(\d+)/.exec(text); return m ? Number(m[1]) : null; };
const PUBLIC_SCOPE = { owner_id: OWNER, viewer_id: null, trip_id: null, place_id: null, person_id: null };
const OWNER_SCOPE = { owner_id: OWNER, viewer_id: OWNER, trip_id: null, place_id: null, person_id: null };
const projected = (r: any) => (r.ok ? r.value.rows.find((x: any) => x.memory_id === MEM) : null);

describe("§AN — photo counts exclude a private photo for anyone but the owner", () => {
  for (const [site, path] of [
    ["the trip recap", `/trips/${TRIP}/memories/recap`],
    ["a profile's Memory highlights", `/users/${OWNER}/memories/highlights`],
  ] as const) {
    it(`${site}: the owner counts 2, a non-owner counts 1, and an unreadable photo audience refuses (503)`, async () => {
      app = await start(seed("only_me"));
      const owner = await call(app, "GET", path, OWNER);
      assert.equal(owner.status, 200, owner.text.slice(0, 300));
      assert.equal(countOf(owner.text), 2, `owner control must carry media_count 2: ${owner.text.slice(0, 300)}`);
      const viewer = await call(app, "GET", path, VIEWER);
      assert.equal(viewer.status, 200, viewer.text.slice(0, 300));
      assert.equal(countOf(viewer.text), 1);
      await app.close();
      app = await start(seed("only_me"), { failHiddenRead: true });
      assert.equal((await call(app, "GET", path, VIEWER)).status, 503);
    });
  }

  it("the registered PublicMemoryProjection counts 1; the owner's timeline counts 2; hiding a photo makes the public registration STALE", async () => {
    const store = seed(null);
    store.memory_derivative_registry = [];
    const client = makeClient(store) as any;
    const first = await rebuildProjection(client, "PublicMemoryProjection", PUBLIC_SCOPE, new Date("2026-10-07T12:00:00.000Z"));
    assert.equal(projected(first)?.media_count, 2);
    store.memory_items.find((i) => i.id === ITEM_COVER).visibility = "only_me";
    const stale = await projectionStaleness(client, "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(stale.ok && stale.value.state === "STALE", "a photo's audience is part of the source version");
    assert.equal(projected(await deriveProjection(client, "PublicMemoryProjection", PUBLIC_SCOPE))?.media_count, 1);
    assert.equal(projected(await deriveProjection(client, "MemoryTimelineProjection", OWNER_SCOPE))?.media_count, 2);
  });

  it("FAIL CLOSED in the registry: an unreadable photo audience refuses a non-owner projection; the owner's own still builds", async () => {
    const client = makeClient(seed("only_me"), { failHiddenRead: true }) as any;
    const pub = await deriveProjection(client, "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.deepEqual([pub.ok, (pub as any).reason, (pub as any).table], [false, "source_unavailable", "memory_items"]);
    assert.equal(projected(await deriveProjection(client, "MemoryTimelineProjection", OWNER_SCOPE))?.media_count, 2);
  });
});

// ── VERIFY-H3 H3-4 / H3-5 ────────────────────────────────────────────────────
describe("H3-4 / H3-5 — the switch is scoped to its Memory, and covers are judged per Memory", () => {
  it("H3-4: owner A cannot flip the audience of a photo on owner B's Memory through A's own Memory id (404, B's row unchanged)", async () => {
    const store = seed(null);
    const B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const B_MEM = "12222222-2222-4222-8222-222222222222";
    const B_ITEM = "22222222-2222-4222-8222-222222222299";
    store.memories.push({ ...store.memories[0], id: B_MEM, owner_id: B });
    store.memory_items.push({ id: B_ITEM, memory_id: B_MEM, media_url: "b.jpg", media_type: "image/jpeg", caption: null, position: 0, created_at: "2026-01-01T00:00:00.000Z", visibility: "only_me" });
    app = await start(store);
    const r = await call(app, "PUT", `/memories/${MEM}/items/${B_ITEM}/visibility`, OWNER, { visibility: null });
    assert.equal(r.status, 404, r.text);
    assert.equal(app.store.memory_items.find((i) => i.id === B_ITEM).visibility, "only_me");
  });

  it("H3-5: a page of TWO Memories — the first one's inherited cover is served, the second one's private cover is withheld", async () => {
    const store = seed(null);
    const MEM2 = "11111111-1111-4111-8111-111111111112";
    store.memories.push({ ...store.memories[0], id: MEM2, created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" });
    store.memory_items.push({ id: "21111111-1111-4111-8111-111111111199", memory_id: MEM2, media_url: "post-media/memories/x/second-memory-PRIVATE.jpg", media_type: "image/jpeg", caption: null, position: 0, created_at: "2026-01-02T00:00:00.000Z", visibility: "only_me" });
    app = await start(store);
    const r = await call(app, "GET", `/users/${OWNER}/memories`, VIEWER);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.text.includes(MEM) && r.text.includes(MEM2), "both Memories are served");
    assert.ok(r.text.includes(COVER_URL), "the first Memory's inherited cover is served");
    assert.ok(!r.text.includes("second-memory-PRIVATE"), "the second Memory's private cover is withheld");
  });
});

// ── VERIFY-H3 H3-7: a FULL page fails CLOSED (PostgREST truncates silently) ──
describe("H3-7 — reads that could be truncated fail closed", () => {
  it("hiddenItemKeys: a full page of hidden photos is ok:false, never a set missing the ones past the page", async () => {
    const store = seed(null);
    for (let i = 0; i < ITEM_PAGE; i += 1) store.memory_items.push({ id: `h-${i}`, memory_id: MEM, media_url: `u${i}`, media_type: "image/jpeg", caption: null, position: 10 + i, created_at: "x", visibility: "only_me" });
    const r = await hiddenItemKeys(makeClient(store), [MEM]);
    assert.equal(r.ok, false);
    const fewer = seed("only_me");
    const ok = await hiddenItemKeys(makeClient(fewer), [MEM]);
    assert.ok(ok.ok && ok.keys.has(`${MEM}#0`));
  });

  it("the controls reads: a full page is unreadable (and the recap that needs it is refused)", async () => {
    const store = seed(null);
    store.memory_resurfacing_preferences = Array.from({ length: CONTROLS_PAGE }, (_, i) => ({ memory_id: i === 0 ? MEM : `m-${i}`, owner_id: OWNER, control: "DO_NOT_INCLUDE_IN_RECAPS" }));
    assert.equal((await readRecapControls(makeClient(store), OWNER, [MEM])).state, "unreadable");
    const ids = store.memory_resurfacing_preferences.map((r) => r.memory_id);
    assert.equal((await readMemoryControls(makeClient(store), OWNER, ids)).state, "unreadable");
    app = await start(store);
    assert.equal((await call(app, "GET", `/trips/${TRIP}/memories/recap`, VIEWER)).status, 503);
  });
});

// ── VERIFY-H4 (1dbeab8004): H4-1, H4-3, H4-4 ────────────────────────────────
describe("VERIFY-H4 — the cases the delta verifier found missing", () => {
  const VIEWER_SCOPE = { owner_id: OWNER, viewer_id: VIEWER, trip_id: TRIP, place_id: null, person_id: null };
  const row = (over: Record<string, unknown>) => ({ ...seed().memories[0], ...over }) as any;

  it("H4-1: a named viewer is in a `custom` audience only when the list names them (and the list is the control)", () => {
    assert.equal(sharedAudienceAdmits({ scope: VIEWER_SCOPE }, row({ visibility: "custom", allowed_user_ids: [] })), false);
    assert.equal(sharedAudienceAdmits({ scope: VIEWER_SCOPE }, row({ visibility: "custom", allowed_user_ids: ["someone-else"] })), false);
    assert.equal(sharedAudienceAdmits({ scope: VIEWER_SCOPE }, row({ visibility: "custom", allowed_user_ids: [VIEWER] })), true);
  });

  it("H4-1: unreadable recap controls (null) admit no Memory to a recap; an empty set admits it", () => {
    assert.equal(recapAdmits({ recapExcluded: null }, MEM), false);
    assert.equal(recapAdmits({ recapExcluded: new Set<string>() }, MEM), true);
    assert.equal(recapAdmits({ recapExcluded: new Set([MEM]) }, MEM), false);
  });

  it("H4-3: the registered TripMemoryProjection is source_unavailable on a FULL page of controls (999 rows builds)", async () => {
    const scope = { owner_id: OWNER, viewer_id: OWNER, trip_id: TRIP, place_id: null, person_id: null };
    const controls = (n: number) => Array.from({ length: n }, (_, i) => ({ memory_id: i === 0 ? MEM : `m-${i}`, owner_id: OWNER, control: "DO_NOT_RESURFACE" }));
    const under = seed(null); under.memory_resurfacing_preferences = controls(999);
    const ok = await deriveProjection(makeClient(under) as any, "TripMemoryProjection", scope);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const full = seed(null); full.memory_resurfacing_preferences = controls(1000);
    const refused = await deriveProjection(makeClient(full) as any, "TripMemoryProjection", scope);
    assert.deepEqual([refused.ok, (refused as any).reason, (refused as any).table], [false, "source_unavailable", "memory_resurfacing_preferences"]);
  });

  it("H4-4: rebuilt WITH a hidden photo present, the public registration is FRESH (the hidden set is in the version on both sides)", async () => {
    const store = seed("only_me");
    store.memory_derivative_registry = [];
    const client = makeClient(store) as any;
    const built = await rebuildProjection(client, "PublicMemoryProjection", PUBLIC_SCOPE, new Date("2026-10-07T12:00:00.000Z"));
    assert.equal(projected(built)?.media_count, 1);
    const fresh = await projectionStaleness(client, "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(fresh.ok && fresh.value.state === "FRESH", JSON.stringify(fresh));
  });
});

// ── Lead ruling H-16 (lane H, 2026-10-08): the crew's recap shows a Memory's ──
// place only through its owner's corrections (3673). Appended: cited by line.
describe("H-16 — the trip recap a crew member reads carries no place its owner rejected", () => {
  const STORED = "osm:node/777";
  const placed = (corrections: any[]) => { const s = seed(null); s.memories[0].place_id = STORED; s.memory_corrections = corrections; return s; };
  const reject = { id: "c-1", memory_id: MEM, owner_id: OWNER, field: "place", kind: "reject", place_id: STORED, canonical_location_id: null, source: "correction_route", created_at: "2026-10-07T00:00:00.000Z" };
  const recap = (actor: string) => call(app!, "GET", `/trips/${TRIP}/memories/recap`, actor);

  it("control: the crew member's recap carries the stored place; once the owner rejects it, it does not — the owner's own recap still does", async () => {
    app = await start(placed([]));
    const before = await recap(VIEWER);
    assert.equal(before.status, 200, before.text.slice(0, 300));
    assert.ok(before.text.includes(STORED), `control: ${before.text.slice(0, 400)}`);
    await app.close();
    app = await start(placed([reject]));
    const after = await recap(VIEWER);
    assert.equal(after.status, 200, after.text.slice(0, 300));
    assert.ok(!after.text.includes(STORED), after.text.slice(0, 400));
    assert.ok((await recap(OWNER)).text.includes(STORED), "the owner's own recap is the stored row");
  });

  it("unreadable corrections: the crew member's recap REFUSES (503); the owner's is unaffected", async () => {
    const store = placed([reject]);
    app = await start(store);
    const base = makeClient(store);
    _setTestClient({ ...base, from: (t: string) => { const c = base.from(t); if (t === "memory_corrections") c.then = (ok: any, bad: any) => Promise.resolve({ data: null, error: { code: "57014", message: "corrections read failed" } }).then(ok, bad); return c; } } as any, true);
    assert.equal((await recap(VIEWER)).status, 503);
    assert.equal((await recap(OWNER)).status, 200);
  });
});

// ── VERIFY-H6 H6-7 (d3165ddff3): the crew's recap runs the place check BEFORE ──
// the location protection, so an assertion never re-adds a place the rung withholds.
describe("VERIFY-H6 H6-7 — the crew's recap: an owner's ASSERTION never re-adds a place their rung withholds", () => {
  const ASSERTED = "osm:node/888";
  const store = (rung: string) => {
    const s = seed(null);
    s.feature_flags.push({ flag: "memory_location_precision_enabled", enabled: true });
    Object.assign(s.memories[0], { place_id: null, location_precision: rung });
    s.memory_corrections = [{ id: "c-9", memory_id: MEM, owner_id: OWNER, field: "place", kind: "assert", place_id: ASSERTED, canonical_location_id: null, source: "memory_edit", created_at: "2026-10-07T00:00:00.000Z" }];
    return s;
  };
  const recap = (actor: string) => call(app!, "GET", `/trips/${TRIP}/memories/recap`, actor);

  it("control: at the venue rung the crew member's recap carries the ASSERTED place", async () => {
    app = await start(store("venue"));
    const r = await recap(VIEWER);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.text.includes(ASSERTED), r.text.slice(0, 400));
  });

  it("at the city rung it does not — the asserted place is corrected first, then withheld by the rung", async () => {
    app = await start(store("city"));
    const r = await recap(VIEWER);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(!r.text.includes(ASSERTED), r.text.slice(0, 400));
    assert.ok((await recap(OWNER)).text.includes("Dinner"), "the owner's own recap still reads");
  });
});

// ── Lead ruling H-17 (2026-10-08): the crew's recap drops a reference whose ──
// automatic match is a place the owner rejected. Appended: cited by line.
describe("H-17 — the crew's recap: the owner rejected the auto-matched place, so the Memory carries no place for the crew", () => {
  const PICK = "osm:node/999";
  const CANON = "31111111-1111-4111-8111-111111111111";
  const P = "32222222-2222-4222-8222-222222222222";
  const store = (rejected: boolean) => {
    const s = seed(null);
    Object.assign(s.memories[0], { place_id: PICK, canonical_location_id: CANON });
    s.places = [{ id: P, name: "Auto-matched", primary_category: "food", latitude: 1, longitude: 1, address: null, city: "X", country_code: "XX", status: "active", merged_into_place_id: null, canonical_location_id: CANON }];
    s.memory_corrections = rejected ? [{ id: "c-17", memory_id: MEM, owner_id: OWNER, field: "place", kind: "reject", place_id: P, canonical_location_id: null, source: "correction_route", created_at: "2026-10-08T00:00:00.000Z" }] : [];
    return s;
  };
  const recap = (actor: string) => call(app!, "GET", `/trips/${TRIP}/memories/recap`, actor);

  it("control: before the rejection the crew member's recap carries the stored pick", async () => {
    app = await start(store(false));
    const r = await recap(VIEWER);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.text.includes(PICK), r.text.slice(0, 400));
  });

  it("after it, the crew member's recap carries neither the pick nor its canonical location; the owner's own recap still does", async () => {
    app = await start(store(true));
    const r = await recap(VIEWER);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(!r.text.includes(PICK) && !r.text.includes(CANON) && !r.text.includes(P), r.text.slice(0, 400));
    assert.ok((await recap(OWNER)).text.includes(PICK), "the owner's own recap is the stored row");
  });
});
