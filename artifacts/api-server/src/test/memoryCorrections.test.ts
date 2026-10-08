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
    let payload: any = null; let wantRows = false; let single = false; let limitN: number | null = null; let conflict: string[] = [];
    const f = (p: (r: any) => boolean) => { filters.push(p); return obj; };
    const obj: any = {
      select() { if (mode !== "select") wantRows = true; return obj; },
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
      not() { return obj; }, or(expr: string) { const terms = String(expr).split(",").map((t) => /^([a-z_]+)\.eq\.(.+)$/.exec(t)); return terms.every(Boolean) ? f((r) => terms.some((m) => String(r[m![1]!]) === m![2])) : obj; }, order() { return obj; }, range() { return obj; }, // §AP: `col.eq.v,…` is applied (the place history read); anything else is ignored as before
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
        const written: any[] = [];
        for (const r of (Array.isArray(payload) ? payload : [payload])) {
          const row = { id: `ins-${++idN}`, created_at: new Date().toISOString(), ...r }; const had = conflict.length > 0 ? all.find((x) => conflict.every((k) => x[k] === row[k])) : undefined; if (had) { Object.assign(had, r); written.push(had); continue; } all.push(row); written.push(row);
        }
        return { data: wantRows ? written : null, error: null };
      }
      let matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode === "update") { for (const r of matched) Object.assign(r, payload); return { data: wantRows ? matched.map((x) => ({ ...x })) : null, error: null }; }
      if (mode === "delete") { store[table] = all.filter((r) => !matched.includes(r)); return { data: wantRows ? matched : null, error: null }; }
      if (limitN != null) matched = matched.slice(0, limitN);
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
    assert.equal(m.add.reason, "PLACE_REJECTED_BY_OWNER");
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
    assert.equal(m.add.reason, "PLACE_NOT_IN_CATALOG");
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

  it("a full page may be truncated ⇒ unreadable", async () => {
    app = await start({
      mutate: (s) => { for (let i = 0; i < CORRECTIONS_PAGE; i++) s[TABLE].push(correction("assert", { place_id: PLACE_CANON })); },
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
    assert.match(sql, /m\.id = NEW\.memory_id AND m\.state = 'deleted'/);
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
