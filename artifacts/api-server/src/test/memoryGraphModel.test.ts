/**
 * The Memories graph-model migration, over the real routers.
 * Decision: docs/architecture/memories-graph-model-decision.md. Migrations 3674-3676
 * (their SQL behaviour is rehearsed in sql/rehearsals/3674_01_memory_graph_behaviour.sql).
 *
 * Census H134 / H135 / H150 / H151 (the commands and their events, through the bus),
 * H194 (a merged id keeps resolving, never as an existence oracle), H196 (shadow
 * comparison, then a gated cutover), H213 / H214 (the candidate rates).
 *
 *   1. GET /memories/graph with every flag OFF is the legacy answer and reads nothing new.
 *   2. Shadow ON: the legacy answer is served; the comparison records COUNTS ONLY; a
 *      failed graph read is counted as a failure, never as "no links".
 *   3. Cutover ON: served from the graph only while the 7-day gate is open; a closed,
 *      unreadable or failing gate/graph read serves the legacy answer, never an empty one.
 *   4. The gate's every boundary.
 *   5. GET /memories/:id on a merged-away id: the survivor through the full read ladder;
 *      a viewer who cannot read the survivor, a blocked viewer, a failed redirect read
 *      and an absent table are all the same 404.
 *   6. POST /memories/merge and POST /memories/:id/split: flag OFF touches nothing;
 *      ownership is checked before the command, uniformly 404; the command goes to
 *      memory_graph_kernel_execute with the Idempotency-Key; the absorbed Memories go
 *      through §21's lifecycle; a replay does not run it again; the kernel's refusals
 *      map to 400 / 404 / 409 / 503.
 *
 * Run: node --import tsx/esm --test src/test/memoryGraphModel.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import memoryGraphRouter, { MEMORY_MERGE_SPLIT_FLAG } from "../routes/memoryGraph.js";
import {
  CUTOVER_GATE,
  MEMORY_GRAPH_CUTOVER_FLAG,
  MEMORY_GRAPH_SHADOW_FLAG,
  compareMoments,
  evaluateCutoverGate,
  gateWindow,
  memoryGraphLinkPath,
  readGraphLinks,
  type GraphLinks,
  type ShadowDailyRow,
} from "../services/memory/memoryGraphShadow.js";
import { lookupMemoryRedirect } from "../services/memory/memoryIdRedirects.js";
import { _resetMemoryKernelMetrics, readMemoryKernelMetrics, countCandidateDecision } from "../services/memory/memoryKernelMetrics.js";
import type { GraphMoment } from "../services/memoryProjections/memoryGraph.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRIEND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PERSON = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TRIP_A = "11111111-1111-4111-8111-11111111aaaa";
const TRIP_B = "11111111-1111-4111-8111-11111111bbbb";
const M1 = "10000000-0000-4000-8000-000000000001";
const M2 = "10000000-0000-4000-8000-000000000002";
const M3 = "10000000-0000-4000-8000-000000000003";
const M_GONE = "10000000-0000-4000-8000-000000000009";
const M_FOREIGN = "10000000-0000-4000-8000-00000000000f";
const ITEM = "20000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-10T12:00:00.000Z");

function mem(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, title: "t", caption: "private words", visibility: "only_me", state: "published",
    allowed_user_ids: [], hidden_user_ids: [], trip_id: null, event_id: null, place_id: null, canonical_location_id: null,
    location_city: null, location_country: null, location_lat: null, location_lng: null,
    starts_at: "2026-03-01T10:00:00.000Z", ends_at: null,
    created_at: "2026-03-01T10:00:00.000Z", updated_at: "2026-03-01T10:00:00.000Z", ...over,
  };
}

type Store = Record<string, any[]>;
function seed(): Store {
  return {
    feature_flags: [],
    memories: [
      mem(M1, { trip_id: TRIP_A, place_id: "osm:1" }),
      mem(M2, { trip_id: TRIP_A, place_id: "osm:2", starts_at: "2026-03-01T11:00:00.000Z" }),
      mem(M3, { trip_id: TRIP_B, visibility: "public", starts_at: "2026-04-01T11:00:00.000Z" }),
      mem(M_GONE, { state: "deleted" }),
      mem(M_FOREIGN, { owner_id: STRANGER }),
    ],
    memory_tags: [{ memory_id: M1, tagged_user_id: PERSON, status: "approved" }],
    memory_entity_links: [],
    memory_graph_shadow_daily: [],
    memory_id_redirects: [],
    memory_items: [], memory_likes: [], memory_saves: [], memory_evidence: [],
    profiles: [], blocks: [], user_follows: [], circle_memberships: [], trips: [], trip_members: [],
    hidden_gems: [], places: [], memory_corrections: [], memory_derivative_registry: [],
    compass_feed_cache: [], compass_cache_invalidations: [], memory_deletion_dead_letters: [],
  };
}
function links(memoryId: string, type: string, id: string, relation = "RELATED") {
  return { owner_id: OWNER, memory_id: memoryId, entity_type: type, entity_id: id, relation_type: relation };
}
/** The graph exactly as 3675's backfill would leave it for seed(). */
function mirroredLinks(): any[] {
  return [
    links(M1, "TRIP", TRIP_A), links(M1, "PLACE", "osm:1"), links(M1, "PERSON", PERSON),
    links(M2, "TRIP", TRIP_A), links(M2, "PLACE", "osm:2"),
    links(M3, "TRIP", TRIP_B),
  ];
}
function cleanWeek(compared = 100): ShadowDailyRow[] {
  const out: ShadowDailyRow[] = [];
  for (let d = 1; d <= 7; d++) {
    out.push({ day: new Date(Date.UTC(2026, 9, 10 - d)).toISOString().slice(0, 10), compared, mismatched: 0, graph_read_failures: 0 });
  }
  return out;
}

interface Opts { failReads?: Set<string>; absent?: Set<string>; rpcError?: Set<string> }
interface Call { table?: string; fn?: string; mode: string; args?: any }
function makeClient(store: Store, calls: Call[], opts: Opts, rpc: (fn: string, args: any) => any) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let mode = "select"; let head = false; let limitN: number | null = null; let payload: any = null;
    const b: any = {
      select(_c?: string, o?: any) { if (o?.head) head = true; return b; },
      insert(d: any) { mode = "insert"; payload = d; return b; },
      update(d: any) { mode = "update"; payload = d; return b; },
      upsert(d: any) { mode = "upsert"; payload = d; return b; },
      delete() { mode = "delete"; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      gte(c: string, v: any) { filters.push((r) => r[c] >= v); return b; },
      lte(c: string, v: any) { filters.push((r) => r[c] <= v); return b; },
      gt() { return b; }, lt() { return b; }, not() { return b; }, or() { return b; },
      contains(c: string, vs: any[]) { filters.push((r) => Array.isArray(r[c]) && vs.every((v) => r[c].includes(v))); return b; },
      order() { return b; }, range() { return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle: () => run(true), single: () => run(true),
      then(ok: any, bad: any) { return run(false).then(ok, bad); },
    };
    async function run(single: boolean): Promise<any> {
      calls.push({ table, mode });
      if (opts.absent?.has(table)) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` }, count: null };
      if (mode === "select" && opts.failReads?.has(table)) return { data: null, error: { code: "57014", message: `${table} read failed` }, count: null };
      const all = (store[table] ??= []);
      const rows = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") { rows.forEach((r) => Object.assign(r, payload)); return { data: rows, error: null }; }
      if (mode === "delete") { store[table] = all.filter((r) => !rows.includes(r)); return { data: rows, error: null }; }
      if (mode === "insert" || mode === "upsert") { const ps = Array.isArray(payload) ? payload : [payload]; all.push(...ps); return { data: ps, error: null }; }
      if (head) return { data: null, error: null, count: rows.length };
      const lim = limitN == null ? rows : rows.slice(0, limitN);
      return single ? { data: lim[0] ?? null, error: null } : { data: lim, error: null, count: rows.length };
    }
    return b;
  }
  return {
    from,
    rpc: async (fn: string, args: any) => {
      calls.push({ fn, mode: "rpc", args });
      if (opts.rpcError?.has(fn)) return { data: null, error: { code: "PGRST202", message: `${fn} not found` } };
      return { data: rpc(fn, args), error: null };
    },
    auth: {
      getUser: async (tok: string) => {
        const map: Record<string, string> = { "owner-tok": OWNER, "friend-tok": FRIEND, "stranger-tok": STRANGER };
        return map[tok] ? { data: { user: { id: map[tok] } }, error: null } : { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
}

function flags(store: Store, ...on: string[]) {
  store.feature_flags = on.map((flag) => ({ flag, enabled: true }));
}

async function startApp(store: Store, calls: Call[], opts: Opts = {}, rpc: (fn: string, args: any) => any = () => null) {
  _setTestClient(makeClient(store, calls, opts, rpc) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", memoryGraphRouter);
  app.use("/api", memoriesRouter);
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }) });
    });
    srv.on("error", reject);
  });
}

async function call(base: string, method: string, path: string, tok?: string, body?: unknown, key?: string) {
  const h: Record<string, string> = { connection: "close", "content-type": "application/json" };
  if (tok) h.Authorization = `Bearer ${tok}`;
  if (key) h["Idempotency-Key"] = key;
  const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const graphReads = (calls: Call[]) => calls.filter((c) => c.table === "memory_entity_links").length;
const shadowRecords = (calls: Call[]) => calls.filter((c) => c.fn === "memory_graph_shadow_record");

function tripKeys(body: any): string[] {
  return (body.graph.levels.TRIP as any[]).map((n) => `${n.key}:${[...n.memberMemoryIds].sort().join("+")}`).sort();
}

// ═════════════════════════════════════════════════════════════════════════════
describe("H196 — GET /memories/graph: legacy answer, shadow comparison, gated cutover", () => {
  it("every flag OFF: the legacy answer, byte-for-byte the shape it had, and the graph is never read", async () => {
    const store = seed(); const calls: Call[] = [];
    store.memory_entity_links = []; // an EMPTY graph: if it were read for serving, trips would vanish
    const app = await startApp(store, calls);
    try {
      const r = await call(app.base, "GET", "/api/memories/graph", "owner-tok");
      assert.equal(r.status, 200);
      assert.deepEqual(tripKeys(r.body), [`${TRIP_A}:${M1}+${M2}`, `${TRIP_B}:${M3}`]);
      assert.equal("linkSource" in r.body.graph, false);
      await settle();
      assert.equal(graphReads(calls), 0);
      assert.equal(shadowRecords(calls).length, 0);
    } finally { await app.close(); }
  });

  it("shadow ON and the graph agrees: legacy served, compared=3 mismatched=0 recorded — counts only, no id", async () => {
    const store = seed(); const calls: Call[] = [];
    flags(store, MEMORY_GRAPH_SHADOW_FLAG);
    store.memory_entity_links = mirroredLinks();
    const app = await startApp(store, calls);
    try {
      const r = await call(app.base, "GET", "/api/memories/graph", "owner-tok");
      assert.equal(r.status, 200);
      assert.equal("linkSource" in r.body.graph, false);
      await settle();
      const rec = shadowRecords(calls);
      assert.equal(rec.length, 1);
      assert.deepEqual(rec[0]!.args, { p_surface: "memories_graph", p_compared: 3, p_mismatched: 0, p_trip: 0, p_place: 0, p_people: 0, p_read_failures: 0 });
      assert.doesNotMatch(JSON.stringify(rec[0]!.args), /[0-9a-f]{8}-[0-9a-f]{4}/, "a shadow record carries no id");
    } finally { await app.close(); }
  });

  it("shadow ON and the graph DIFFERS: the response is still the legacy one; the mismatch is counted per field", async () => {
    const store = seed(); const calls: Call[] = [];
    flags(store, MEMORY_GRAPH_SHADOW_FLAG);
    store.memory_entity_links = mirroredLinks().filter((l) => !(l.memory_id === M1 && l.entity_type === "PERSON"))
      .map((l) => (l.memory_id === M2 && l.entity_type === "TRIP" ? { ...l, entity_id: TRIP_B } : l));
    const app = await startApp(store, calls);
    try {
      const r = await call(app.base, "GET", "/api/memories/graph", "owner-tok");
      assert.deepEqual(tripKeys(r.body), [`${TRIP_A}:${M1}+${M2}`, `${TRIP_B}:${M3}`], "the legacy trips are served");
      await settle();
      assert.deepEqual(shadowRecords(calls)[0]!.args, { p_surface: "memories_graph", p_compared: 3, p_mismatched: 2, p_trip: 1, p_place: 0, p_people: 1, p_read_failures: 0 });
    } finally { await app.close(); }
  });

  it("shadow ON and the graph read FAILS: one read failure recorded, nothing compared, legacy served", async () => {
    const store = seed(); const calls: Call[] = [];
    flags(store, MEMORY_GRAPH_SHADOW_FLAG);
    const app = await startApp(store, calls, { failReads: new Set(["memory_entity_links"]) });
    try {
      const r = await call(app.base, "GET", "/api/memories/graph", "owner-tok");
      assert.equal(r.status, 200);
      assert.deepEqual(tripKeys(r.body), [`${TRIP_A}:${M1}+${M2}`, `${TRIP_B}:${M3}`]);
      await settle();
      assert.deepEqual(shadowRecords(calls)[0]!.args, { p_surface: "memories_graph", p_compared: 0, p_mismatched: 0, p_trip: 0, p_place: 0, p_people: 0, p_read_failures: 1 });
    } finally { await app.close(); }
  });

  it("cutover ON but the gate is CLOSED (no shadow history): the legacy answer, and the graph is not read to serve", async () => {
    const store = seed(); const calls: Call[] = [];
    flags(store, MEMORY_GRAPH_CUTOVER_FLAG);
    store.memory_entity_links = [];
    const app = await startApp(store, calls);
    try {
      const r = await call(app.base, "GET", "/api/memories/graph", "owner-tok");
      assert.deepEqual(tripKeys(r.body), [`${TRIP_A}:${M1}+${M2}`, `${TRIP_B}:${M3}`]);
      assert.equal("linkSource" in r.body.graph, false);
      assert.equal(graphReads(calls), 0);
    } finally { await app.close(); }
  });

  it("cutover ON and the gate OPEN: links are served from the graph (linkSource: graph)", async () => {
    const store = seed(); const calls: Call[] = [];
    flags(store, MEMORY_GRAPH_CUTOVER_FLAG);
    // The window is relative to the real clock here (the route reads now()).
    const today = new Date();
    store.memory_graph_shadow_daily = cleanWeek().map((r, i) => ({
      ...r, surface: "memories_graph",
      day: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (i + 1))).toISOString().slice(0, 10),
    }));
    // A graph that differs, so serving from it is observable: M2 moved to TRIP_B.
    store.memory_entity_links = mirroredLinks().map((l) => (l.memory_id === M2 && l.entity_type === "TRIP" ? { ...l, entity_id: TRIP_B } : l));
    const app = await startApp(store, calls);
    try {
      const r = await call(app.base, "GET", "/api/memories/graph", "owner-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.graph.linkSource, "graph");
      assert.deepEqual(tripKeys(r.body), [`${TRIP_A}:${M1}`, `${TRIP_B}:${M2}+${M3}`]);
    } finally { await app.close(); }
  });

  it("cutover ON and the gate OPEN: `unplaced` is counted over the SAME moments the levels were built from (VERIFY-MG MG-F4)", async () => {
    const store = seed(); const calls: Call[] = [];
    flags(store, MEMORY_GRAPH_CUTOVER_FLAG);
    const today = new Date();
    store.memory_graph_shadow_daily = cleanWeek().map((r, i) => ({
      ...r, surface: "memories_graph",
      day: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (i + 1))).toISOString().slice(0, 10),
    }));
    // The graph holds no TRIP edge for M3, so the TRIP level lacks M3 and unplaced.TRIP must say 1.
    store.memory_entity_links = mirroredLinks().filter((l) => !(l.memory_id === M3 && l.entity_type === "TRIP"));
    const app = await startApp(store, calls);
    try {
      const r = await call(app.base, "GET", "/api/memories/graph", "owner-tok");
      assert.equal(r.body.graph.linkSource, "graph");
      assert.deepEqual(tripKeys(r.body), [`${TRIP_A}:${M1}+${M2}`]);
      assert.equal(r.body.graph.unplaced.TRIP, 1, "unplaced agrees with the TRIP level, not with the legacy columns");
    } finally { await app.close(); }
  });

  it("cutover ON, gate OPEN, graph read FAILS: the legacy answer — never an empty graph", async () => {
    const store = seed(); const calls: Call[] = [];
    flags(store, MEMORY_GRAPH_CUTOVER_FLAG);
    const today = new Date();
    store.memory_graph_shadow_daily = cleanWeek().map((r, i) => ({
      ...r, surface: "memories_graph",
      day: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (i + 1))).toISOString().slice(0, 10),
    }));
    const app = await startApp(store, calls, { failReads: new Set(["memory_entity_links"]) });
    try {
      const r = await call(app.base, "GET", "/api/memories/graph", "owner-tok");
      assert.equal(r.status, 200);
      assert.equal("linkSource" in r.body.graph, false);
      assert.deepEqual(tripKeys(r.body), [`${TRIP_A}:${M1}+${M2}`, `${TRIP_B}:${M3}`]);
    } finally { await app.close(); }
  });

  it("cutover ON and the gate UNREADABLE: the legacy answer", async () => {
    const store = seed(); const calls: Call[] = [];
    flags(store, MEMORY_GRAPH_CUTOVER_FLAG);
    store.memory_entity_links = [];
    const app = await startApp(store, calls, { failReads: new Set(["memory_graph_shadow_daily"]) });
    try {
      const r = await call(app.base, "GET", "/api/memories/graph", "owner-tok");
      assert.deepEqual(tripKeys(r.body), [`${TRIP_A}:${M1}+${M2}`, `${TRIP_B}:${M3}`]);
      assert.equal(graphReads(calls), 0);
    } finally { await app.close(); }
  });
});

describe("H196 — the cutover gate ('comparison clean'), every boundary", () => {
  it("the window is the 7 complete UTC days before today", () => {
    assert.deepEqual(gateWindow(NOW), { from: "2026-10-03", to: "2026-10-09" });
  });
  it("opens on a clean week with enough volume", () => {
    const v = evaluateCutoverGate(cleanWeek(100), NOW);
    assert.equal(v.open, true);
    assert.equal(v.compared, 700);
  });
  it("closes on ONE mismatch", () => {
    const rows = cleanWeek(100); rows[3] = { ...rows[3]!, mismatched: 1 };
    assert.deepEqual([evaluateCutoverGate(rows, NOW).open, (evaluateCutoverGate(rows, NOW) as any).reason], [false, "mismatches"]);
  });
  it("closes on ONE graph read failure", () => {
    const rows = cleanWeek(100); rows[0] = { ...rows[0]!, graph_read_failures: 1 };
    assert.equal((evaluateCutoverGate(rows, NOW) as any).reason, "read_failures");
  });
  it("needs at least minCompared comparisons: 499 closed, 500 open", () => {
    const at = (n: number) => { const rows = cleanWeek(0); rows[0] = { ...rows[0]!, compared: n - 400 }; for (let i = 1; i <= 4; i++) rows[i] = { ...rows[i]!, compared: 100 }; return rows; };
    assert.equal(CUTOVER_GATE.minCompared, 500);
    assert.equal((evaluateCutoverGate(at(499), NOW) as any).reason, "insufficient_volume");
    assert.equal(evaluateCutoverGate(at(500), NOW).open, true);
  });
  it("needs data on at least 5 of the 7 days: one busy day cannot certify a week", () => {
    const rows = cleanWeek(0); rows[0] = { ...rows[0]!, compared: 5000 };
    for (let i = 1; i <= 3; i++) rows[i] = { ...rows[i]!, compared: 1 };
    assert.equal((evaluateCutoverGate(rows, NOW) as any).reason, "insufficient_days");
    rows[4] = { ...rows[4]!, compared: 1 };
    assert.equal(evaluateCutoverGate(rows, NOW).open, true);
  });
  it("ignores today (still accumulating) and anything older than the window", () => {
    const rows = [
      { day: "2026-10-10", compared: 10_000, mismatched: 0, graph_read_failures: 0 },
      { day: "2026-10-02", compared: 10_000, mismatched: 0, graph_read_failures: 0 },
    ];
    assert.equal(evaluateCutoverGate(rows, NOW).compared, 0);
    const bad = [...cleanWeek(100), { day: "2026-10-10", compared: 1, mismatched: 1, graph_read_failures: 0 }];
    assert.equal(evaluateCutoverGate(bad, NOW).open, true, "today's mismatch is judged tomorrow, inside the window");
  });
});

describe("H196 — the comparison itself", () => {
  const m = (id: string, trip: string | null, place: string | null, people: string[] = []): GraphMoment => ({
    memory_id: id, owner_id: OWNER, occurred_at: "2026-01-01T00:00:00.000Z", utc_offset_minutes: 0,
    episode_id: null, trip_id: trip, place_id: place, people, significance_score: null,
  });
  const g = (o: Partial<GraphLinks> = {}): GraphLinks => ({ trips: [], places: [], people: [], ...o });
  it("people are a SET: order and duplicates do not mismatch; a missing person does", () => {
    const ok = compareMoments([m("a", null, null, ["p2", "p1"])], new Map([["a", g({ people: ["p1", "p2", "p1"] })]]));
    assert.equal(ok.mismatched, 0);
    const bad = compareMoments([m("a", null, null, ["p1", "p2"])], new Map([["a", g({ people: ["p1"] })]]));
    assert.deepEqual([bad.mismatched, bad.people], [1, 1]);
  });
  it("an empty place id is no place on both paths", () => {
    assert.equal(compareMoments([m("a", null, "")], new Map([["a", g()]])).mismatched, 0);
  });
  it("two TRIP edges never equal one scalar trip", () => {
    const r = compareMoments([m("a", "t1", null)], new Map([["a", g({ trips: ["t1", "t2"] })]]));
    assert.deepEqual([r.mismatched, r.trip], [1, 1]);
  });
  it("a Memory the graph has no row for is compared (and mismatches when it has links)", () => {
    const r = compareMoments([m("a", "t1", null), m("b", null, null)], new Map());
    assert.deepEqual([r.compared, r.mismatched], [2, 1]);
  });
  it("readGraphLinks reports an absent view as absent and any other error as a failed read", async () => {
    const calls: Call[] = [];
    const absent = makeClient(seed(), calls, { absent: new Set(["memory_entity_links"]) }, () => null);
    assert.deepEqual(await readGraphLinks(absent as any, OWNER, [M1]), { ok: false, absent: true });
    const failing = makeClient(seed(), calls, { failReads: new Set(["memory_entity_links"]) }, () => null);
    assert.deepEqual(await readGraphLinks(failing as any, OWNER, [M1]), { ok: false, absent: false });
  });
  it("readGraphLinks never returns another owner's edges", async () => {
    const store = seed(); const calls: Call[] = [];
    store.memory_entity_links = [{ ...links(M1, "PERSON", STRANGER), owner_id: STRANGER }];
    const r = await readGraphLinks(makeClient(store, calls, {}, () => null) as any, OWNER, [M1]);
    assert.ok(r.ok);
    assert.deepEqual((r as any).links.get(M1).people, []);
  });
  it("memoryGraphLinkPath with no moments reads no flag and nothing else", async () => {
    const calls: Call[] = [];
    const out = await memoryGraphLinkPath(makeClient(seed(), calls, {}, () => null) as any, { ownerId: OWNER, moments: [] });
    assert.equal(out.source, "legacy");
    assert.equal(calls.length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("H194 — GET /memories/:id keeps a merged-away id resolving, never as an oracle", () => {
  function merged(survivorOver: Record<string, unknown> = {}): Store {
    const store = seed();
    store.memories = store.memories.map((r) => (r.id === M2 ? { ...r, state: "deleted" } : r.id === M1 ? { ...r, ...survivorOver } : r));
    store.memory_id_redirects = [{ old_memory_id: M2, new_memory_id: M1 }];
    // VERIFY-MG MG-F3: the survivor has its OWN item and tag, so a redirect that
    // forgot to re-point `id` (and read items/tags under the old one) is visible.
    store.memory_items = [{ id: ITEM, memory_id: M1, media_url: "https://cdn.example/u1.jpg", media_type: "image/jpeg", caption: null, position: 0, created_at: "2026-03-01T10:00:00.000Z", visibility: null }];
    return store;
  }
  it("the owner gets the survivor, with redirectedFrom", async () => {
    const calls: Call[] = [];
    const app = await startApp(merged(), calls);
    try {
      const r = await call(app.base, "GET", `/api/memories/${M2}`, "owner-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.memory.id, M1);
      assert.equal(r.body.memory.redirectedFrom, M2);
      assert.deepEqual(r.body.memory.items.map((i: any) => i.id), [ITEM], "the survivor's items, read under the survivor's id");
      assert.ok(JSON.stringify(r.body.memory.tags).includes(PERSON), "the survivor's tag, read under the survivor's id");
    } finally { await app.close(); }
  });
  it("a viewer the survivor admits (public) is served it", async () => {
    const calls: Call[] = [];
    const app = await startApp(merged({ visibility: "public" }), calls);
    try {
      const r = await call(app.base, "GET", `/api/memories/${M2}`, "friend-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.memory.id, M1);
    } finally { await app.close(); }
  });
  it("a viewer the survivor does NOT admit gets the plain 404 an unknown id gets", async () => {
    const calls: Call[] = [];
    const app = await startApp(merged({ visibility: "only_me" }), calls);
    try {
      const r = await call(app.base, "GET", `/api/memories/${M2}`, "friend-tok");
      const unknown = await call(app.base, "GET", `/api/memories/10000000-0000-4000-8000-0000000000ee`, "friend-tok");
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, unknown.body, "indistinguishable from an id that never existed");
    } finally { await app.close(); }
  });
  it("a viewer blocked by the owner gets 404 even when the survivor is public", async () => {
    const store = merged({ visibility: "public" });
    store.blocks = [{ blocker_id: OWNER, blocked_id: FRIEND }];
    const calls: Call[] = [];
    const app = await startApp(store, calls);
    try {
      const r = await call(app.base, "GET", `/api/memories/${M2}`, "friend-tok");
      assert.equal(r.status, 404);
    } finally { await app.close(); }
  });
  it("a failed redirect read is a 404 (and nothing is written)", async () => {
    const calls: Call[] = [];
    const app = await startApp(merged(), calls, { failReads: new Set(["memory_id_redirects"]) });
    try {
      const r = await call(app.base, "GET", `/api/memories/${M2}`, "owner-tok");
      assert.equal(r.status, 404);
      assert.equal(calls.filter((c) => c.mode !== "select" && c.mode !== "rpc").length, 0);
    } finally { await app.close(); }
  });
  it("an absent redirect table (3674 unapplied) is 'no merge ever happened'", async () => {
    const calls: Call[] = [];
    const client = makeClient(merged(), calls, { absent: new Set(["memory_id_redirects"]) }, () => null);
    assert.deepEqual(await lookupMemoryRedirect(client as any, M2), { state: "none" });
  });
  it("a live id never consults the redirect table", async () => {
    const calls: Call[] = [];
    const app = await startApp(merged(), calls);
    try {
      const r = await call(app.base, "GET", `/api/memories/${M1}`, "owner-tok");
      assert.equal(r.status, 200);
      assert.equal("redirectedFrom" in r.body.memory, false);
      assert.equal(calls.filter((c) => c.table === "memory_id_redirects").length, 0);
    } finally { await app.close(); }
  });
  it("a redirect to a survivor that is itself deleted is a 404", async () => {
    const store = merged();
    store.memories = store.memories.map((r) => (r.id === M1 ? { ...r, state: "deleted" } : r));
    const calls: Call[] = [];
    const app = await startApp(store, calls);
    try {
      assert.equal((await call(app.base, "GET", `/api/memories/${M2}`, "owner-tok")).status, 404);
    } finally { await app.close(); }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("H134 / H135 / H150 / H151 — POST /memories/merge and POST /memories/:id/split", () => {
  beforeEach(() => { _resetMemoryKernelMetrics(); });
  const okMerge = (fn: string, args: any) => (fn === "memory_graph_kernel_execute"
    ? { ok: true, duplicate: false, memory_id: args.p_command.memory_id, event_id: "e1", event_type: "memory.merged",
        result: { survivor_id: args.p_command.memory_id, absorbed_memory_ids: args.p_command.payload.absorbed_memory_ids, moved: { items: 2 } }, contract_version: 1 }
    : null);
  const kernelCalls = (calls: Call[]) => calls.filter((c) => c.fn === "memory_graph_kernel_execute");

  it("flag OFF: both routes answer feature_disabled and the kernel is never called", async () => {
    const store = seed(); const calls: Call[] = [];
    const app = await startApp(store, calls, {}, okMerge);
    try {
      const a = await call(app.base, "POST", "/api/memories/merge", "owner-tok", { survivorId: M1, absorbedIds: [M2] });
      const b = await call(app.base, "POST", `/api/memories/${M1}/split`, "owner-tok", { itemIds: [ITEM] });
      assert.deepEqual([a.status, a.body.error, b.status, b.body.error], [404, "feature_disabled", 404, "feature_disabled"]);
      assert.equal(kernelCalls(calls).length, 0);
    } finally { await app.close(); }
  });

  it("an unreadable flag is OFF", async () => {
    const store = seed(); const calls: Call[] = [];
    const app = await startApp(store, calls, { failReads: new Set(["feature_flags"]) }, okMerge);
    try {
      const a = await call(app.base, "POST", "/api/memories/merge", "owner-tok", { survivorId: M1, absorbedIds: [M2] });
      assert.equal(a.body.error, "feature_disabled");
      assert.equal(kernelCalls(calls).length, 0);
    } finally { await app.close(); }
  });

  it("someone else's, a deleted or a missing Memory is ONE uniform 404, before any command", async () => {
    const store = seed(); flags(store, MEMORY_MERGE_SPLIT_FLAG); const calls: Call[] = [];
    const app = await startApp(store, calls, {}, okMerge);
    try {
      const foreign = await call(app.base, "POST", "/api/memories/merge", "owner-tok", { survivorId: M1, absorbedIds: [M_FOREIGN] });
      const gone = await call(app.base, "POST", "/api/memories/merge", "owner-tok", { survivorId: M1, absorbedIds: [M_GONE] });
      const missing = await call(app.base, "POST", "/api/memories/merge", "owner-tok", { survivorId: M1, absorbedIds: ["10000000-0000-4000-8000-0000000000ee"] });
      const split = await call(app.base, "POST", `/api/memories/${M_FOREIGN}/split`, "owner-tok", { itemIds: [ITEM] });
      for (const r of [foreign, gone, missing, split]) assert.deepEqual([r.status, r.body.error], [404, "not_found"]);
      assert.deepEqual(foreign.body, missing.body, "another person's Memory is indistinguishable from none");
      assert.equal(kernelCalls(calls).length, 0);
    } finally { await app.close(); }
  });

  it("a failed ownership read is 503 and no command is issued", async () => {
    const store = seed(); flags(store, MEMORY_MERGE_SPLIT_FLAG); const calls: Call[] = [];
    const app = await startApp(store, calls, { failReads: new Set(["memories"]) }, okMerge);
    try {
      const r = await call(app.base, "POST", "/api/memories/merge", "owner-tok", { survivorId: M1, absorbedIds: [M2] });
      assert.equal(r.status, 503);
      assert.equal(kernelCalls(calls).length, 0);
    } finally { await app.close(); }
  });

  it("a malformed body is 400 before anything is read: duplicates, the survivor absorbed, too many", async () => {
    const store = seed(); flags(store, MEMORY_MERGE_SPLIT_FLAG); const calls: Call[] = [];
    const app = await startApp(store, calls, {}, okMerge);
    try {
      for (const body of [
        { survivorId: M1, absorbedIds: [M2, M2] },
        { survivorId: M1, absorbedIds: [M1] },
        { survivorId: M1, absorbedIds: [] },
        { survivorId: M1, absorbedIds: Array.from({ length: 21 }, (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`) },
      ]) {
        assert.equal((await call(app.base, "POST", "/api/memories/merge", "owner-tok", body)).status, 400);
      }
      assert.equal((await call(app.base, "POST", `/api/memories/${M1}/split`, "owner-tok", { itemIds: [ITEM, ITEM] })).status, 400);
      assert.equal(kernelCalls(calls).length, 0);
    } finally { await app.close(); }
  });

  it("a merge goes through memory_graph_kernel_execute with the Idempotency-Key, then §21 runs for the absorbed Memory", async () => {
    const store = seed(); flags(store, MEMORY_MERGE_SPLIT_FLAG); const calls: Call[] = [];
    const app = await startApp(store, calls, {}, (fn, args) => {
      const out = okMerge(fn, args);
      if (out) store.memories = store.memories.map((r) => (r.id === M2 ? { ...r, state: "deleted" } : r)); // what 3676 does
      return out;
    });
    try {
      const r = await call(app.base, "POST", "/api/memories/merge", "owner-tok", { survivorId: M1, absorbedIds: [M2] }, "merge-key-1");
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.survivorId, r.body.absorbedIds, r.body.duplicate], [M1, [M2], false]);
      const k = kernelCalls(calls);
      assert.equal(k.length, 1);
      assert.deepEqual([k[0]!.args.p_command.type, k[0]!.args.p_command.memory_id, k[0]!.args.p_command.idempotency_key, k[0]!.args.p_command.actor_user_id],
        ["MERGE_MEMORY", M1, "merge-key-1", OWNER]);
      assert.deepEqual(k[0]!.args.p_command.payload, { absorbed_memory_ids: [M2] });
      // §21 ran: DERIVATIVES_PURGED read the registry and DELETED re-read the absorbed row.
      assert.ok(calls.some((c) => c.table === "memory_derivative_registry"), "§21 DERIVATIVES_PURGED ran for the absorbed Memory");
      assert.ok(calls.filter((c) => c.table === "memories").length >= 2, "§21 DELETED re-read the absorbed Memory");
      assert.equal(store.memory_deletion_dead_letters.length, 0, "the lifecycle completed: no dead letter");
    } finally { await app.close(); }
  });

  it("a replayed merge (duplicate receipt) does NOT run §21 again", async () => {
    const store = seed(); flags(store, MEMORY_MERGE_SPLIT_FLAG); const calls: Call[] = [];
    const app = await startApp(store, calls, {}, (fn, args) => ({ ...okMerge(fn, args), duplicate: true }));
    try {
      const r = await call(app.base, "POST", "/api/memories/merge", "owner-tok", { survivorId: M1, absorbedIds: [M2] }, "k");
      assert.equal(r.body.duplicate, true);
      assert.equal(calls.some((c) => c.table === "memory_derivative_registry"), false);
    } finally { await app.close(); }
  });

  it("the kernel's refusals: audience mismatch 409, invalid 400, item not found 404, kernel absent 503", async () => {
    const store = seed(); flags(store, MEMORY_MERGE_SPLIT_FLAG); const calls: Call[] = [];
    let answer: any = null;
    const app = await startApp(store, calls, {}, () => answer);
    try {
      answer = { ok: false, reason: "MEMORY_MERGE_AUDIENCE_MISMATCH", contract_version: 1 };
      const a = await call(app.base, "POST", "/api/memories/merge", "owner-tok", { survivorId: M1, absorbedIds: [M3] });
      assert.deepEqual([a.status, a.body.reason], [409, "MEMORY_MERGE_AUDIENCE_MISMATCH"]);
      answer = { ok: false, reason: "MEMORY_SPLIT_INVALID", detail: "a split must leave at least one item on the source", contract_version: 1 };
      const b = await call(app.base, "POST", `/api/memories/${M1}/split`, "owner-tok", { itemIds: [ITEM] });
      assert.deepEqual([b.status, b.body.reason], [400, "MEMORY_SPLIT_INVALID"]);
      answer = { ok: false, reason: "MEMORY_ITEM_NOT_FOUND", contract_version: 1 };
      const c = await call(app.base, "POST", `/api/memories/${M1}/split`, "owner-tok", { itemIds: [ITEM] });
      assert.equal(c.status, 404);
      answer = null; // the RPC returns no object: kernel absent
      const d = await call(app.base, "POST", "/api/memories/merge", "owner-tok", { survivorId: M1, absorbedIds: [M2] });
      assert.deepEqual([d.status, d.body.error], [503, "kernel_unavailable"]);
      assert.equal(calls.some((x) => x.table === "memory_derivative_registry"), false, "no lifecycle after a refusal");
    } finally { await app.close(); }
  });

  it("a split returns 201 with the new Memory and re-derives the source's derivatives", async () => {
    const store = seed(); flags(store, MEMORY_MERGE_SPLIT_FLAG); const calls: Call[] = [];
    const NEW = "10000000-0000-4000-8000-0000000000aa";
    const app = await startApp(store, calls, {}, (fn, args) => (fn === "memory_graph_kernel_execute"
      ? { ok: true, duplicate: false, memory_id: args.p_command.memory_id, event_id: "e2", event_type: "memory.split",
          result: { source_memory_id: args.p_command.memory_id, new_memory_id: NEW, moved_item_ids: args.p_command.payload.item_ids }, contract_version: 1 }
      : null));
    try {
      const r = await call(app.base, "POST", `/api/memories/${M1}/split`, "owner-tok", { itemIds: [ITEM], title: "Second half" }, "split-1");
      assert.equal(r.status, 201);
      assert.deepEqual([r.body.sourceId, r.body.newMemoryId, r.body.movedItemIds], [M1, NEW, [ITEM]]);
      const k = kernelCalls(calls)[0]!;
      assert.deepEqual([k.args.p_command.type, k.args.p_command.memory_id, k.args.p_command.payload], ["SPLIT_MEMORY", M1, { item_ids: [ITEM], title: "Second half" }]);
      assert.ok(calls.some((c) => c.table === "memory_derivative_registry"), "the source's derivatives were re-derived");
    } finally { await app.close(); }
  });

  it("H213/H214: a merge of a Memory kept from a candidate counts toward candidate_merge_rate; an unreadable origin nulls the rates", async () => {
    const store = seed(); flags(store, MEMORY_MERGE_SPLIT_FLAG);
    store.memory_evidence = [{ user_id: OWNER, source_table: "memories", source_id: M2 }];
    countCandidateDecision("confirmed"); countCandidateDecision("confirmed");
    let calls: Call[] = [];
    let app = await startApp(store, calls, {}, okMerge);
    try {
      await call(app.base, "POST", "/api/memories/merge", "owner-tok", { survivorId: M1, absorbedIds: [M2] });
      assert.equal(readMemoryKernelMetrics().candidate_merge_rate, 0.5);
    } finally { await app.close(); }
    calls = [];
    app = await startApp(seed(), calls, { failReads: new Set(["memory_evidence"]) }, okMerge);
    try {
      const s = seed(); flags(s, MEMORY_MERGE_SPLIT_FLAG);
      await app.close();
      app = await startApp(s, calls, { failReads: new Set(["memory_evidence"]) }, okMerge);
      await call(app.base, "POST", "/api/memories/merge", "owner-tok", { survivorId: M1, absorbedIds: [M2] });
      assert.equal(readMemoryKernelMetrics().candidate_merge_rate, null);
      assert.equal(readMemoryKernelMetrics().counts.graphCommandsUnattributed, 1);
    } finally { await app.close(); }
  });
});
