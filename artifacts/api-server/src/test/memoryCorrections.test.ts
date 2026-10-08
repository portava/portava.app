/**
 * §3 `memory_corrections` (migration 3673) and §4's precedence on a Memory's
 * place. Census H28, H48, H49, H73, H242.
 *
 * Over the real routers (PATCH /memories/:id, POST|GET /memories/:id/corrections,
 * GET /memories/:id/actions) and a table-backed fake:
 *   - H73: an asserted place beats the automatic canonical-location match, and
 *     beats an ambiguous one.
 *   - H49: a rejected place is never resolved to: not directly, not through the
 *     canonical match, not through a catalog merge. A change of place does not
 *     fall back to the old place's canonical location.
 *   - A failed corrections read makes the place UNREADABLE, never uncorrected.
 *     A full page is a failed read. An absent table (3673 not applied) is "no
 *     correction", which is true.
 *   - PATCH records the correction BEFORE it writes the Memory, and an
 *     unrecordable correction refuses the edit.
 *   - Owner only; the table is append-only.
 *
 * Run: node --import tsx/esm --test src/test/memoryCorrections.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import correctionsRouter from "../routes/memoryCorrections.js"; import { deriveProjection, projectionStaleness, rebuildProjection } from "../services/memoryProjections/derivativeRegistry.js"; // one line: the census cites this file by line
import memoryActionsRouter from "../routes/memoryActions.js";
import { _setMemoryActionDeps } from "../services/memory/memoryActionService.js";
import {
  CORRECTIONS_PAGE,
  correctedPlaceRef,
  foldPlaceCorrections,
  placeCorrectionsForPatch,
  type CorrectionRow,
} from "../services/memory/memoryCorrections.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRIEND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const MEM = "10000000-0000-4000-8000-000000000001";        // provider id + canonical location → auto-matches PLACE_CANON
const MEM_MERGED = "10000000-0000-4000-8000-000000000002"; // a catalog place merged into a successor
const MEM_GONE = "10000000-0000-4000-8000-000000000003";   // deleted

const PLACE_OPEN = "20000000-0000-4000-8000-000000000001";
const PLACE_CANON = "20000000-0000-4000-8000-000000000002";
const PLACE_CANON_TWIN = "20000000-0000-4000-8000-000000000003";
const PLACE_OLD = "20000000-0000-4000-8000-000000000004";
const PLACE_SUCCESSOR = "20000000-0000-4000-8000-000000000005";
const CANON_LOC = "30000000-0000-4000-8000-000000000001";
const TABLE = "memory_corrections";

function memory(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, title: "Ramen night", caption: null, visibility: "public", state: "published",
    allowed_user_ids: [], hidden_user_ids: [], trip_id: null, event_id: null,
    place_id: "osm:node/123", canonical_location_id: CANON_LOC,
    location_city: "Tokyo", location_country: "Japan", location_lat: 35.6595, location_lng: 139.7005,
    starts_at: "2026-03-03T11:00:00.000Z", ends_at: null,
    created_at: "2026-03-03T12:00:00.000Z", updated_at: "2026-03-03T12:00:00.000Z", ...over,
  };
}
function place(id: string, over: Record<string, unknown> = {}) {
  return {
    id, name: "Ichiran Shibuya", primary_category: "food", latitude: 35.661, longitude: 139.701,
    address: "1-22-7 Jinnan", city: "Tokyo", country_code: "JP", status: "active", merged_into_place_id: null,
    canonical_location_id: null, ...over,
  };
}
function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    memories: [
      memory(MEM),
      memory(MEM_MERGED, { place_id: PLACE_OLD, canonical_location_id: null }),
      memory(MEM_GONE, { state: "deleted" }),
    ],
    places: [
      place(PLACE_OPEN, { name: "The Right Place" }),
      place(PLACE_CANON, { name: "Auto-Matched Sushi", canonical_location_id: CANON_LOC }),
      place(PLACE_OLD, { name: "Old Name Cafe", status: "duplicate", merged_into_place_id: PLACE_SUCCESSOR }),
      place(PLACE_SUCCESSOR, { name: "New Name Cafe" }),
    ],
    hidden_gems: [], trips: [], trip_members: [], trip_saved_places: [], memory_saves: [],
    blocks: [], user_follows: [], circle_memberships: [], memory_items: [], memory_tags: [],
    [TABLE]: [],
  };
}

let tick = 0;
function correction(kind: "assert" | "reject", ref: { place_id?: string | null; canonical_location_id?: string | null }, memoryId = MEM) {
  tick += 1;
  return {
    id: `c-${String(tick).padStart(4, "0")}`, memory_id: memoryId, owner_id: OWNER, field: "place", kind,
    place_id: ref.place_id ?? null, canonical_location_id: ref.canonical_location_id ?? null, source: "correction_route",
    created_at: new Date(Date.UTC(2026, 3, 1, 0, 0, tick)).toISOString(),
  };
}

interface FakeOpts { absent?: Set<string>; failReads?: Set<string>; failWrites?: Set<string>; silentWrites?: Set<string> }
interface Op { table: string; mode: string }
function makeClient(store: Record<string, any[]>, ops: Op[], opts: FakeOpts = {}) {
  let idN = 0;
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let mode: "select" | "upsert" | "update" | "insert" | "delete" = "select";
    let payload: any = null; let wantRows = false; let single = false; let limitN: number | null = null; let selected: string[] | null = null; let conflict: string[] = []; const orders: Array<[string, boolean]> = []; let rangeFrom: number | null = null; let rangeTo = 0;
    const f = (p: (r: any) => boolean) => { filters.push(p); return obj; };
    const obj: any = {
      select(c?: string) { if (mode !== "select") wantRows = true; else if (table === TABLE && typeof c === "string") selected = c.split(",").map((k) => k.trim()); return obj; }, // VERIFY-H6: a corrections read gets only the columns it selected, as from PostgREST
      upsert(d: any, o?: any) { mode = "upsert"; payload = d; conflict = String(o?.onConflict ?? "").split(",").map((k) => k.trim()).filter(Boolean); return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      delete() { mode = "delete"; return obj; },
      eq: (c: string, v: any) => f((r) => r[c] === v),
      neq: (c: string, v: any) => f((r) => r[c] !== v),
      in: (c: string, vs: any[]) => f((r) => vs.includes(r[c])),
      is: (c: string, v: any) => f((r) => (v === null ? r[c] == null : r[c] === v)),
      contains: (c: string, vs: any[]) => f((r) => Array.isArray(r[c]) && vs.every((v) => r[c].includes(v))),
      gte() { return obj; }, lte() { return obj; }, gt() { return obj; }, lt() { return obj; },
      not() { return obj; }, or(expr: string) { const terms = String(expr).split(",").map((t) => /^([a-z_]+)\.eq\.(.+)$/.exec(t)); return terms.every(Boolean) ? f((r) => terms.some((m) => String(r[m![1]!]) === m![2])) : obj; }, order(c: string, o?: any) { orders.push([c, o?.ascending !== false]); return obj; }, range(a: number, b: number) { rangeFrom = a; rangeTo = b; return obj; }, // §AP: `col.eq.v,…` is applied (the place history read); anything else is ignored as before
      limit(n: number) { limitN = n; return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(ok: any, bad: any) { return run().then(ok, bad); },
    };
    async function run(): Promise<any> {
      ops.push({ table, mode });
      if (opts.absent?.has(table)) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
      if (mode === "select" && opts.failReads?.has(table)) return { data: null, error: { code: "57014", message: `${table} read failed` } };
      if (mode !== "select" && opts.failWrites?.has(`${table}:${mode}`)) return { data: null, error: { code: "57014", message: `${table} ${mode} failed` } };
      const all = (store[table] ??= []);
      if (mode !== "select" && opts.silentWrites?.has(`${table}:${mode}`)) return { data: [], error: null };
      if (mode === "upsert" || mode === "insert") {
        const written: any[] = []; const stamp = new Date().toISOString(); // one INSERT, one created_at (now() is the transaction's)
        for (const r of (Array.isArray(payload) ? payload : [payload])) {
          const row = { id: `ins-${++idN}`, created_at: stamp, ...r }; const had = conflict.length > 0 ? all.find((x) => conflict.every((k) => x[k] === row[k])) : undefined; if (had) { Object.assign(had, r); written.push(had); continue; } all.push(row); written.push(row);
        }
        return { data: wantRows ? written : null, error: null };
      }
      let matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode === "update") { for (const r of matched) Object.assign(r, payload); return { data: wantRows ? matched.map((x) => ({ ...x })) : null, error: null }; }
      if (mode === "delete") { store[table] = all.filter((r) => !matched.includes(r)); return { data: wantRows ? matched : null, error: null }; }
      if (orders.length > 0) matched = [...matched].sort((x, y) => { for (const [c, asc] of orders) { const d = String(x[c] ?? "").localeCompare(String(y[c] ?? "")); if (d !== 0) return asc ? d : -d; } return 0; }); if (rangeFrom != null) matched = matched.slice(rangeFrom, rangeTo + 1); if (limitN != null) matched = matched.slice(0, limitN); matched = matched.slice(0, 1000); // H-15: order, range and PostgREST's max-rows cap, as the database answers
      const project = (x: any) => (selected ? Object.fromEntries(selected.filter((k) => k in x).map((k) => [k, x[k]])) : { ...x }); if (single) return { data: matched[0] ? project(matched[0]) : null, error: null };
      return { data: matched.map(project), error: null };
    }
    return obj;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: { message: "rpc not modelled", code: "PGRST202" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App { base: string; store: Record<string, any[]>; ops: Op[]; close: () => Promise<void> }
async function start(opts: FakeOpts & { mutate?: (s: Record<string, any[]>) => void } = {}): Promise<App> {
  const store = seed();
  opts.mutate?.(store);
  const ops: Op[] = [];
  _setTestClient(makeClient(store, ops, opts) as any, true);
  _setMemoryActionDeps({
    liveStatus: async () => null,
    tripWindows: async () => ({ ok: false } as any),
    restrictiveGemCeiling: async () => ({ determined: true, ceiling: null }),
  });
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", correctionsRouter);
  app.use("/api", memoryActionsRouter);
  app.use("/api", memoriesRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, ops, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
let keyN = 0;
async function call(a: App, method: string, p: string, actor = OWNER, body?: unknown) {
  const res = await fetch(`${a.base}/api${p}`, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", "Idempotency-Key": `mc-${++keyN}`, connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const byAction = (menu: any) => Object.fromEntries((menu.actions as any[]).map((x) => [x.action, x]));
async function menuOf(a: App, memoryId = MEM, actor = OWNER) {
  const r = await call(a, "GET", `/memories/${memoryId}/actions`, actor);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { place: r.body.menu.place as { id: string } | null, add: byAction(r.body.menu).ADD_TO_TRIP };
}
const rows = (a: App) => a.store[TABLE] ?? [];
const mem = (a: App, id = MEM) => a.store.memories.find((m) => m.id === id);

let app: App | null = null;
afterEach(async () => { _setMemoryActionDeps(null); if (app) { await app.close(); app = null; } });

describe("H73: the owner's correction beats automatic entity resolution", () => {
  it("control: with no correction, the canonical location auto-matches its one catalog row", async () => {
    app = await start();
    const m = await menuOf(app);
    assert.equal(m.place?.id, PLACE_CANON);
  });

  it("an asserted place wins over the canonical-location match", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push(correction("assert", { place_id: PLACE_OPEN })); } });
    const m = await menuOf(app);
    assert.equal(m.place?.id, PLACE_OPEN, JSON.stringify(m));
    assert.equal(m.add.available, true);
  });

  it("an asserted place wins where the automatic match is AMBIGUOUS (and the ambiguity is the control)", async () => {
    const twin = (s: Record<string, any[]>) => { s.places.push(place(PLACE_CANON_TWIN, { name: "Twin Sushi", canonical_location_id: CANON_LOC })); };
    app = await start({ mutate: twin });
    assert.equal((await menuOf(app)).add.reason, "PLACE_AMBIGUOUS");
    await app.close(); app = null;
    app = await start({ mutate: (s) => { twin(s); s[TABLE].push(correction("assert", { place_id: PLACE_OPEN })); } });
    assert.equal((await menuOf(app)).place?.id, PLACE_OPEN);
  });

  it("H242 in production: correctedPlaceRef applies the correction through §4 precedence, over a stored reference", () => {
    const c = foldPlaceCorrections([correction("assert", { place_id: PLACE_OPEN }) as CorrectionRow]);
    const out = correctedPlaceRef({ place_id: "osm:node/123", canonical_location_id: CANON_LOC }, c, OWNER, new Date());
    assert.ok(out.ok);
    assert.deepEqual(out.ref, { place_id: PLACE_OPEN, canonical_location_id: null });
    assert.deepEqual(out.refused, []);
  });
});

describe("H49: a rejected place is never used", () => {
  it("a rejection of the auto-matched row refuses the place for the owner, and tells a non-owner only that no place is named", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push(correction("reject", { place_id: PLACE_CANON })); } });
    const own = await menuOf(app);
    assert.equal(own.place, null);
    assert.equal(own.add.reason, "PLACE_REJECTED_BY_OWNER");
    const friend = await menuOf(app, MEM, FRIEND);
    assert.equal(friend.place, null);
    assert.equal(friend.add.reason, "NO_PLACE_REFERENCE");
    const compiled = await call(app, "GET", `/memories/${MEM}/actions/ADD_TO_TRIP`);
    assert.equal(compiled.status, 409);
    assert.equal(compiled.body.reason, "PLACE_REJECTED_BY_OWNER");
  });

  it("a rejected SUCCESSOR is not reached through a catalog merge (control: unrejected, the merge is followed)", async () => {
    app = await start();
    assert.equal((await menuOf(app, MEM_MERGED)).place?.id, PLACE_SUCCESSOR);
    await app.close(); app = null;
    app = await start({ mutate: (s) => { s[TABLE].push(correction("reject", { place_id: PLACE_SUCCESSOR }, MEM_MERGED)); } });
    const m = await menuOf(app, MEM_MERGED);
    assert.equal(m.place, null);
    assert.equal(m.add.reason, "PLACE_REJECTED_BY_OWNER");
  });

  it("a rejected place the merge chain only passed THROUGH is refused too (old → rejected middle → current)", async () => {
    const chain = (s: Record<string, any[]>) => {
      s.places.find((p) => p.id === PLACE_SUCCESSOR).merged_into_place_id = PLACE_OPEN;
      s.places.find((p) => p.id === PLACE_SUCCESSOR).status = "duplicate";
    };
    app = await start({ mutate: chain });
    assert.equal((await menuOf(app, MEM_MERGED)).place?.id, PLACE_OPEN, "control: two hops are followed");
    await app.close(); app = null;
    app = await start({ mutate: (s) => { chain(s); s[TABLE].push(correction("reject", { place_id: PLACE_SUCCESSOR }, MEM_MERGED)); } });
    const m = await menuOf(app, MEM_MERGED);
    assert.equal(m.place, null);
    assert.equal(m.add.reason, "PLACE_REJECTED_BY_OWNER");
  });

  it("a rejected PROVIDER pick takes the canonical location resolved from it along: its catalog twin is not used", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push(correction("reject", { place_id: "osm:node/123" })); } });
    const m = await menuOf(app);
    assert.equal(m.place, null);
    assert.equal(m.add.reason, "PLACE_REJECTED_BY_OWNER"); assert.equal((await menuOf(app, MEM, FRIEND)).add.reason, "NO_PLACE_REFERENCE", "VERIFY-H6 H6-2: a viewer is told what the corrected (now empty) reference says");
  });

  it("a rejected pick keeps a canonical location the OWNER asserted", async () => {
    app = await start({
      mutate: (s) => { s[TABLE].push(correction("assert", { place_id: "osm:node/123", canonical_location_id: CANON_LOC }), correction("reject", { place_id: "osm:node/123" })); },
    });
    assert.equal((await menuOf(app)).place?.id, PLACE_CANON);
  });

  it("a row on this Memory by anyone but its owner is not the owner's word", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push({ ...correction("reject", { place_id: PLACE_CANON }), owner_id: FRIEND }); } });
    assert.equal((await menuOf(app)).place?.id, PLACE_CANON);
  });

  it("a rejected canonical location is not matched at all", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push(correction("reject", { canonical_location_id: CANON_LOC })); } });
    const m = await menuOf(app);
    assert.notEqual(m.place?.id, PLACE_CANON);
    assert.equal(m.add.reason, "PLACE_REJECTED_BY_OWNER", "VERIFY-H6 H6-2: this expected PLACE_NOT_IN_CATALOG, which told the owner of their own rejection that the place is uncatalogued"); assert.equal((await menuOf(app, MEM, FRIEND)).add.reason, "PLACE_NOT_IN_CATALOG", "a viewer: what the corrected provider pick alone says");
  });

  it("a later assertion of the same place lifts the rejection; a later rejection clears the assertion", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push(correction("reject", { place_id: PLACE_CANON }), correction("assert", { place_id: PLACE_CANON })); } });
    assert.equal((await menuOf(app)).place?.id, PLACE_CANON);
    await app.close(); app = null;
    app = await start({ mutate: (s) => { s[TABLE].push(correction("assert", { place_id: PLACE_OPEN }), correction("reject", { place_id: PLACE_OPEN })); } });
    const m = await menuOf(app);
    assert.notEqual(m.place?.id, PLACE_OPEN);
    const g = await call(app, "GET", `/memories/${MEM}/corrections`);
    assert.deepEqual(g.body.place.asserted, { placeId: null, canonicalLocationId: null }, "the cleared assertion is not reported as the owner's word");
  });

  it("on a tie in time, the rejection wins (fail closed)", () => {
    const at = "2026-04-01T00:00:00.000Z";
    const c = foldPlaceCorrections([
      { id: "z", kind: "reject", place_id: PLACE_OPEN, canonical_location_id: null, created_at: at },
      { id: "a", kind: "assert", place_id: PLACE_OPEN, canonical_location_id: null, created_at: at },
    ]);
    assert.ok(c.rejectedPlaceIds.has(PLACE_OPEN));
    assert.equal(c.asserted?.place_id ?? null, null);
  });
});

describe("a failed corrections read is never 'uncorrected'", () => {
  it("unreadable ⇒ the place is unreadable (503 on a compile), not the auto-matched row", async () => {
    app = await start({ failReads: new Set([TABLE]) });
    const m = await menuOf(app);
    assert.equal(m.place, null);
    assert.equal(m.add.reason, "PLACE_UNREADABLE");
    const compiled = await call(app, "GET", `/memories/${MEM}/actions/ADD_TO_TRIP`);
    assert.equal(compiled.status, 503);
  });

  it("a full page with NO assert in it may be truncated ⇒ unreadable (H-15: only that page can hide a rejection)", async () => {
    app = await start({
      mutate: (s) => { for (let i = 0; i < CORRECTIONS_PAGE; i++) s[TABLE].push(correction("reject", { place_id: `elsewhere-${i}` })); },
    });
    assert.equal((await menuOf(app)).add.reason, "PLACE_UNREADABLE");
  });

  it("absent table (3673 not applied) ⇒ no correction can exist, and resolution is as before", async () => {
    app = await start({ absent: new Set([TABLE]) });
    assert.equal((await menuOf(app)).place?.id, PLACE_CANON);
  });
});

describe("PATCH /memories/:id records a change of place as the owner's correction", () => {
  it("a new place: rejects the old place and its canonical location, asserts the new one, and clears the old canonical on the row", async () => {
    app = await start();
    const r = await call(app, "PATCH", `/memories/${MEM}`, OWNER, { placeId: PLACE_OPEN });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const got = rows(app).map((x) => [x.kind, x.place_id, x.canonical_location_id, x.source, x.owner_id, x.field]);
    assert.deepEqual(got, [
      ["reject", "osm:node/123", null, "memory_edit", OWNER, "place"],
      ["reject", null, CANON_LOC, "memory_edit", OWNER, "place"],
      ["assert", PLACE_OPEN, null, "memory_edit", OWNER, "place"],
    ]);
    assert.equal(mem(app).place_id, PLACE_OPEN);
    assert.equal(mem(app).canonical_location_id, null);
    assert.equal((await menuOf(app)).place?.id, PLACE_OPEN);
  });

  it("H49: a new place outside the catalog does NOT resolve back to the old place's canonical match", async () => {
    app = await start();
    const r = await call(app, "PATCH", `/memories/${MEM}`, OWNER, { placeId: "fsq:new-venue" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = await menuOf(app);
    assert.notEqual(m.place?.id, PLACE_CANON);
    assert.equal(m.add.reason, "PLACE_NOT_IN_CATALOG");
  });

  it("the same place sent again records nothing and keeps the canonical location", async () => {
    app = await start();
    const r = await call(app, "PATCH", `/memories/${MEM}`, OWNER, { placeId: "osm:node/123", title: "renamed" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(rows(app), []);
    assert.equal(mem(app).canonical_location_id, CANON_LOC);
  });

  it("FAIL CLOSED: an unrecordable correction refuses the edit (503) and the Memory keeps its place", async () => {
    app = await start({ failWrites: new Set([`${TABLE}:insert`]) });
    const r = await call(app, "PATCH", `/memories/${MEM}`, OWNER, { placeId: PLACE_OPEN });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(mem(app).place_id, "osm:node/123");
    assert.equal(mem(app).canonical_location_id, CANON_LOC);
  });

  it("FAIL CLOSED: an insert that returns no row is not a recorded correction", async () => {
    app = await start({ silentWrites: new Set([`${TABLE}:insert`]) });
    const r = await call(app, "PATCH", `/memories/${MEM}`, OWNER, { placeId: PLACE_OPEN });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(mem(app).place_id, "osm:node/123");
  });

  it("3673 not applied: the edit goes ahead as before", async () => {
    app = await start({ absent: new Set([TABLE]) });
    const r = await call(app, "PATCH", `/memories/${MEM}`, OWNER, { placeId: PLACE_OPEN });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(mem(app).place_id, PLACE_OPEN);
  });

  it("placeCorrectionsForPatch: an explicit canonical location is asserted with the place", () => {
    const out = placeCorrectionsForPatch({ place_id: "osm:node/123", canonical_location_id: CANON_LOC }, { placeId: PLACE_OPEN, canonicalLocationId: CANON_LOC });
    assert.deepEqual(out, [
      { kind: "reject", place_id: "osm:node/123", canonical_location_id: null },
      { kind: "assert", place_id: PLACE_OPEN, canonical_location_id: CANON_LOC },
    ]);
  });
});

describe("POST|GET /memories/:id/corrections — owner only, append-only", () => {
  it("the owner rejects a place: one row, and the menu stops using it", async () => {
    app = await start();
    const r = await call(app, "POST", `/memories/${MEM}/corrections`, OWNER, { field: "place", kind: "reject", placeId: PLACE_CANON });
    assert.equal(r.status, 204, JSON.stringify(r.body));
    assert.deepEqual(rows(app).map((x) => [x.kind, x.place_id, x.canonical_location_id, x.source, x.owner_id, x.memory_id]),
      [["reject", PLACE_CANON, null, "correction_route", OWNER, MEM]]);
    assert.equal((await menuOf(app)).add.reason, "PLACE_REJECTED_BY_OWNER");
    const g = await call(app, "GET", `/memories/${MEM}/corrections`);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.place, { asserted: null, rejectedPlaceIds: [PLACE_CANON], rejectedCanonicalLocationIds: [] });
  });

  it("another person's Memory and a deleted Memory are both 404, and nothing is written", async () => {
    app = await start();
    const a = await call(app, "POST", `/memories/${MEM}/corrections`, FRIEND, { field: "place", kind: "reject", placeId: PLACE_CANON });
    const b = await call(app, "POST", `/memories/${MEM_GONE}/corrections`, OWNER, { field: "place", kind: "reject", placeId: PLACE_CANON });
    const c = await call(app, "GET", `/memories/${MEM}/corrections`, FRIEND);
    assert.deepEqual([a.status, b.status, c.status], [404, 404, 404]);
    assert.deepEqual(rows(app), []);
  });

  it("a malformed body is refused: both values, neither value, an assert, an unknown field", async () => {
    app = await start();
    for (const body of [
      { field: "place", kind: "reject", placeId: PLACE_CANON, canonicalLocationId: CANON_LOC },
      { field: "place", kind: "reject" },
      { field: "place", kind: "assert", placeId: PLACE_OPEN },
      { field: "time", kind: "reject", placeId: PLACE_CANON },
    ]) {
      const r = await call(app, "POST", `/memories/${MEM}/corrections`, OWNER, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(rows(app), []);
  });

  it("not applied ⇒ feature_disabled (404); a failed write ⇒ 503; a failed read ⇒ 503", async () => {
    app = await start({ absent: new Set([TABLE]) });
    assert.equal((await call(app, "POST", `/memories/${MEM}/corrections`, OWNER, { field: "place", kind: "reject", placeId: PLACE_CANON })).status, 404);
    assert.equal((await call(app, "GET", `/memories/${MEM}/corrections`)).status, 404);
    await app.close(); app = null;
    app = await start({ failWrites: new Set([`${TABLE}:insert`]), failReads: new Set([TABLE]) });
    assert.equal((await call(app, "POST", `/memories/${MEM}/corrections`, OWNER, { field: "place", kind: "reject", placeId: PLACE_CANON })).status, 503);
    assert.equal((await call(app, "GET", `/memories/${MEM}/corrections`)).status, 503);
  });

  it("no route updates or deletes a correction; the ONE delete in the codebase is the §21 erasure (lead ruling H-13)", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push(correction("reject", { place_id: PLACE_CANON })); } });
    await call(app, "PATCH", `/memories/${MEM}`, OWNER, { placeId: PLACE_OPEN });
    await call(app, "POST", `/memories/${MEM}/corrections`, OWNER, { field: "place", kind: "reject", placeId: PLACE_SUCCESSOR });
    await menuOf(app);
    await call(app, "GET", `/memories/places/${PLACE_OPEN}`);
    const touched = app.ops.filter((o) => o.table === TABLE).map((o) => o.mode);
    assert.ok(touched.includes("insert") && touched.includes("select"));
    assert.deepEqual(touched.filter((m) => m === "update" || m === "delete" || m === "upsert"), []);
    // Source scan: every `.from("memory_corrections")` chain that deletes, anywhere in src outside tests.
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const deleters: string[] = [];
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== "test") walk(p); } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) { const t = fs.readFileSync(p, "utf8"); if (/from\("memory_corrections"\)[\s\S]{0,40}?\.(delete|update|upsert)\(/.test(t)) deleters.push(path.relative(src, p)); } } };
    walk(src);
    assert.deepEqual(deleters, ["services/memory/memoryCorrections.ts"]);
    const own = fs.readFileSync(path.join(src, "services/memory/memoryCorrections.ts"), "utf8");
    assert.equal((own.match(/from\("memory_corrections"\)[\s\S]{0,40}?\.(delete|update|upsert)\(/g) ?? []).length, 1, "one delete, inside eraseCorrectionsForDeletedMemory");
  });
});

describe("3673 itself", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "../migrations/3673_memory_corrections.sql"), "utf8");
  it("revokes every client role in the same file, grants the server SELECT, INSERT and the erasure DELETE only, and refuses UPDATE by trigger", () => {
    assert.match(sql, /REVOKE ALL ON public\.memory_corrections FROM PUBLIC, anon, authenticated, service_role;/);
    assert.match(sql, /GRANT SELECT, INSERT ON public\.memory_corrections TO service_role;/);
    assert.match(sql, /GRANT DELETE ON public\.memory_corrections TO service_role;/);
    assert.doesNotMatch(sql, /GRANT[^;]*(UPDATE|TRUNCATE|ALL)[^;]*memory_corrections/);
    assert.doesNotMatch(sql, /GRANT[^;]*memory_corrections[^;]*TO (anon|authenticated|PUBLIC)/);
    assert.match(sql, /BEFORE UPDATE ON public\.memory_corrections\s+FOR EACH ROW EXECUTE FUNCTION public\.intel_append_only\(\);/);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  });
  it("H-13: DELETE is held to the erasure by a row-level guard — refused while the Memory is live and its owner exists; INSERT onto a deleted Memory refused", () => {
    assert.match(sql, /CREATE TRIGGER memory_corrections_erasure_only\s+BEFORE INSERT OR DELETE ON public\.memory_corrections\s+FOR EACH ROW EXECUTE FUNCTION public\.memory_corrections_guard\(\);/);
    assert.match(sql, /m\.id = OLD\.memory_id AND m\.state IS DISTINCT FROM 'deleted'\)\s+AND EXISTS \(SELECT 1 FROM auth\.users u WHERE u\.id = OLD\.owner_id\)/);
    assert.match(sql, /IF \(SELECT m\.state FROM public\.memories m WHERE m\.id = NEW\.memory_id FOR SHARE\) = 'deleted' THEN/, "VERIFY-H6 H6-5: the INSERT branch reads the Memory's state FOR SHARE, with no state filter in the locking read"); assert.doesNotMatch(sql, /m\.state = 'deleted'[^;]*FOR SHARE/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.memory_corrections_guard\(\) FROM PUBLIC, anon, authenticated;/);
    assert.doesNotMatch(sql, /FOR EACH STATEMENT[^;]*memory_corrections_guard/);
  });
  it("both erasure paths cascade", () => {
    assert.match(sql, /memory_id\s+uuid\s+NOT NULL REFERENCES public\.memories\(id\) ON DELETE CASCADE/);
    assert.match(sql, /owner_id\s+uuid\s+NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
  });
});

// ── §AP (lead ruling H-13 wave, 2026-10-07): the Memory-side place readers ────
// apply the owner's corrections. Appended: the census cites this file by line.
describe("§AP — place history, PlaceMemoryProjection and MapTrailDerivative read a Memory's place through its corrections", () => {
  const history = async (a: App, placeId: string) => {
    const r = await call(a, "GET", `/memories/places/${placeId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.history as { rows: Array<{ memory_id: string; place_id: string | null }>; sourceVersion: string };
  };
  const ids = (h: { rows: Array<{ memory_id: string }> }) => h.rows.map((r) => r.memory_id);
  const scopeAt = (placeId: string | null) => ({ owner_id: OWNER, viewer_id: OWNER, trip_id: null, place_id: placeId, person_id: null });
  const derived = async (store: Record<string, any[]>, id: "PlaceMemoryProjection" | "MapTrailDerivative", placeId: string | null, opts: FakeOpts = {}) =>
    deriveProjection(makeClient(store, [], opts) as any, id, scopeAt(placeId));

  it("place history: a Memory at the place leaves it once its owner rejects that place (control: listed before)", async () => {
    app = await start();
    assert.deepEqual(ids(await history(app, CANON_LOC)), [MEM]);
    assert.equal((await call(app, "POST", `/memories/${MEM}/corrections`, OWNER, { field: "place", kind: "reject", canonicalLocationId: CANON_LOC })).status, 204);
    assert.deepEqual(ids(await history(app, CANON_LOC)), []);
  });

  it("place history: rejecting the stored PICK takes the canonical location resolved from it along", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push(correction("reject", { place_id: "osm:node/123" })); } });
    assert.deepEqual(ids(await history(app, CANON_LOC)), []);
  });

  it("place history: an ASSERTION lists a Memory at the asserted place while its row has not caught up (H-12), and not at the stored one", async () => {
    app = await start();
    assert.deepEqual(ids(await history(app, PLACE_OLD)), [MEM_MERGED], "control: listed at its stored place");
    assert.deepEqual(ids(await history(app, PLACE_OPEN)), [], "control: not at the place it will be asserted at");
    app.store[TABLE].push(correction("assert", { place_id: PLACE_OPEN }, MEM_MERGED));
    const atOpen = await history(app, PLACE_OPEN);
    assert.deepEqual(atOpen.rows.map((r) => [r.memory_id, r.place_id]), [[MEM_MERGED, PLACE_OPEN]]);
    assert.deepEqual(ids(await history(app, PLACE_OLD)), []);
  });

  it("place history: unreadable corrections ⇒ 503 (never an uncorrected list); absent table (3673 unapplied) ⇒ as before", async () => {
    app = await start({ failReads: new Set([TABLE]) });
    assert.equal((await call(app, "GET", `/memories/places/${CANON_LOC}`)).status, 503);
    await app.close(); app = null;
    app = await start({ absent: new Set([TABLE]) });
    assert.deepEqual(ids(await history(app, CANON_LOC)), [MEM]);
  });

  it("place history: a correction that leaves the Memory where it is still changes the source version", async () => {
    app = await start();
    const before = await history(app, CANON_LOC);
    app.store[TABLE].push(correction("reject", { place_id: PLACE_SUCCESSOR }));
    const after = await history(app, CANON_LOC);
    assert.deepEqual(ids(after), [MEM]);
    assert.notEqual(after.sourceVersion, before.sourceVersion);
  });

  it("PlaceMemoryProjection (registry): a rejected place drops the Memory, an assertion lists it at the asserted place, and an unreadable read is source_unavailable", async () => {
    const plain = await derived(seed(), "PlaceMemoryProjection", CANON_LOC);
    assert.ok(plain.ok, JSON.stringify(plain));
    assert.deepEqual(plain.ok && plain.value.rows.map((r) => r.memory_id), [MEM]);
    const rejected = seed(); rejected[TABLE].push(correction("reject", { canonical_location_id: CANON_LOC }));
    const out = await derived(rejected, "PlaceMemoryProjection", CANON_LOC);
    assert.deepEqual(out.ok && out.value.rows.map((r) => r.memory_id), []);
    const asserted = seed(); asserted[TABLE].push(correction("assert", { place_id: PLACE_OPEN }, MEM_MERGED));
    const atOpen = await derived(asserted, "PlaceMemoryProjection", PLACE_OPEN);
    assert.deepEqual(atOpen.ok && atOpen.value.rows.map((r) => [r.memory_id, r.place_id]), [[MEM_MERGED, PLACE_OPEN]]);
    const refused = await derived(seed(), "PlaceMemoryProjection", CANON_LOC, { failReads: new Set([TABLE]) });
    assert.deepEqual([refused.ok, (refused as any).reason, (refused as any).table], [false, "source_unavailable", TABLE]);
    const absent = await derived(seed(), "PlaceMemoryProjection", CANON_LOC, { absent: new Set([TABLE]) });
    assert.deepEqual(absent.ok && absent.value.rows.map((r) => r.memory_id), [MEM]);
  });

  it("registry staleness: a new correction makes the registration STALE, and a rebuild with it present is FRESH (both sides fold it)", async () => {
    const store = seed();
    store.memory_derivative_registry = [];
    const client = makeClient(store, []) as any;
    const scope = scopeAt(CANON_LOC);
    const built = await rebuildProjection(client, "PlaceMemoryProjection", scope, new Date("2026-10-07T12:00:00.000Z"));
    assert.ok(built.ok, JSON.stringify(built));
    const fresh = await projectionStaleness(client, "PlaceMemoryProjection", scope);
    assert.ok(fresh.ok && fresh.value.state === "FRESH", JSON.stringify(fresh));
    store[TABLE].push(correction("reject", { place_id: PLACE_SUCCESSOR }));
    const stale = await projectionStaleness(client, "PlaceMemoryProjection", scope);
    assert.ok(stale.ok && stale.value.state === "STALE", JSON.stringify(stale));
    assert.ok((await rebuildProjection(client, "PlaceMemoryProjection", scope, new Date("2026-10-07T12:05:00.000Z"))).ok);
    const again = await projectionStaleness(client, "PlaceMemoryProjection", scope);
    assert.ok(again.ok && again.value.state === "FRESH", JSON.stringify(again));
  });

  it("a FULL page of corrections (PostgREST max-rows) is unreadable: place history 503, the registry source_unavailable", async () => {
    const full = (st: Record<string, any[]>) => { for (let i = 0; i < CORRECTIONS_PAGE; i++) st[TABLE].push(correction("reject", { place_id: `elsewhere-${i}` })); };
    app = await start({ mutate: full });
    assert.equal((await call(app, "GET", `/memories/places/${CANON_LOC}`)).status, 503);
    const store = seed(); full(store);
    const out = await derived(store, "PlaceMemoryProjection", CANON_LOC);
    assert.deepEqual([out.ok, (out as any).table], [false, TABLE]);
    const under = seed(); for (let i = 0; i < CORRECTIONS_PAGE - 1; i++) under[TABLE].push(correction("reject", { place_id: `elsewhere-${i}` }));
    const ok = await derived(under, "PlaceMemoryProjection", CANON_LOC);
    assert.deepEqual(ok.ok && ok.value.rows.map((r) => r.memory_id), [MEM], "control: 999 rows is a whole answer");
  });

  it("an assertion by CANONICAL LOCATION lists the Memory at that canonical place too", async () => {
    const OTHER_CANON = "30000000-0000-4000-8000-000000000009";
    app = await start({ mutate: (st) => { st[TABLE].push(correction("assert", { place_id: null, canonical_location_id: OTHER_CANON }, MEM_MERGED)); } });
    assert.deepEqual((await history(app, OTHER_CANON)).rows.map((r) => r.memory_id), [MEM_MERGED]);
  });

  it("registry: a Memory with NO stored place that an assertion places here is listed (it is found through the assertion, not its row)", async () => {
    const store = seed();
    store.memories.push(memory("10000000-0000-4000-8000-000000000004", { place_id: null, canonical_location_id: null, title: "unplaced" }));
    store[TABLE].push(correction("assert", { place_id: PLACE_OPEN }, "10000000-0000-4000-8000-000000000004"));
    const out = await derived(store, "PlaceMemoryProjection", PLACE_OPEN);
    assert.deepEqual(out.ok && out.value.rows.map((r) => [r.memory_id, r.place_id]), [["10000000-0000-4000-8000-000000000004", PLACE_OPEN]]);
  });

  it("the version folds every correction by content: a second correction on an already-corrected Memory still changes it (route and registry)", async () => {
    app = await start({ mutate: (st) => { st[TABLE].push(correction("reject", { place_id: PLACE_SUCCESSOR })); } });
    const before = await history(app, CANON_LOC);
    app.store[TABLE].push(correction("reject", { place_id: PLACE_OLD }));
    const after = await history(app, CANON_LOC);
    assert.deepEqual(ids(after), [MEM]);
    assert.notEqual(after.sourceVersion, before.sourceVersion);
    const one = seed(); one[TABLE].push(correction("reject", { place_id: PLACE_SUCCESSOR }));
    const two = seed(); two[TABLE].push(correction("reject", { place_id: PLACE_SUCCESSOR }), correction("reject", { place_id: PLACE_OLD }));
    const [a, b] = [await derived(one, "PlaceMemoryProjection", CANON_LOC), await derived(two, "PlaceMemoryProjection", CANON_LOC)];
    assert.ok(a.ok && b.ok && a.value.source_version !== b.value.source_version);
  });

  it("the assertion lookup failing ALONE is a refusal too (route 503, registry source_unavailable) — never 'nothing asserted here'", async () => {
    const failAssertLookup = (base: any) => ({ ...base, from: (t: string) => {
      const c = base.from(t);
      if (t !== TABLE) return c;
      const eq = c.eq;
      c.eq = (col: string, v: unknown) => { const r = eq(col, v); if (col === "kind" && v === "assert") r.then = (ok: any, bad: any) => Promise.resolve({ data: null, error: { code: "57014", message: "assert lookup failed" } }).then(ok, bad); return r; };
      return c;
    } });
    app = await start();
    _setTestClient(failAssertLookup(makeClient(app.store, app.ops)) as any, true);
    assert.equal((await call(app, "GET", `/memories/places/${CANON_LOC}`)).status, 503);
    const out = await deriveProjection(failAssertLookup(makeClient(seed(), [])) as any, "PlaceMemoryProjection", scopeAt(CANON_LOC));
    assert.deepEqual([out.ok, (out as any).table], [false, TABLE]);
  });

  it("MapTrailDerivative: a rejected place id is not carried; an asserted one is", async () => {
    const trailPlace = (out: any) => out.ok ? out.value.rows.find((r: any) => r.memory_id === MEM)?.place_id : `refused: ${JSON.stringify(out)}`;
    assert.equal(trailPlace(await derived(seed(), "MapTrailDerivative", null)), "osm:node/123", "control: the stored pick");
    const rejected = seed(); rejected[TABLE].push(correction("reject", { place_id: "osm:node/123" }));
    assert.equal(trailPlace(await derived(rejected, "MapTrailDerivative", null)), null);
    const asserted = seed(); asserted[TABLE].push(correction("assert", { place_id: PLACE_OPEN }));
    assert.equal(trailPlace(await derived(asserted, "MapTrailDerivative", null)), PLACE_OPEN);
    const refused = await derived(seed(), "MapTrailDerivative", null, { failReads: new Set([TABLE]) });
    assert.deepEqual([refused.ok, (refused as any).table], [false, TABLE]);
  });
});

// ── VERIFY-H5 (e11ba5f6d8): lead rulings H-14 and H-15 ──────────────────────
// Appended: the census cites this file by line.
describe("H-14 — a canonical-location rejection constrains only the AUTOMATIC canonical match; the owner's direct pick wins", () => {
  it("direct catalog pick AT a rejected canonical location: the pick still resolves (both directions in one place)", async () => {
    // (a) MEM_PICKED names the catalog row PLACE_CANON directly; its canonical location is rejected.
    const MEM_PICKED = "10000000-0000-4000-8000-000000000005";
    app = await start({ mutate: (s) => { s.memories.push(memory(MEM_PICKED, { place_id: PLACE_CANON, canonical_location_id: CANON_LOC })); } });
    assert.equal((await call(app, "POST", `/memories/${MEM_PICKED}/corrections`, OWNER, { field: "place", kind: "reject", canonicalLocationId: CANON_LOC })).status, 204);
    const picked = await menuOf(app, MEM_PICKED);
    assert.equal(picked.place?.id, PLACE_CANON, "the owner's own pick wins over their constraint on the canonical match");
    assert.equal(picked.add.available, true);
    // (b) MEM names a PROVIDER pick and reaches PLACE_CANON only through the canonical match: the same rejection refuses it.
    assert.equal((await menuOf(app)).place?.id, PLACE_CANON, "control: before the rejection the canonical match reaches PLACE_CANON");
    assert.equal((await call(app, "POST", `/memories/${MEM}/corrections`, OWNER, { field: "place", kind: "reject", canonicalLocationId: CANON_LOC })).status, 204);
    const matched = await menuOf(app);
    assert.equal(matched.place, null);
    assert.equal(matched.add.available, false); assert.equal(matched.add.reason, "PLACE_REJECTED_BY_OWNER", "VERIFY-H6 H6-2: the owner is told it is their own rejection, not 'not in the catalog'"); const seen = await menuOf(app, MEM, FRIEND); assert.deepEqual([seen.place, seen.add.reason], [null, "PLACE_NOT_IN_CATALOG"], "a viewer is told only what the corrected reference (a provider pick) says — the same as for any uncatalogued pick: no hint of a rejection");
  });
});

describe("H-15 — corrections never make a Memory's place permanently unreadable", () => {
  const edits = (s: Record<string, any[]>, n: number, last: string) => {
    // One PATCH = three rows: reject the old place, reject the old canonical location, assert the new pair.
    let prev = "osm:node/123"; let prevCanon = CANON_LOC;
    for (let i = 0; i < n; i++) {
      const next = i === n - 1 ? last : (i % 2 === 0 ? PLACE_SUCCESSOR : PLACE_OLD);
      const canon = `31000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const batch = [correction("reject", { place_id: prev }), correction("reject", { canonical_location_id: prevCanon }), correction("assert", { place_id: next, canonical_location_id: canon })];
      for (const r of batch) r.created_at = batch[2]!.created_at; // one INSERT: one created_at, as the database stamps it
      s[TABLE].push(...batch);
      prev = next; prevCanon = canon;
    }
    Object.assign(s.memories.find((m) => m.id === MEM)!, { place_id: last, canonical_location_id: prevCanon });
  };

  it("334 place edits of one Memory (over 1000 rows): the newest page holds an assert, so the place, its corrections and place history all read", async () => {
    app = await start({ mutate: (s) => edits(s, 334, PLACE_OPEN) });
    assert.ok(rows(app).length > CORRECTIONS_PAGE, `rows: ${rows(app).length}`);
    assert.equal((await menuOf(app)).place?.id, PLACE_OPEN);
    const got = await call(app, "GET", `/memories/${MEM}/corrections`);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.place.asserted.placeId, PLACE_OPEN);
    assert.deepEqual(got.body.place.rejectedPlaceIds, [PLACE_SUCCESSOR], "only the rejections after the latest assert count");
    const h = await call(app, "GET", `/memories/places/${PLACE_OPEN}`);
    assert.equal(h.status, 200, JSON.stringify(h.body));
    assert.deepEqual(h.body.history.rows.map((r: any) => r.memory_id), [MEM]);
  });

  it("a retry loop against a FAILING Memory write appends the correction once, not once per attempt (H-12 window stays as ruled)", async () => {
    app = await start({ failWrites: new Set(["memories:update"]) });
    for (let i = 0; i < 5; i++) assert.ok((await call(app, "PATCH", `/memories/${MEM}`, OWNER, { placeId: PLACE_OPEN })).status >= 500);
    assert.deepEqual(rows(app).map((r) => r.kind).sort(), ["assert", "reject", "reject"]);
    assert.equal(mem(app).place_id, "osm:node/123", "the write kept failing");
    assert.equal((await menuOf(app)).place?.id, PLACE_OPEN, "H-12: the recorded correction stays; the owner's retry completes the change");
  });

  it("a second identical rejection appends nothing (the route answers 204 both times)", async () => {
    app = await start();
    for (let i = 0; i < 3; i++) assert.equal((await call(app, "POST", `/memories/${MEM}/corrections`, OWNER, { field: "place", kind: "reject", placeId: PLACE_SUCCESSOR })).status, 204);
    assert.equal(rows(app).length, 1);
  });

  it("the LATEST assertion is the owner's whole current word: a rejection recorded before it is superseded, one after it counts", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push(correction("reject", { place_id: PLACE_SUCCESSOR }), correction("assert", { place_id: PLACE_OPEN }), correction("reject", { place_id: PLACE_OLD })); } });
    const got = await call(app, "GET", `/memories/${MEM}/corrections`);
    assert.deepEqual([got.body.place.asserted.placeId, got.body.place.rejectedPlaceIds], [PLACE_OPEN, [PLACE_OLD]]);
  });

  it("over 1000 assertions at ONE place page on and are read whole — place history never refuses for that", async () => {
    app = await start({ mutate: (s) => { for (let i = 0; i < CORRECTIONS_PAGE + 1; i++) s[TABLE].push(correction("assert", { place_id: PLACE_OPEN }, MEM_MERGED)); } });
    const h = await call(app, "GET", `/memories/places/${PLACE_OPEN}`);
    assert.equal(h.status, 200, JSON.stringify(h.body));
    assert.deepEqual(h.body.history.rows.map((r: any) => [r.memory_id, r.place_id]), [[MEM_MERGED, PLACE_OPEN]]);
  });
});

describe("VERIFY-H5 follow-ups — the per-Memory read and the first assertion", () => {
  it("GET /memories/:id/corrections counts only the owner's rows (the per-Memory read is owner-scoped too)", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push({ ...correction("reject", { place_id: PLACE_SUCCESSOR }), owner_id: FRIEND }, correction("reject", { place_id: PLACE_OLD })); } });
    const got = await call(app, "GET", `/memories/${MEM}/corrections`);
    assert.deepEqual(got.body.place.rejectedPlaceIds, [PLACE_OLD]);
  });

  it("placing a Memory that had NO place records the assertion (idempotency never swallows a real change)", async () => {
    const MEM_UNPLACED = "10000000-0000-4000-8000-000000000006";
    app = await start({ mutate: (s) => { s.memories.push(memory(MEM_UNPLACED, { place_id: null, canonical_location_id: null })); } });
    assert.equal((await call(app, "PATCH", `/memories/${MEM_UNPLACED}`, OWNER, { placeId: PLACE_OPEN })).status, 200);
    assert.deepEqual(rows(app).map((r) => [r.memory_id, r.kind, r.place_id]), [[MEM_UNPLACED, "assert", PLACE_OPEN]]);
  });
});

// ── Lead ruling H-16 (2026-10-08): every NON-OWNER read of a Memory's place ──
// goes through the owner's corrections; the owner's own read shows the stored row.
describe("H-16 — a non-owner is shown a Memory's place only through its owner's corrections", () => {
  const TRIP_X = "40000000-0000-4000-8000-000000000001";
  const rejectPick = (s: Record<string, any[]>) => { s[TABLE].push(correction("reject", { place_id: "osm:node/123" })); };
  const assertOpen = (s: Record<string, any[]>) => { s[TABLE].push(correction("assert", { place_id: PLACE_OPEN, canonical_location_id: null })); };
  const withTrip = (s: Record<string, any[]>) => { s.trips = [{ id: TRIP_X, owner_id: OWNER }]; s.memories.find((m) => m.id === MEM)!.trip_id = TRIP_X; };
  const detail = async (a: App, actor: string) => { const r = await call(a, "GET", `/memories/${MEM}`, actor); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.memory as { placeId: string | null; canonicalLocationId: string | null }; };
  const feed = async (a: App, actor: string) => { const r = await call(a, "GET", `/users/${OWNER}/memories`, actor); assert.equal(r.status, 200, JSON.stringify(r.body)); return (r.body.memories as any[]).find((m) => m.id === MEM) as { placeId: string | null; canonicalLocationId: string | null }; };
  const tripMemory = async (a: App, actor: string) => { const r = await call(a, "GET", `/trips/${TRIP_X}/memory`, actor); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.memory as { placeId: string | null; canonicalLocationId: string | null }; };
  const pair = (m: { placeId: string | null; canonicalLocationId: string | null }) => [m.placeId, m.canonicalLocationId];

  it("control: with no correction, a viewer is shown the stored place on the detail, the feed and the trip Memory", async () => {
    app = await start({ mutate: withTrip });
    for (const read of [detail, feed, tripMemory]) assert.deepEqual(pair(await read(app, FRIEND)), ["osm:node/123", CANON_LOC]);
  });

  it("a REJECTED place is never shown to a viewer (detail, feed, trip Memory); the owner's own detail shows the stored row", async () => {
    app = await start({ mutate: (s) => { withTrip(s); rejectPick(s); } });
    for (const read of [detail, feed, tripMemory]) assert.deepEqual(pair(await read(app, FRIEND)), [null, null]);
    assert.deepEqual(pair(await detail(app, OWNER)), ["osm:node/123", CANON_LOC]);
  });

  it("an ASSERTED place is what a viewer is shown, even while the row has not caught up (H-12)", async () => {
    app = await start({ mutate: (s) => { withTrip(s); assertOpen(s); } });
    for (const read of [detail, feed, tripMemory]) assert.deepEqual(pair(await read(app, FRIEND)), [PLACE_OPEN, null]);
  });

  it("unreadable corrections: every non-owner read REFUSES (503); the owner's own detail is unaffected", async () => {
    app = await start({ mutate: withTrip, failReads: new Set([TABLE]) });
    assert.equal((await call(app, "GET", `/memories/${MEM}`, FRIEND)).status, 503);
    assert.equal((await call(app, "GET", `/users/${OWNER}/memories`, FRIEND)).status, 503);
    assert.equal((await call(app, "GET", `/trips/${TRIP_X}/memory`, FRIEND)).status, 503);
    assert.equal((await call(app, "GET", `/memories/${MEM}`, OWNER)).status, 200);
  });

  it("registry: every projection that carries a place reads it through the corrections (TripMemoryProjection's version folds them; the Timeline carries no rejected id)", async () => {
    const tl = (out: any) => (out.ok ? out.value.rows.find((r: any) => r.memory_id === MEM)?.place_id : `refused: ${JSON.stringify(out)}`);
    const timeline = async (st: Record<string, any[]>) => deriveProjection(makeClient(st, []) as any, "MemoryTimelineProjection", { owner_id: OWNER, viewer_id: OWNER, trip_id: null, place_id: null, person_id: null });
    assert.equal(tl(await timeline(seed())), "osm:node/123", "control");
    const rejected = seed(); rejectPick(rejected);
    assert.equal(tl(await timeline(rejected)), null);
    const crew = { owner_id: OWNER, viewer_id: null, trip_id: TRIP_X, place_id: null, person_id: null };
    const trip = async (st: Record<string, any[]>) => deriveProjection(makeClient(st, []) as any, "TripMemoryProjection", crew);
    const plain = seed(); withTrip(plain); const one = seed(); withTrip(one); rejectPick(one);
    const [a, b] = [await trip(plain), await trip(one)];
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    assert.notEqual(a.ok && a.value.source_version, b.ok && b.value.source_version);
    const fail = seed(); withTrip(fail);
    const out = await deriveProjection(makeClient(fail, [], { failReads: new Set([TABLE]) }) as any, "TripMemoryProjection", crew);
    assert.deepEqual([out.ok, (out as any).table], [false, TABLE]);
  });
});

// ── VERIFY-H6 (c1f8daa5a2 / d3165ddff3): lead ruling H-15a, H-14's reason, ──
// the fold's order, the trail's assertion, and the place check before the rung.
// Appended: the census cites this file by line.
describe("VERIFY-H6 H6-1 — lead ruling H-15a: the route's rejections are capped, and a write with an assertion is always made", () => {
  const reject = (a: App, value: { placeId?: string; canonicalLocationId?: string }) =>
    call(a, "POST", `/memories/${MEM}/corrections`, OWNER, { field: "place", kind: "reject", ...value });

  it("1000 route rejections and no assertion (unreadable): the owner's PATCH assertion is still recorded, and the place, its corrections and place history read again", async () => {
    app = await start({ mutate: (s) => { for (let i = 0; i < CORRECTIONS_PAGE; i++) s[TABLE].push(correction("reject", { place_id: `elsewhere-${i}` })); } });
    assert.equal((await menuOf(app)).add.reason, "PLACE_UNREADABLE", "control: a full page with no assertion is unreadable");
    assert.equal((await call(app, "GET", `/memories/${MEM}/corrections`)).status, 503, "control");
    const refused = await reject(app, { placeId: PLACE_SUCCESSOR });
    assert.deepEqual([refused.status, refused.body.reason], [409, "PLACE_REJECTION_LIMIT"], "a 1001st rejection is past the cap: refused, not a 503 the owner cannot get out of");
    assert.equal(rows(app).length, CORRECTIONS_PAGE, "nothing recorded");
    const patched = await call(app, "PATCH", `/memories/${MEM}`, OWNER, { placeId: PLACE_OPEN });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(rows(app).length, CORRECTIONS_PAGE + 3, "the PATCH's two rejections and its assertion are recorded");
    assert.equal(mem(app).place_id, PLACE_OPEN);
    assert.equal((await menuOf(app)).place?.id, PLACE_OPEN, "readable again");
    const got = await call(app, "GET", `/memories/${MEM}/corrections`);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.deepEqual([got.body.place.asserted.placeId, got.body.place.rejectedPlaceIds, got.body.place.rejectedCanonicalLocationIds], [PLACE_OPEN, ["osm:node/123"], [CANON_LOC]], "the assertion opened a new window: the 1000 rejections before it are superseded (H-15)");
    const h = await call(app, "GET", `/memories/places/${PLACE_OPEN}`);
    assert.deepEqual([h.status, h.body?.history?.rows?.map((r: any) => r.memory_id)], [200, [MEM]]);
    assert.equal((await reject(app, { placeId: PLACE_SUCCESSOR })).status, 204, "and the route records rejections again, counted from the new assertion");
  });

  it("the route holds 50 distinct rejections; the 51st is refused (409, nothing recorded); one already in force is still 204; a change of place starts the count again", async () => {
    app = await start();
    for (let i = 0; i < 50; i++) assert.equal((await reject(app, { placeId: `wrong-${i}` })).status, 204, `rejection ${i + 1}`);
    assert.equal(rows(app).length, 50);
    const over = await reject(app, { placeId: "wrong-50" });
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(over.body.reason, "PLACE_REJECTION_LIMIT");
    assert.match(over.body.message, /50 places/);
    assert.equal((await reject(app, { canonicalLocationId: "30000000-0000-4000-8000-0000000000aa" })).status, 409, "a canonical location is a value too");
    assert.equal(rows(app).length, 50, "nothing recorded by either refusal");
    assert.equal((await reject(app, { placeId: "wrong-7" })).status, 204, "a rejection already in force is not a new value: 204, and it records nothing");
    assert.equal(rows(app).length, 50);
    assert.equal((await call(app, "PATCH", `/memories/${MEM}`, OWNER, { placeId: PLACE_OPEN })).status, 200);
    assert.deepEqual(rows(app).slice(50).map((r) => [r.kind, r.source]), [["reject", "memory_edit"], ["reject", "memory_edit"], ["assert", "memory_edit"]]);
    for (let i = 0; i < 50; i++) assert.equal((await reject(app, { placeId: `again-${i}` })).status, 204, `after the assertion, rejection ${i + 1} (the PATCH's own two are not the route's)`);
    assert.equal((await reject(app, { placeId: "again-50" })).status, 409);
    assert.equal(rows(app).length, 103);
    assert.equal((await menuOf(app)).place?.id, PLACE_OPEN, "readable throughout");
  });

  it("a full page with no assertion that holds FEWER than 50 distinct values cannot be judged: a rejection is refused 503 (not recorded), and an assertion still goes through", async () => {
    app = await start({ mutate: (s) => { for (let i = 0; i < CORRECTIONS_PAGE; i++) s[TABLE].push(correction("reject", { place_id: `elsewhere-${i % 3}` })); } });
    const r = await reject(app, { placeId: PLACE_SUCCESSOR });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(rows(app).length, CORRECTIONS_PAGE, "nothing recorded");
    assert.equal((await call(app, "PATCH", `/memories/${MEM}`, OWNER, { placeId: PLACE_OPEN })).status, 200);
    assert.equal((await menuOf(app)).place?.id, PLACE_OPEN);
  });

  it("the cap is the ROUTE's: a PATCH is never refused for it, at the cap or past it", async () => {
    app = await start({ mutate: (s) => { for (let i = 0; i < 60; i++) s[TABLE].push(correction("reject", { place_id: `wrong-${i}` })); } });
    assert.equal((await reject(app, { placeId: PLACE_SUCCESSOR })).status, 409, "control: the route is at its cap");
    assert.equal((await call(app, "PATCH", `/memories/${MEM}`, OWNER, { placeId: PLACE_OPEN })).status, 200);
    assert.equal(mem(app).place_id, PLACE_OPEN);
  });
});

describe("VERIFY-H6 H6-2 — H-14's provider pick: the owner is told it is their rejection; a viewer is told what an uncorrected pick would say", () => {
  it("control: an uncorrected provider pick with no canonical location tells a viewer PLACE_NOT_IN_CATALOG — the same answer the corrected one gives", async () => {
    app = await start({ mutate: (s) => { Object.assign(s.memories.find((m) => m.id === MEM)!, { canonical_location_id: null }); } });
    assert.equal((await menuOf(app, MEM, FRIEND)).add.reason, "PLACE_NOT_IN_CATALOG");
    assert.equal((await menuOf(app)).add.reason, "PLACE_NOT_IN_CATALOG", "and the owner, with nothing rejected, is told the same");
  });

  it("the compile tells the owner PLACE_REJECTED_BY_OWNER (409) after a canonical rejection on a provider pick", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push(correction("reject", { canonical_location_id: CANON_LOC })); } });
    const compiled = await call(app, "GET", `/memories/${MEM}/actions/ADD_TO_TRIP`);
    assert.deepEqual([compiled.status, compiled.body.reason], [409, "PLACE_REJECTED_BY_OWNER"]);
    const seen = await call(app, "GET", `/memories/${MEM}/actions/ADD_TO_TRIP`, FRIEND);
    assert.notEqual(seen.body?.reason, "PLACE_REJECTED_BY_OWNER");
    assert.ok(!JSON.stringify(seen.body).includes("REJECTED"), JSON.stringify(seen.body));
  });
});

describe("VERIFY-H6 H6-6 — the fold orders corrections by INSTANT, never by the timestamp's text", () => {
  const row = (id: string, kind: "assert" | "reject", created_at: string): CorrectionRow => ({ id, kind, place_id: PLACE_OPEN, canonical_location_id: null, created_at });
  const verdict = (c: ReturnType<typeof foldPlaceCorrections>) => [c.asserted?.place_id ?? null, c.rejectedPlaceIds.has(PLACE_OPEN)];

  it("a whole second written WITHOUT a fraction is before a later fraction of that second (as text it sorts after it)", () => {
    assert.equal("2026-04-01T00:00:01+00:00".localeCompare("2026-04-01T00:00:01.5+00:00"), 1, "the hazard: as text the whole second sorts AFTER");
    assert.deepEqual(verdict(foldPlaceCorrections([row("b", "reject", "2026-04-01T00:00:01.5+00:00"), row("a", "assert", "2026-04-01T00:00:01+00:00")])), [null, true], "assert at :01, reject at :01.5 — the rejection is after it and counts");
    assert.deepEqual(verdict(foldPlaceCorrections([row("b", "assert", "2026-04-01T00:00:01.5+00:00"), row("a", "reject", "2026-04-01T00:00:01+00:00")])), [PLACE_OPEN, false], "reject at :01, assert at :01.5 — the assertion is the latest word");
  });

  it("microseconds order (Date.parse keeps milliseconds only), and an offset is an instant, not text", () => {
    assert.deepEqual(verdict(foldPlaceCorrections([row("z", "assert", "2026-04-01T00:00:01.123789+00:00"), row("a", "reject", "2026-04-01T00:00:01.123456+00:00")])), [PLACE_OPEN, false], "a reject 333µs BEFORE the assert is superseded (a millisecond tie would have let it win)");
    assert.deepEqual(verdict(foldPlaceCorrections([row("a", "assert", "2026-04-01T00:00:01.123456+00:00"), row("z", "reject", "2026-04-01T00:00:01.123789+00:00")])), [null, true]);
    assert.deepEqual(verdict(foldPlaceCorrections([row("a", "assert", "2026-04-01T05:00:01+00:00"), row("z", "reject", "2026-04-01T00:00:01.5-05:00")])), [null, true], "00:00:01.5-05:00 is 05:00:01.5Z: after the assert");
  });

  it("over the route: an exact-second assertion followed by a fractional rejection is read in that order", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push({ ...correction("assert", { place_id: PLACE_OPEN }), created_at: "2026-04-01T00:00:01+00:00" }, { ...correction("reject", { place_id: PLACE_OPEN }), created_at: "2026-04-01T00:00:01.5+00:00" }); } });
    const got = await call(app, "GET", `/memories/${MEM}/corrections`);
    assert.deepEqual([got.body.place.asserted, got.body.place.rejectedPlaceIds], [{ placeId: null, canonicalLocationId: null }, [PLACE_OPEN]]);
    assert.notEqual((await menuOf(app)).place?.id, PLACE_OPEN);
  });

  it("a correction whose time cannot be read makes the read unreadable (per-Memory and batched), never mis-ordered", async () => {
    app = await start({ mutate: (s) => { s[TABLE].push({ ...correction("reject", { place_id: PLACE_CANON }), created_at: "not a time" }); } });
    assert.equal((await call(app, "GET", `/memories/${MEM}/corrections`)).status, 503);
    assert.equal((await menuOf(app)).add.reason, "PLACE_UNREADABLE");
  });
});

describe("VERIFY-H6 H6-4 — a Memory with NO stored place is carried at the place its owner asserted, on the trail and every place-carrying projection", () => {
  const UNPLACED = "10000000-0000-4000-8000-000000000007";
  const store = (asserted: boolean) => { const s = seed(); s.memories.push(memory(UNPLACED, { place_id: null, canonical_location_id: null, title: "unplaced" })); if (asserted) s[TABLE].push(correction("assert", { place_id: PLACE_OPEN }, UNPLACED)); return s; };
  const carried = (out: any) => (out.ok ? out.value.rows.find((r: any) => r.memory_id === UNPLACED)?.place_id : `refused: ${JSON.stringify(out)}`);
  const scope = { owner_id: OWNER, viewer_id: OWNER, trip_id: null, place_id: null, person_id: null };

  it("MapTrailDerivative and the Timeline (control: no assertion, no place)", async () => {
    for (const id of ["MapTrailDerivative", "MemoryTimelineProjection"] as const) {
      assert.equal(carried(await deriveProjection(makeClient(store(false), []) as any, id, scope)), null, `control: ${id}`);
      assert.equal(carried(await deriveProjection(makeClient(store(true), []) as any, id, scope)), PLACE_OPEN, id);
    }
  });
});

describe("VERIFY-H6 H6-7 — the place check runs BEFORE the location protection: an assertion never re-adds a place the owner's rung withholds", () => {
  const TRIP_X = "40000000-0000-4000-8000-000000000001";
  const setUp = (rung: string) => (s: Record<string, any[]>) => {
    s.feature_flags.push({ flag: "memory_location_precision_enabled", enabled: true });
    s.trips = [{ id: TRIP_X, owner_id: OWNER }];
    Object.assign(s.memories.find((m) => m.id === MEM)!, { trip_id: TRIP_X, location_precision: rung });
    s[TABLE].push(correction("assert", { place_id: PLACE_OPEN, canonical_location_id: null }));
  };
  const reads: Array<[string, (a: App) => Promise<any>]> = [
    ["detail", async (a) => { const r = await call(a, "GET", `/memories/${MEM}`, FRIEND); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.memory; }],
    ["feed", async (a) => { const r = await call(a, "GET", `/users/${OWNER}/memories`, FRIEND); assert.equal(r.status, 200, JSON.stringify(r.body)); return (r.body.memories as any[]).find((m) => m.id === MEM); }],
    ["trip Memory", async (a) => { const r = await call(a, "GET", `/trips/${TRIP_X}/memory`, FRIEND); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.memory; }],
  ];

  it("control: at the venue rung a viewer is shown the ASSERTED place on all three doors", async () => {
    app = await start({ mutate: setUp("venue") });
    for (const [door, read] of reads) assert.deepEqual([(await read(app)).placeId, (await read(app)).canonicalLocationId], [PLACE_OPEN, null], door);
  });

  it("at the city rung the place stays withheld on all three doors, assertion or not", async () => {
    app = await start({ mutate: setUp("city") });
    for (const [door, read] of reads) assert.deepEqual([(await read(app)).placeId, (await read(app)).canonicalLocationId], [null, null], door);
  });
});

// ── Lead ruling H-17 (2026-10-08): a reference whose automatic match is a ───
// rejected place is dropped whole for everyone but the owner. Appended: cited by line.
describe("H-17 — the owner rejects the auto-matched place: no non-owner door carries its canonical location, or the pick it came from", () => {
  const TRIP_X = "40000000-0000-4000-8000-000000000001";
  const BARE = "10000000-0000-4000-8000-000000000008"; // the control: the same Memory with no place at all
  const setUp = (rejected: boolean) => (s: Record<string, any[]>) => {
    s.trips = [{ id: TRIP_X, owner_id: OWNER }];
    s.memories.find((m) => m.id === MEM)!.trip_id = TRIP_X;
    s.memories.push(memory(BARE, { place_id: null, canonical_location_id: null }));
    s.memory_saves.push({ memory_id: MEM, user_id: FRIEND, created_at: "2026-04-02T00:00:00.000Z" }, { memory_id: BARE, user_id: FRIEND, created_at: "2026-04-02T00:00:00.000Z" });
    s.memories.find((m) => m.id === MEM)!.location_precision = "venue"; // the crew build carries a venue id only at the exact / venue rung (§AL); the flag is off, so the routes are unclamped
    if (rejected) s[TABLE].push(correction("reject", { place_id: PLACE_CANON })); // P, reached only through the canonical match
  };
  const pair = (m: any) => [m.placeId, m.canonicalLocationId];
  const doors: Array<[string, (a: App) => Promise<any>]> = [
    ["detail", async (a) => { const r = await call(a, "GET", `/memories/${MEM}`, FRIEND); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.memory; }],
    ["feed", async (a) => { const r = await call(a, "GET", `/users/${OWNER}/memories`, FRIEND); assert.equal(r.status, 200, JSON.stringify(r.body)); return (r.body.memories as any[]).find((m) => m.id === MEM); }],
    ["saved shelf", async (a) => { const r = await call(a, "GET", `/me/saved-memories`, FRIEND); assert.equal(r.status, 200, JSON.stringify(r.body)); return (r.body.memories as any[]).find((m) => m.id === MEM); }],
    ["trip Memory", async (a) => { const r = await call(a, "GET", `/trips/${TRIP_X}/memory`, FRIEND); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.memory; }],
  ];

  it("control: before the rejection every non-owner door carries the stored pick and its canonical location", async () => {
    app = await start({ mutate: setUp(false) });
    for (const [door, read] of doors) assert.deepEqual(pair(await read(app)), ["osm:node/123", CANON_LOC], door);
  });

  it("after it, every non-owner door carries NO place — not the canonical location, not the pick — while the owner's own detail shows the stored row", async () => {
    app = await start({ mutate: setUp(true) });
    for (const [door, read] of doors) {
      const m = await read(app);
      assert.deepEqual([m.placeId, m.canonicalLocationId], [null, null], door);
      assert.ok(!JSON.stringify(m).includes(CANON_LOC) && !JSON.stringify(m).includes("osm:node/123") && !JSON.stringify(m).includes(PLACE_CANON), `${door}: ${JSON.stringify(m)}`);
    }
    const own = await call(app, "GET", `/memories/${MEM}`, OWNER);
    assert.deepEqual([own.body.memory.placeId, own.body.memory.canonicalLocationId], ["osm:node/123", CANON_LOC]);
  });

  it("the non-owner's action menu and every compile are IDENTICAL to an unplaced Memory's (NO_PLACE_REFERENCE); the owner is told PLACE_REJECTED_BY_OWNER", async () => {
    app = await start({ mutate: setUp(true) });
    const menuBody = async (id: string) => { const r = await call(app!, "GET", `/memories/${id}/actions`, FRIEND); assert.equal(r.status, 200, JSON.stringify(r.body)); return JSON.stringify({ ...r.body.menu, memoryId: "-" }); };
    const rejected = await menuBody(MEM);
    assert.equal(rejected, await menuBody(BARE));
    assert.match(rejected, /NO_PLACE_REFERENCE/);
    for (const action of ["ADD_TO_TRIP", "DO_AGAIN", "TAKE_ME_BACK"]) {
      const [a, b] = [await call(app, "GET", `/memories/${MEM}/actions/${action}`, FRIEND), await call(app, "GET", `/memories/${BARE}/actions/${action}`, FRIEND)];
      assert.deepEqual([a.status, a.body], [b.status, b.body], action);
    }
    assert.equal((await menuOf(app)).add.reason, "PLACE_REJECTED_BY_OWNER");
  });

  it("a rejected place reached through a catalog MERGE drops the reference too (control: unrejected, the viewer sees the stored pick)", async () => {
    app = await start();
    assert.deepEqual(pair((await call(app, "GET", `/memories/${MEM_MERGED}`, FRIEND)).body.memory), [PLACE_OLD, null], "control");
    await app.close(); app = null;
    app = await start({ mutate: (s) => { s[TABLE].push(correction("reject", { place_id: PLACE_SUCCESSOR }, MEM_MERGED)); } });
    assert.deepEqual(pair((await call(app, "GET", `/memories/${MEM_MERGED}`, FRIEND)).body.memory), [null, null]);
  });

  it("a catalog that cannot be read refuses the non-owner read (503) for a Memory with a rejection; one without a rejection makes no catalog read", async () => {
    app = await start({ mutate: setUp(true), failReads: new Set(["places"]) });
    assert.equal((await call(app, "GET", `/memories/${MEM}`, FRIEND)).status, 503);
    assert.equal((await call(app, "GET", `/memories/${MEM}`, OWNER)).status, 200, "the owner's own detail reads no correction");
    await app.close(); app = null;
    app = await start({ mutate: setUp(false), failReads: new Set(["places"]) });
    assert.equal((await call(app, "GET", `/memories/${MEM}`, FRIEND)).status, 200, "control: no rejection, no catalog read");
    await app.close(); app = null;
    app = await start({ mutate: (s) => { setUp(false)(s); s[TABLE].push(correction("assert", { place_id: PLACE_OPEN })); }, failReads: new Set(["places"]) });
    const asserted = await call(app, "GET", `/memories/${MEM}`, FRIEND);
    assert.deepEqual([asserted.status, asserted.body?.memory?.placeId], [200, PLACE_OPEN], "corrections with no rejected place make no catalog read either");
  });

  it("registry: the crew's TripMemoryProjection and the Timeline carry no place for it, and a later catalog merge INTO a rejected place makes a built derivative stale", async () => {
    const crew = { owner_id: OWNER, viewer_id: null, trip_id: TRIP_X, place_id: null, person_id: null };
    const owned = { owner_id: OWNER, viewer_id: OWNER, trip_id: null, place_id: null, person_id: null };
    const of = (out: any) => (out.ok ? out.value.rows.find((r: any) => r.memory_id === MEM) : `refused: ${JSON.stringify(out)}`);
    for (const [id, scope] of [["TripMemoryProjection", crew], ["MemoryTimelineProjection", owned]] as const) {
      const plain = seed(); setUp(false)(plain); const rejected = seed(); setUp(true)(rejected);
      assert.equal(of(await deriveProjection(makeClient(plain, []) as any, id, scope)).place_id, "osm:node/123", `control: ${id}`);
      const row = of(await deriveProjection(makeClient(rejected, []) as any, id, scope));
      assert.ok(!JSON.stringify(row).includes(CANON_LOC) && !JSON.stringify(row).includes("osm:node/123"), `${id}: ${JSON.stringify(row)}`);
    }
    const store = seed(); setUp(false)(store); store.memory_derivative_registry = [];
    store[TABLE].push(correction("reject", { place_id: PLACE_SUCCESSOR })); // a rejection the Memory's match does not reach (yet)
    const client = makeClient(store, []) as any;
    assert.ok((await rebuildProjection(client, "TripMemoryProjection", crew, new Date("2026-10-08T12:00:00.000Z"))).ok);
    const fresh = await projectionStaleness(client, "TripMemoryProjection", crew);
    assert.ok(fresh.ok && fresh.value.state === "FRESH", JSON.stringify(fresh));
    store.places.find((p) => p.id === PLACE_CANON)!.merged_into_place_id = PLACE_SUCCESSOR; // the catalog merges the matched place INTO the rejected one
    const stale = await projectionStaleness(client, "TripMemoryProjection", crew);
    assert.ok(stale.ok && stale.value.state === "STALE", JSON.stringify(stale));
  });
});
