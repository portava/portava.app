/**
 * §11 per-Memory controls (migration 3671, `memory_resurfacing_preferences`).
 * Census H36 / H87 / H88 / H187 and KEEP_PRIVATE_FOREVER on a Memory.
 *
 * Over the real routers: the owner sets and clears a control; a
 * KEEP_PRIVATE_FOREVER Memory cannot be widened past `only_me` by PATCH and
 * cannot be a Highlight source. Reads fail CLOSED: unreadable controls refuse
 * the widening and admit no source. An absent table (3671 not applied) is "no
 * control set", which is true.
 *
 * Every assertion is on the STORE (or on the refusal that left it unchanged).
 * Run: node --import tsx/esm --test src/test/memoryResurfacingControls.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import controlsRouter from "../routes/memoryResurfacingControls.js";
import { verifyMemorySources } from "../services/highlights/highlightSources.js";
import { deriveProjection, projectionStaleness, rebuildProjection } from "../services/memoryProjections/derivativeRegistry.js";
import { sourceVersionOf } from "../services/memoryProjections/projectionRegistry.js";
import { buildOnThisDay, generateRecap } from "../compass/MemoryRecapsService.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRIV = "11111111-1111-4111-8111-111111111111";
const PUB = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";
const TABLE = "memory_resurfacing_preferences";

function memory(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, title: "t", caption: null, visibility: "only_me", state: "published",
    trip_id: null, event_id: null, place_id: null, starts_at: null, ends_at: null,
    created_at: "2026-03-02T22:00:00.000Z", updated_at: "2026-03-02T22:00:00.000Z",
    location_city: null, location_country: null, location_lat: null, location_lng: null,
    canonical_location_id: null, allowed_user_ids: [], hidden_user_ids: [], ...over,
  };
}
function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    memories: [memory(PRIV), memory(PUB, { visibility: "public" }), memory(GONE, { state: "deleted" })],
    memory_items: [], memory_tags: [], [TABLE]: [],
  };
}

interface FakeOpts { absent?: Set<string>; failReads?: Set<string>; failWrites?: Set<string> }
function makeClient(store: Record<string, any[]>, opts: FakeOpts = {}) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let mode: "select" | "upsert" | "update" | "insert" | "delete" = "select";
    let payload: any = null; let upsertOpts: any = {}; let wantRows = false; let single = false;
    const f = (p: (r: any) => boolean) => { filters.push(p); return obj; };
    const obj: any = {
      select() { if (mode !== "select") wantRows = true; return obj; },
      upsert(d: any, o?: any) { mode = "upsert"; payload = d; upsertOpts = o ?? {}; return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      delete() { mode = "delete"; return obj; },
      eq: (c: string, v: any) => f((r) => r[c] === v),
      neq: (c: string, v: any) => f((r) => r[c] !== v),
      in: (c: string, vs: any[]) => f((r) => vs.includes(r[c])),
      is: (c: string, v: any) => f((r) => (v === null ? r[c] == null : r[c] === v)),
      contains: (c: string, vs: any[]) => f((r) => Array.isArray(r[c]) && vs.every((v) => r[c].includes(v))),
      gte() { return obj; }, lte() { return obj; }, gt() { return obj; }, lt() { return obj; },
      not() { return obj; }, or() { return obj; }, order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(ok: any, bad: any) { return run().then(ok, bad); },
    };
    async function run(): Promise<any> {
      if (opts.absent?.has(table)) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
      if (mode === "select" && opts.failReads?.has(table)) return { data: null, error: { code: "57014", message: `${table} read failed` } };
      if (mode !== "select" && opts.failWrites?.has(`${table}:${mode}`)) return { data: null, error: { code: "57014", message: `${table} ${mode} failed` } };
      const all = (store[table] ??= []);
      if (mode === "upsert" || mode === "insert") {
        const written: any[] = [];
        for (const r of (Array.isArray(payload) ? payload : [payload])) {
          const keys = String(upsertOpts.onConflict ?? "").split(",").filter(Boolean);
          const had = keys.length ? all.find((x) => keys.every((k) => x[k] === r[k])) : null;
          if (had) { if (!upsertOpts.ignoreDuplicates) { Object.assign(had, r); written.push(had); } continue; }
          const row = { ...r }; all.push(row); written.push(row);
        }
        return { data: wantRows ? written : null, error: null };
      }
      const matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode === "update") { for (const r of matched) Object.assign(r, payload); return { data: wantRows ? matched.map((x) => ({ ...x })) : null, error: null }; }
      if (mode === "delete") { store[table] = all.filter((r) => !matched.includes(r)); return { data: wantRows ? matched : null, error: null }; }
      if (single) return { data: matched[0] ? { ...matched[0] } : null, error: null };
      return { data: matched.map((x) => ({ ...x })), error: null };
    }
    return obj;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: { message: "rpc not modelled", code: "PGRST202" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App { base: string; store: Record<string, any[]>; close: () => Promise<void> }
async function start(opts: FakeOpts = {}): Promise<App> {
  const store = seed();
  _setTestClient(makeClient(store, opts) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", controlsRouter);
  app.use("/api", memoriesRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
let keyN = 0;
async function call(a: App, method: string, path: string, actor = OWNER, body?: unknown) {
  const res = await fetch(`${a.base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", "Idempotency-Key": `rc-${++keyN}`, connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const rows = (a: App) => a.store[TABLE] ?? [];
const vis = (a: App, id: string) => a.store.memories.find((m) => m.id === id).visibility;

let app: App | null = null;
afterEach(async () => { if (app) { await app.close(); app = null; } });

describe("the owner's controls on their Memory", () => {
  it("KEEP_PRIVATE_FOREVER on a Memory that is not private is refused (409) — the owner narrows first", async () => {
    app = await start();
    const r = await call(app, "PUT", `/memories/${PUB}/resurfacing-controls/KEEP_PRIVATE_FOREVER`);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(rows(app), []);
  });

  it("set, read, set again (one row), clear", async () => {
    app = await start();
    assert.equal((await call(app, "PUT", `/memories/${PRIV}/resurfacing-controls/KEEP_PRIVATE_FOREVER`)).status, 204);
    assert.equal((await call(app, "PUT", `/memories/${PRIV}/resurfacing-controls/KEEP_PRIVATE_FOREVER`)).status, 204);
    assert.deepEqual(rows(app).map((r) => [r.memory_id, r.owner_id, r.control]), [[PRIV, OWNER, "KEEP_PRIVATE_FOREVER"]]);
    const got = await call(app, "GET", `/memories/${PRIV}/resurfacing-controls`);
    assert.equal(got.status, 200);
    assert.equal(got.body.controls.find((c: any) => c.control === "KEEP_PRIVATE_FOREVER").on, true);
    assert.equal(got.body.controls.find((c: any) => c.control === "DO_NOT_RESURFACE").on, false);
    assert.equal((await call(app, "DELETE", `/memories/${PRIV}/resurfacing-controls/KEEP_PRIVATE_FOREVER`)).status, 204);
    assert.deepEqual(rows(app), []);
  });

  it("someone else's Memory, a deleted Memory and an unknown control are refused, and nothing is stored", async () => {
    app = await start();
    assert.equal((await call(app, "PUT", `/memories/${PRIV}/resurfacing-controls/DO_NOT_RESURFACE`, OTHER)).status, 404);
    assert.equal((await call(app, "GET", `/memories/${PRIV}/resurfacing-controls`, OTHER)).status, 404);
    assert.equal((await call(app, "PUT", `/memories/${GONE}/resurfacing-controls/DO_NOT_RESURFACE`)).status, 404);
    assert.equal((await call(app, "PUT", `/memories/${PRIV}/resurfacing-controls/HIDE_TRIP`)).status, 400, "a trip-scoped control is not a Memory control");
    assert.deepEqual(rows(app), []);
  });

  it("3671 not applied: the routes say feature_disabled (404); an unreadable table is 503, never 'no controls'", async () => {
    app = await start({ absent: new Set([TABLE]) });
    assert.equal((await call(app, "GET", `/memories/${PRIV}/resurfacing-controls`)).status, 404);
    assert.equal((await call(app, "PUT", `/memories/${PRIV}/resurfacing-controls/DO_NOT_RESURFACE`)).status, 404);
    await app.close();
    app = await start({ failReads: new Set([TABLE]) });
    assert.equal((await call(app, "GET", `/memories/${PRIV}/resurfacing-controls`)).status, 503);
  });
});

describe("KEEP_PRIVATE_FOREVER is enforced where a Memory would be published", () => {
  it("PATCH cannot widen a kept-private Memory past only_me (409), and the Memory stays private", async () => {
    app = await start();
    app.store[TABLE].push({ memory_id: PRIV, owner_id: OWNER, control: "KEEP_PRIVATE_FOREVER" });
    const r = await call(app, "PATCH", `/memories/${PRIV}`, OWNER, { visibility: "public" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(vis(app, PRIV), "only_me");
  });

  it("FAIL CLOSED: when the controls cannot be read, the widening is refused (503) and nothing changes", async () => {
    app = await start({ failReads: new Set([TABLE]) });
    const r = await call(app, "PATCH", `/memories/${PRIV}`, OWNER, { visibility: "public" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(vis(app, PRIV), "only_me");
  });

  it("not refused: a Memory with no control, a caption edit on a kept-private one, and any widening while 3671 is not applied", async () => {
    app = await start();
    app.store[TABLE].push({ memory_id: PRIV, owner_id: OWNER, control: "KEEP_PRIVATE_FOREVER" });
    assert.equal((await call(app, "PATCH", `/memories/${PRIV}`, OWNER, { caption: "words" })).status, 200);
    assert.equal((await call(app, "PATCH", `/memories/${PUB}`, OWNER, { visibility: "friends_only" })).status, 200);
    await app.close();
    app = await start({ absent: new Set([TABLE]) });
    assert.equal((await call(app, "PATCH", `/memories/${PRIV}`, OWNER, { visibility: "public" })).status, 200);
    assert.equal(vis(app, PRIV), "public");
  });

  it("a kept-private Memory is never a Highlight source; unreadable controls admit no source; an absent table admits it", async () => {
    const store = seed();
    store[TABLE].push({ memory_id: PRIV, owner_id: OWNER, control: "KEEP_PRIVATE_FOREVER" });
    const kept = await verifyMemorySources(makeClient(store), OWNER, [PRIV, PUB]);
    assert.deepEqual([kept.ok, (kept as any).reason], [false, "kept_private"]);
    const ok = await verifyMemorySources(makeClient(store), OWNER, [PUB]);
    assert.equal(ok.ok, true);
    const unreadable = await verifyMemorySources(makeClient(store, { failReads: new Set([TABLE]) }), OWNER, [PUB]);
    assert.deepEqual([unreadable.ok, (unreadable as any).reason], [false, "unavailable"]);
    const absent = await verifyMemorySources(makeClient(store, { absent: new Set([TABLE]) }), OWNER, [PRIV]);
    assert.equal(absent.ok, true, "3671 not applied: no control can exist");
  });
});

// ── §AK: the recaps honour the per-Memory controls ──────────────────────────
const TRIP = "44444444-4444-4444-8444-444444444444";
const T1 = "55555555-5555-4555-8555-555555555551";
const T2 = "55555555-5555-4555-8555-555555555552";
const T3 = "55555555-5555-4555-8555-555555555553";
function tripStore(): Record<string, any[]> {
  const st = seed();
  st.memories.push(
    memory(T1, { trip_id: TRIP, visibility: "only_me", starts_at: "2026-03-01T10:00:00.000Z", title: "one" }),
    memory(T2, { trip_id: TRIP, visibility: "only_me", starts_at: "2026-03-02T10:00:00.000Z", title: "two" }),
    memory(T3, { trip_id: TRIP, visibility: "only_me", starts_at: "2026-03-03T10:00:00.000Z", title: "three" }),
  );
  st.trips = [{ id: TRIP, owner_id: OWNER, start_date: "2026-03-01", end_date: "2026-03-05" }];
  st.trip_members = [{ trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" }];
  return st;
}
async function startWith(store: Record<string, any[]>, opts: FakeOpts = {}): Promise<App> {
  _setTestClient(makeClient(store, opts) as any, true);
  const ex = express();
  ex.use(express.json());
  ex.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  ex.use("/api", controlsRouter);
  ex.use("/api", memoriesRouter);
  const srv = http.createServer(ex);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
const recapIds = (body: any) => (body?.recap?.rows ?? []).map((r: any) => r.memory_id);
const TRIP_SCOPE = { owner_id: OWNER, viewer_id: OWNER, trip_id: TRIP, place_id: null, person_id: null };

describe("§AK — the trip recap honours DO_NOT_INCLUDE_IN_RECAPS and KEEP_PRIVATE_FOREVER", () => {
  it("GET /trips/:tripId/memories/recap leaves out a Memory kept out of recaps or kept private forever; DO_NOT_RESURFACE alone does not", async () => {
    const store = tripStore();
    store[TABLE].push(
      { memory_id: T1, owner_id: OWNER, control: "DO_NOT_INCLUDE_IN_RECAPS" },
      { memory_id: T2, owner_id: OWNER, control: "KEEP_PRIVATE_FOREVER" },
      { memory_id: T3, owner_id: OWNER, control: "DO_NOT_RESURFACE" },
    );
    app = await startWith(store);
    const r = await call(app, "GET", `/trips/${TRIP}/memories/recap`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(recapIds(r.body), [T3]);
  });

  it("unreadable controls: the recap is REFUSED (503) — never served with a Memory its owner may have kept out", async () => {
    app = await startWith(tripStore(), { failReads: new Set([TABLE]) });
    const r = await call(app, "GET", `/trips/${TRIP}/memories/recap`);
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });

  it("3671 not applied: no control can exist, and the recap carries every Memory", async () => {
    app = await startWith(tripStore(), { absent: new Set([TABLE]) });
    const r = await call(app, "GET", `/trips/${TRIP}/memories/recap`);
    assert.equal(r.status, 200);
    assert.deepEqual(recapIds(r.body), [T1, T2, T3]);
  });

  it("the registered TripMemoryProjection: excluded too, a control change makes it STALE, and unreadable controls refuse the derivation", async () => {
    const store = tripStore();
    const client = makeClient(store) as any;
    const first = await rebuildProjection(client, "TripMemoryProjection", TRIP_SCOPE, new Date("2026-10-07T12:00:00.000Z"));
    assert.ok(first.ok && first.value.registration.source_memory_ids.includes(T1));
    store[TABLE].push({ memory_id: T1, owner_id: OWNER, control: "DO_NOT_INCLUDE_IN_RECAPS" });
    const stale = await projectionStaleness(client, "TripMemoryProjection", TRIP_SCOPE);
    assert.ok(stale.ok && stale.value.state === "STALE", "turning a control on changes the source version");
    const again = await rebuildProjection(client, "TripMemoryProjection", TRIP_SCOPE, new Date("2026-10-07T12:01:00.000Z"));
    assert.ok(again.ok && !again.value.registration.source_memory_ids.includes(T1) && again.value.registration.source_memory_ids.includes(T2));
    const refused = await deriveProjection(makeClient(store, { failReads: new Set([TABLE]) }) as any, "TripMemoryProjection", TRIP_SCOPE);
    assert.deepEqual([refused.ok, (refused as any).reason, (refused as any).table], [false, "source_unavailable", TABLE]);
  });

  it("the source version is byte-identical when no control is set (no stampede of STALE registrations on deploy)", () => {
    const mems = tripStore().memories as any[];
    assert.equal(sourceVersionOf(mems).digest, sourceVersionOf(mems, [], [], { state: "ok", byMemory: {} }).digest);
    assert.equal(sourceVersionOf(mems).digest, sourceVersionOf(mems, [], [], { state: "absent" }).digest);
    assert.notEqual(sourceVersionOf(mems).digest, sourceVersionOf(mems, [], [], { state: "unreadable" }).digest);
  });
});

describe("§AK — the §5 recaps and On This Day never resurface a Memory (pinned)", () => {
  it("a Memory carrying DO_NOT_RESURFACE / DO_NOT_INCLUDE_IN_RECAPS is in neither — §5 resurfaces no scrapbook Memory at all (fail-closed valence gate)", async () => {
    const store = seed();
    store.feature_flags.push({ flag: "memory_recaps", enabled: true });
    store.memories = [memory(PRIV, { created_at: "2025-10-07T09:00:00.000Z", title: "anniversary" })];
    store[TABLE].push({ memory_id: PRIV, owner_id: OWNER, control: "DO_NOT_RESURFACE" }, { memory_id: PRIV, owner_id: OWNER, control: "DO_NOT_INCLUDE_IN_RECAPS" });
    const client = makeClient(store) as any;
    const day = await buildOnThisDay(client, OWNER, { now: new Date("2026-10-07T12:00:00.000Z") });
    assert.equal(day.enabled, true);
    assert.ok(!day.items.some((i: any) => i.subjectType === "passport:memory"), "On This Day carries no Memory");
    const recap = await generateRecap(client, OWNER, { kind: "year", year: 2025, now: new Date("2026-10-07T12:00:00.000Z") } as any);
    assert.ok(!recap.sections.some((s: any) => s.items.some((i: any) => i.subjectType === "passport:memory")), "a recap carries no Memory");
  });
});

// ── VERIFY-H3 H3-6: KEEP_PRIVATE_FOREVER against every wider audience ───────
describe("H3-6 — KEEP_PRIVATE_FOREVER holds against every audience wider than only_me", () => {
  for (const visibility of ["custom", "friends_only", "trip_crew", "circle_only"]) {
    it(`PATCH to '${visibility}' on a kept-private Memory is refused (409) and the Memory stays only_me`, async () => {
      app = await start();
      app.store[TABLE].push({ memory_id: PRIV, owner_id: OWNER, control: "KEEP_PRIVATE_FOREVER" });
      const r = await call(app, "PATCH", `/memories/${PRIV}`, OWNER, { visibility, ...(visibility === "custom" ? { allowedUserIds: [OTHER] } : {}) });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(vis(app, PRIV), "only_me");
    });
  }

  it("KEEP_PRIVATE_FOREVER cannot be set on a friends_only Memory (409) — the owner narrows first", async () => {
    app = await start();
    app.store.memories.find((m) => m.id === PRIV).visibility = "friends_only";
    const r = await call(app, "PUT", `/memories/${PRIV}/resurfacing-controls/KEEP_PRIVATE_FOREVER`);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(rows(app), []);
  });
});
