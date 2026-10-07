/**
 * census-discovery DV-51 (§56.6, §67) — revocation reaches the graph.
 *
 * THE DEFECT. `buildGraphFromSources` persists with `upsert` and nothing else,
 * and the only thing that ever removed an edge was `reconcileExperienceNodes`
 * (a Memory's experience node and the edges touching it). So a presence stamp
 * revoked on Monday kept its `visited` edge, its `active_in` edge and the
 * city-rhythm observations it contributed — at their old weights — through
 * every rebuild after, and every reader of the graph (the world model, the
 * city-confidence index) went on counting it. §56.6 reproduced that for one
 * stamp; this file pins it for EVERY source the rebuild reads.
 *
 * THE ORACLE. One criterion for every edge kind: after a source is revoked or
 * deleted and the graph is rebuilt, the stored graph must equal a graph built
 * FROM SCRATCH over the post-revocation sources — the same edge identities at
 * the same weights, the same source-anchored nodes, the same world-model and
 * confidence cities. That is what "rebuildable" means (`10` §10, DV-72), and it
 * is the one reading under which a revoked fact cannot survive: a scratch build
 * never saw it. Each case also names the specific edges it expects gone, so a
 * red run says what leaked.
 *
 * WHAT THE RECONCILE MAY NOT DO. It may not retire an edge whose source exists
 * but was not READ by the capped build (§56.6's objection to "retire what the
 * build did not write"), may not act on a failed or truncated read, and may not
 * write a surviving edge's weight. Those are the guard cases (H–P).
 *
 * Run: node --import tsx/esm --test src/test/compassGraphRevocation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as engine from "../compass/CompassGraphEngine.js";

/* ── A store-backed PostgREST fake: honours range/limit/order, fails on demand ── */

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

interface FakeOpts {
  /** Tables whose SELECT resolves `{ data: null, error }`. */
  failSelect?: Set<string>;
  /** Tables whose DELETE resolves `{ data: null, error }` and removes nothing. */
  failDelete?: Set<string>;
  /** Tables whose backend IGNORES `.range()` — every page is the whole result. */
  ignoreRange?: Set<string>;
}

interface Result { data: Row[] | Row | null; error: { message: string } | null }

let seq = 0;

class Q implements PromiseLike<Result> {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "delete" | "upsert" = "select";
  private payload: Row[] = [];
  private conflict: string[] = ["id"];
  private orderKey: string | null = null;
  private asc = true;
  private lim: number | null = null;
  private rng: [number, number] | null = null;
  private one = false;

  constructor(private readonly store: Store, private readonly table: string, private readonly opts: FakeOpts, private readonly log: string[]) {}

  /** The select list, honoured for `memories` only: §47's rung exists in a row only when the read NAMES it, as in PostgREST. */
  private cols: string[] | null = null;
  select(cols?: string, _o?: unknown): Q { if (this.table === "memories" && typeof cols === "string") this.cols = cols.split(",").map((c) => c.trim()); return this; }
  eq(k: string, v: unknown): Q { this.filters.push((r) => r[k] === v); return this; }
  neq(k: string, v: unknown): Q { this.filters.push((r) => r[k] !== v); return this; }
  in(k: string, vs: readonly unknown[]): Q { this.filters.push((r) => vs.includes(r[k])); return this; }
  like(k: string, pattern: string): Q {
    const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
    this.filters.push((r) => re.test(String(r[k] ?? "")));
    return this;
  }
  gt(k: string, v: unknown): Q { this.filters.push((r) => String(r[k] ?? "") > String(v)); return this; }
  gte(k: string, v: unknown): Q { this.filters.push((r) => String(r[k] ?? "") >= String(v)); return this; }
  order(k: string, o?: { ascending?: boolean }): Q { this.orderKey = k; this.asc = o?.ascending !== false; return this; }
  limit(n: number): Q { this.lim = n; return this; }
  range(a: number, z: number): Q { this.rng = [a, z]; return this; }
  maybeSingle(): Q { this.one = true; return this; }
  single(): Q { this.one = true; return this; }
  delete(): Q { this.op = "delete"; return this; }
  upsert(p: Row | Row[], o?: { onConflict?: string }): Q {
    this.op = "upsert";
    this.payload = Array.isArray(p) ? p : [p];
    this.conflict = (o?.onConflict ?? "id").split(",");
    return this;
  }

  private rows(): Row[] { return (this.store[this.table] ??= []); }

  private run(): Result {
    const t = this.table;
    if (this.op === "delete") {
      this.log.push(`delete:${t}`);
      if (this.opts.failDelete?.has(t)) return { data: null, error: { message: `${t} delete refused` } };
      const doomed = this.rows().filter((r) => this.filters.every((f) => f(r)));
      this.store[t] = this.rows().filter((r) => !doomed.includes(r));
      return { data: null, error: null };
    }
    if (this.op === "upsert") {
      this.log.push(`upsert:${t}`);
      const key = (r: Row) => this.conflict.map((k) => String(r[k])).join("\u0000");
      const index = new Map(this.rows().map((r) => [key(r), r] as const));
      for (const r of this.payload) {
        const hit = index.get(key(r));
        if (hit) Object.assign(hit, r);
        else { const row = { id: `${t}-${++seq}`, ...r }; this.rows().push(row); index.set(key(row), row); }
      }
      return { data: null, error: null };
    }
    this.log.push(`select:${t}`);
    if (this.opts.failSelect?.has(t)) return { data: null, error: { message: `${t} unreadable` } };
    let out = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.orderKey) {
      const k = this.orderKey;
      out = [...out].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : String(a[k]) > String(b[k]) ? 1 : 0) * (this.asc ? 1 : -1));
    }
    if (this.rng && !this.opts.ignoreRange?.has(t)) out = out.slice(this.rng[0], this.rng[1] + 1);
    if (this.lim !== null) out = out.slice(0, this.lim);
    out = out.map((r) => ({ ...r }));
    if (this.cols) { const cols = this.cols; out = out.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]]))); }
    if (this.one) return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }

  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}

function makeDb(store: Store, opts: FakeOpts = {}): { db: SupabaseClient; log: string[] } {
  const log: string[] = [];
  const client = { from: (t: string) => new Q(store, t, opts, log) };
  return { db: client as unknown as SupabaseClient, log };
}

/* ── The world: one row of every source kind, plus a control beside each ── */

const A = "user-a";
const B = "user-b";
const C = "user-c";
const PRESENCE = { evidences_presence: true };

function sources(): Store {
  return {
    user_stamps: [
      // A's only presence stamp, in July: its slice and its month are A's alone.
      { id: "s-a1", user_id: A, city: "Cebu", country: "PH", earned_at: "2026-07-03T12:00:00Z", is_revoked: false, lat: null, lng: null, stamp_definitions: PRESENCE },
      // The control: B was in Cebu too, in March.
      { id: "s-b1", user_id: B, city: "Cebu", country: "PH", earned_at: "2026-03-02T01:00:00Z", is_revoked: false, lat: null, lng: null, stamp_definitions: PRESENCE },
    ],
    trips: [
      { id: "t-1", owner_id: C, destination_city: "Bohol", start_date: "2026-05-01", end_date: "2026-05-05", destination_lat: null, destination_lng: null },
      { id: "t-2", owner_id: C, destination_city: "Bohol", start_date: "2026-06-01", end_date: "2026-06-04", destination_lat: null, destination_lng: null },
      { id: "t-3", owner_id: B, destination_city: "Davao", start_date: "2026-04-01", end_date: "2026-04-03", destination_lat: null, destination_lng: null },
    ],
    events: [
      { id: "ev-1", city: "Iloilo", category: "Festival", starts_at: "2026-01-24T02:00:00Z", location_lat: null, location_lng: null, circle_id: "ci-1" },
      { id: "ev-2", city: "Iloilo", category: "Music", starts_at: "2026-02-10T11:00:00Z", location_lat: null, location_lng: null, circle_id: null },
    ],
    compass_outcome_events: [
      { id: "oe-1", user_id: A, item_id: "ev-2", item_type: "event", stage: "saved", occurred_at: "2026-02-01T00:00:00Z" },
      { id: "oe-2", user_id: B, item_id: "ev-2", item_type: "event", stage: "saved", occurred_at: "2026-02-02T00:00:00Z" },
    ],
    rank_events: [
      { id: "re-1", user_id: A, item_id: "place-1", item_kind: "place", outcome: "click", served_at: "2026-02-01T00:00:00Z" },
      { id: "re-2", user_id: B, item_id: "place-1", item_kind: "place", outcome: "click", served_at: "2026-02-02T00:00:00Z" },
      { id: "re-3", user_id: A, item_id: "place-2", item_kind: "place", outcome: "impression", served_at: "2026-02-03T00:00:00Z" },
    ],
    circles: [
      { id: "ci-1", owner_id: C, city: "Iloilo", visibility: "public", created_at: "2026-01-01T00:00:00Z" },
      { id: "ci-2", owner_id: B, city: "Dumaguete", visibility: "public", created_at: "2026-01-02T00:00:00Z" },
    ],
    memories: [
      // C's only account of Siargao — the city has no other support.
      { id: "m-1", owner_id: C, place_id: "place-9", trip_id: null, event_id: null, location_city: "Siargao", location_country: "PH", location_lat: null, location_lng: null, starts_at: "2026-08-15T03:00:00Z", created_at: "2026-08-15T03:00:00Z", state: "published", visibility: "public" },
      { id: "m-2", owner_id: B, place_id: "place-1", trip_id: null, event_id: null, location_city: "Cebu", location_country: "PH", location_lat: null, location_lng: null, starts_at: "2026-03-09T06:00:00Z", created_at: "2026-03-09T06:00:00Z", state: "published", visibility: "public" },
    ],
  };
}

const SOURCE_TABLES = ["user_stamps", "trips", "events", "compass_outcome_events", "rank_events", "circles", "memories"];

function edgeKey(e: Row): string {
  return `${e.src_type}|${e.src_key}|${e.dst_type}|${e.dst_key}|${e.edge_type}`;
}
/** Identity → the columns a rebuild writes (weight and its evidence), updated_at excluded. */
function edgeMap(store: Store): Map<string, string> {
  return new Map((store.compass_graph_edges ?? []).map((e) => [edgeKey(e), JSON.stringify([e.weight, e.observed_count, e.first_seen, e.last_seen])]));
}
function nodeSet(store: Store, types: readonly string[]): string[] {
  return (store.compass_graph_nodes ?? []).filter((n) => types.includes(String(n.node_type))).map((n) => `${n.node_type}|${n.node_key}`).sort();
}
function cities(store: Store, table: string): string[] {
  return (store[table] ?? []).map((r) => String(r.city)).sort();
}
function hasEdge(store: Store, pred: (e: Row) => boolean): boolean {
  return (store.compass_graph_edges ?? []).some(pred);
}

/** A graph built FROM SCRATCH over the given sources — the oracle. */
async function scratch(src: Store): Promise<Store> {
  const fresh: Store = {};
  // feature_flags too: §10's precision gate decides what a Memory contributes (census-compass §47).
  for (const t of [...SOURCE_TABLES, "feature_flags"]) fresh[t] = (src[t] ?? []).map((r) => ({ ...r }));
  await engine.rebuildIntelligenceGraph(makeDb(fresh).db);
  return fresh;
}

/** Built once on the full world, then `revoke` applied, then rebuilt. */
async function revokeAndRebuild(revoke: (s: Store) => void, opts: FakeOpts = {}): Promise<{ store: Store; before: Store; report: engine.GraphRebuildReport }> {
  const store = sources();
  await engine.rebuildIntelligenceGraph(makeDb(store).db);
  const before: Store = JSON.parse(JSON.stringify(store));
  revoke(store);
  const report = await engine.rebuildIntelligenceGraph(makeDb(store, opts).db);
  return { store, before, report };
}

/** The rebuildable-projection criterion: stored graph == scratch graph over the same sources. */
async function assertEqualsScratch(store: Store): Promise<void> {
  const fresh = await scratch(store);
  const got = edgeMap(store);
  const want = edgeMap(fresh);
  const leaked = [...got.keys()].filter((k) => !want.has(k)).sort();
  const missing = [...want.keys()].filter((k) => !got.has(k)).sort();
  assert.deepEqual(leaked, [], "edges the post-revocation sources no longer support survived the rebuild");
  assert.deepEqual(missing, [], "a supported edge was retired");
  for (const [k, v] of want) assert.equal(got.get(k), v, `surviving edge ${k} is not at the weight a scratch build gives it`);
  const kinds = ["trip", "event", "circle", "experience"] as const;
  assert.deepEqual(nodeSet(store, kinds), nodeSet(fresh, kinds), "source-anchored nodes differ from a scratch build");
  assert.deepEqual(cities(store, "compass_city_models"), cities(fresh, "compass_city_models"), "world-model cities differ from a scratch build");
  assert.deepEqual(cities(store, "compass_city_confidence"), cities(fresh, "compass_city_confidence"), "confidence cities differ from a scratch build");
}

function supportReport(r: engine.GraphRebuildReport): engine.EdgeSupportReport {
  const s = r.edgeSupport;
  assert.ok(s, "the rebuild report carries no edge-support reconciliation");
  return s;
}

/* ── A–G: every revocable source kind, revoked, then rebuilt ─────────────── */

describe("DV-51 — a revoked or deleted source's edges do not survive a rebuild", () => {
  it("A1 — §56.6's reproduction: a REVOKED presence stamp's visited, active_in and rhythm edges are retired", async () => {
    const { store, before, report } = await revokeAndRebuild((s) => {
      const row = s.user_stamps!.find((r) => r.id === "s-a1")!;
      row.is_revoked = true;
    });
    assert.ok(hasEdge(before, (e) => e.src_key === A && e.edge_type === "visited"), "fixture: A's visited edge was built");
    assert.ok(!hasEdge(store, (e) => e.src_key === A && e.edge_type === "visited"), "A's visited edge survived the revocation");
    assert.ok(!hasEdge(store, (e) => e.src_key === A && e.edge_type === "active_in"), "A's active_in edge survived the revocation");
    assert.ok(hasEdge(store, (e) => e.src_key === B && e.edge_type === "visited"), "the control's visited edge was retired");
    // What a reader serves: the city-confidence index counts visitors off `visited`.
    const conf = (store.compass_city_confidence ?? []).find((r) => r.city === "cebu");
    assert.equal((conf?.signals as Row | undefined)?.visitors, 1, "Cebu's confidence still counts the revoked visitor");
    assert.ok(supportReport(report).retired > 0);
    await assertEqualsScratch(store);
  });

  it("A2 — a HARD-DELETED stamp (account-deletion cascade) is retired the same way", async () => {
    const { store } = await revokeAndRebuild((s) => { s.user_stamps = s.user_stamps!.filter((r) => r.id !== "s-a1"); });
    assert.ok(!hasEdge(store, (e) => e.src_key === A && (e.edge_type === "visited" || e.edge_type === "active_in")));
    await assertEqualsScratch(store);
  });

  it("B — a Memory narrowed from public: its active_in and rhythm edges go too, and its city's model and confidence rows", async () => {
    const { store, before } = await revokeAndRebuild((s) => {
      s.memories!.find((r) => r.id === "m-1")!.visibility = "friends_only";
    });
    assert.ok(cities(before, "compass_city_models").includes("siargao"), "fixture: Siargao was modelled");
    assert.ok(!hasEdge(store, (e) => e.src_key === C && e.edge_type === "active_in" && String(e.dst_key).startsWith("siargao|")), "the Memory's active_in edge survived");
    assert.ok(!hasEdge(store, (e) => e.src_type === "city" && e.src_key === "siargao"), "Siargao's rhythm edges survived its only Memory");
    assert.ok(!cities(store, "compass_city_models").includes("siargao"), "Siargao's world model is still served");
    assert.ok(!cities(store, "compass_city_confidence").includes("siargao"), "Siargao's confidence row is still served");
    await assertEqualsScratch(store);
  });

  it("C1 — a deleted trip: took_trip, destination and the trip node are retired", async () => {
    const { store } = await revokeAndRebuild((s) => { s.trips = s.trips!.filter((r) => r.id !== "t-3"); });
    assert.ok(!hasEdge(store, (e) => e.dst_key === "t-3" || e.src_key === "t-3"), "the deleted trip's edges survived");
    assert.ok(!nodeSet(store, ["trip"]).includes("trip|t-3"), "the deleted trip's node survived");
    await assertEqualsScratch(store);
  });

  it("C2 — deleting the second trip to a city retires returned_to, and only it", async () => {
    const { store, before } = await revokeAndRebuild((s) => { s.trips = s.trips!.filter((r) => r.id !== "t-2"); });
    assert.ok(hasEdge(before, (e) => e.src_key === C && e.edge_type === "returned_to"), "fixture: returned_to was built");
    assert.ok(!hasEdge(store, (e) => e.src_key === C && e.edge_type === "returned_to"), "returned_to survived the trip that made it");
    assert.ok(hasEdge(store, (e) => e.dst_key === "t-1" && e.edge_type === "took_trip"), "the surviving trip was retired");
    await assertEqualsScratch(store);
  });

  it("D — a deleted event: in_city, hosted_by, has_vibe, its node and its rhythm/season/event-window edges", async () => {
    const { store } = await revokeAndRebuild((s) => { s.events = s.events!.filter((r) => r.id !== "ev-1"); });
    assert.ok(!hasEdge(store, (e) => e.src_key === "ev-1"), "the deleted event's edges survived");
    assert.ok(!hasEdge(store, (e) => String(e.edge_type).endsWith(":festival")), "the deleted event's rhythm observations survived");
    assert.ok(!nodeSet(store, ["event"]).includes("event|ev-1"), "the deleted event's node survived (the confidence index counts event nodes)");
    const conf = (store.compass_city_confidence ?? []).find((r) => r.city === "iloilo");
    assert.equal((conf?.signals as Row | undefined)?.events, 1, "Iloilo's confidence still counts the deleted event");
    await assertEqualsScratch(store);
  });

  it("E — a deleted outcome event's outcome edge is retired", async () => {
    const { store } = await revokeAndRebuild((s) => { s.compass_outcome_events = s.compass_outcome_events!.filter((r) => r.id !== "oe-1"); });
    assert.ok(!hasEdge(store, (e) => e.src_key === A && String(e.edge_type).startsWith("outcome:")));
    assert.ok(hasEdge(store, (e) => e.src_key === B && String(e.edge_type).startsWith("outcome:")), "the control's outcome edge was retired");
    await assertEqualsScratch(store);
  });

  it("F — a deleted rank event's behavior edge is retired", async () => {
    const { store } = await revokeAndRebuild((s) => { s.rank_events = s.rank_events!.filter((r) => r.id !== "re-1"); });
    assert.ok(!hasEdge(store, (e) => e.src_key === A && String(e.edge_type).startsWith("behavior:")));
    assert.ok(hasEdge(store, (e) => e.src_key === B && e.edge_type === "behavior:click"), "the control's behavior edge was retired");
    await assertEqualsScratch(store);
  });

  it("G — a deleted circle: owns_circle, its in_city and its node are retired", async () => {
    const { store } = await revokeAndRebuild((s) => { s.circles = s.circles!.filter((r) => r.id !== "ci-2"); });
    assert.ok(!hasEdge(store, (e) => e.src_key === "ci-2" || e.dst_key === "ci-2"), "the deleted circle's edges survived");
    assert.ok(!nodeSet(store, ["circle"]).includes("circle|ci-2"), "the deleted circle's node survived");
    await assertEqualsScratch(store);
  });

  it("every edge the builder writes belongs to a reconciled family (the edge-kind table is exhaustive)", async () => {
    const store = sources();
    await engine.rebuildIntelligenceGraph(makeDb(store).db);
    const kinds = new Set<string>();
    for (const e of store.compass_graph_edges ?? []) {
      const fam = engine.classifyGraphEdge({ src_type: String(e.src_type), dst_type: String(e.dst_type), edge_type: String(e.edge_type) });
      assert.ok(fam, `edge ${edgeKey(e)} belongs to no reconciled family — a revoked source would leave it behind`);
      kinds.add(fam);
    }
    // Every family the table names is exercised by this fixture.
    assert.deepEqual([...kinds].sort(), [...engine.GRAPH_EDGE_FAMILIES].sort());
  });
});

/* ── H–N: what the reconcile must NOT do ──────────────────────────────────── */

describe("DV-51 guards — bounded, positive, fail-visible, weight-neutral, idempotent", () => {
  it("H — an edge whose source exists but lies beyond the build's capped read is KEPT", async () => {
    const store = sources();
    // 5000 non-presence stamps fill the build's read; Z's presence stamp is row 5001.
    const filler: Row[] = [];
    for (let i = 0; i < 5000; i++) {
      filler.push({ id: `s-f${String(i).padStart(5, "0")}`, user_id: `filler-${i}`, city: "Cebu", country: "PH", earned_at: "2026-03-02T01:00:00Z", is_revoked: false, lat: null, lng: null, stamp_definitions: { evidences_presence: false } });
    }
    store.user_stamps = [...filler, { id: "s-z1", user_id: "user-z", city: "Bohol", country: "PH", earned_at: "2026-05-02T01:00:00Z", is_revoked: false, lat: null, lng: null, stamp_definitions: PRESENCE }, ...store.user_stamps!];
    // An earlier build, when the table was small, wrote Z's edge.
    store.compass_graph_edges = [{ id: "pre-z", src_type: "person", src_key: "user-z", dst_type: "city", dst_key: "bohol", edge_type: "visited", weight: 1, observed_count: 1, first_seen: "2026-05-02T01:00:00Z", last_seen: "2026-05-02T01:00:00Z", attrs: {} }];
    const report = await engine.rebuildIntelligenceGraph(makeDb(store).db);
    assert.ok(hasEdge(store, (e) => e.src_key === "user-z" && e.edge_type === "visited"), "an edge whose source the build did not read was retired as if revoked");
    assert.equal(supportReport(report).unresolved, false);
  });

  it("I — an UNREADABLE source retires nothing it supports, says so, and other kinds are still reconciled", async () => {
    const { store, report } = await revokeAndRebuild((s) => {
      s.user_stamps!.find((r) => r.id === "s-a1")!.is_revoked = true;
      s.trips = s.trips!.filter((r) => r.id !== "t-3");
    }, { failSelect: new Set(["user_stamps"]) });
    const sup = supportReport(report);
    assert.equal(sup.unresolved, true, "a failed source read was reported as a clean reconcile");
    assert.ok(sup.undecided > 0, "the edges the failed read left unjudged are not counted");
    assert.ok(sup.undecidedFamilies.includes("stamp_visit") && sup.undecidedFamilies.includes("city_rhythm"));
    // Nothing the unreadable table supports was retired — not A's, not B's.
    assert.ok(hasEdge(store, (e) => e.src_key === A && e.edge_type === "visited"), "a failed read was taken as a revocation");
    assert.ok(hasEdge(store, (e) => e.src_key === B && e.edge_type === "visited"), "a failed read emptied the family");
    assert.ok(hasEdge(store, (e) => e.src_type === "city" && e.edge_type === "active_during:exploring"), "a failed read emptied the rhythm");
    // The trip — a readable source — was still reconciled.
    assert.ok(!hasEdge(store, (e) => e.dst_key === "t-3" || e.src_key === "t-3"), "one failed source held every other revocation hostage");
  });

  it("J — an unreadable EDGE table: nothing retired, examined 0, unresolved", async () => {
    const store = sources();
    await engine.rebuildIntelligenceGraph(makeDb(store).db);
    store.trips = store.trips!.filter((r) => r.id !== "t-3");
    const n = store.compass_graph_edges!.length;
    const { db, log } = makeDb(store, { failSelect: new Set(["compass_graph_edges"]) });
    const r = await engine.reconcileEdgeSupport(db);
    assert.equal(r.unresolved, true);
    assert.equal(r.examined, 0);
    assert.equal(r.retired, 0);
    assert.equal(store.compass_graph_edges!.length, n);
    assert.ok(!log.includes("delete:compass_graph_edges"), "an unreadable edge table led to a delete");
  });

  it("K — a refused DELETE is counted, reported, and converges on the next run", async () => {
    const store = sources();
    await engine.rebuildIntelligenceGraph(makeDb(store).db);
    store.trips = store.trips!.filter((r) => r.id !== "t-3");
    const refused = await engine.reconcileEdgeSupport(makeDb(store, { failDelete: new Set(["compass_graph_edges", "compass_graph_nodes"]) }).db);
    assert.ok(refused.deleteFailed > 0, "a refused delete was not counted");
    assert.equal(refused.unresolved, true);
    assert.equal(refused.retired, 0, "a refused delete was reported as retired");
    assert.ok(hasEdge(store, (e) => e.dst_key === "t-3"));
    const retry = await engine.reconcileEdgeSupport(makeDb(store).db);
    assert.equal(retry.unresolved, false);
    assert.ok(retry.retired > 0);
    assert.ok(!hasEdge(store, (e) => e.dst_key === "t-3" || e.src_key === "t-3"));
  });

  it("L — the reconcile never writes a surviving edge: weight, count and dates are untouched", async () => {
    const store = sources();
    await engine.rebuildIntelligenceGraph(makeDb(store).db);
    const bVisited = store.compass_graph_edges!.find((e) => e.src_key === B && e.edge_type === "visited")!;
    Object.assign(bVisited, { weight: 7, observed_count: 7, first_seen: "2020-01-01T00:00:00Z" });
    store.trips = store.trips!.filter((r) => r.id !== "t-3");
    const snapshot = JSON.stringify(store.compass_graph_edges!.filter((e) => e.src_key !== "t-3" && e.dst_key !== "t-3"));
    const { db, log } = makeDb(store);
    const r = await engine.reconcileEdgeSupport(db);
    assert.ok(r.retired > 0);
    assert.equal(JSON.stringify(store.compass_graph_edges), snapshot, "a surviving edge was rewritten");
    assert.ok(!log.some((l) => l.startsWith("upsert:")), "the reconcile wrote rows instead of only retiring them");
  });

  it("M — idempotent: a second rebuild over the same sources retires nothing and changes nothing", async () => {
    const { store } = await revokeAndRebuild((s) => { s.user_stamps!.find((r) => r.id === "s-a1")!.is_revoked = true; });
    const edgesBefore = edgeMap(store);
    const again = await engine.rebuildIntelligenceGraph(makeDb(store).db);
    assert.equal(supportReport(again).retired, 0);
    assert.equal(supportReport(again).nodesRetired, 0);
    assert.deepEqual(edgeMap(store), edgesBefore);
  });

  it("N — a backend that ignores paging is reported TRUNCATED and decides nothing it could not finish reading", async () => {
    const { store, report } = await revokeAndRebuild((s) => {
      // 600 more rows for A: every page a paging-blind backend returns is full.
      for (let i = 0; i < 600; i++) {
        s.user_stamps!.push({ id: `s-ax${String(i).padStart(4, "0")}`, user_id: A, city: "Cebu", country: "PH", earned_at: "2026-03-02T01:00:00Z", is_revoked: false, lat: null, lng: null, stamp_definitions: { evidences_presence: false } });
      }
      s.user_stamps!.find((r) => r.id === "s-a1")!.is_revoked = true;
    }, { ignoreRange: new Set(["user_stamps"]) });
    const sup = supportReport(report);
    assert.equal(sup.unresolved, true, "a read that never ended was treated as complete");
    assert.ok(sup.undecidedFamilies.includes("stamp_visit"));
    assert.ok(hasEdge(store, (e) => e.src_key === A && e.edge_type === "visited"), "a truncated read was taken as a revocation");
  });

  it("O — a source row the build CHOKES on (its fail-soft catch swallows the throw) decides nothing, rather than reading as absent", async () => {
    // The build is fail-soft per source: one throwing row ends that source's
    // loop and the rows after it contribute nothing. Replayed for support, the
    // same swallow would make every later row look revoked. The replay notices
    // that the build stopped iterating and refuses to judge.
    const poison = { get evidences_presence(): boolean { throw new Error("poisoned row"); } };
    const { store, report } = await revokeAndRebuild((s) => {
      s.user_stamps!.unshift({ id: "s-0000", user_id: A, city: "Cebu", country: "PH", earned_at: "2026-03-02T01:00:00Z", is_revoked: false, lat: null, lng: null, stamp_definitions: poison });
    });
    const sup = supportReport(report);
    assert.equal(sup.unresolved, true);
    assert.ok(sup.undecidedFamilies.includes("stamp_visit") && sup.undecidedFamilies.includes("city_rhythm"));
    assert.ok(hasEdge(store, (e) => e.src_key === A && e.edge_type === "visited"), "a swallowed throw was taken as a revocation");
    assert.ok(hasEdge(store, (e) => e.src_key === B && e.edge_type === "visited"), "a swallowed throw emptied the family");
  });

  it("P — the reconcile reads each source with the build's own table, select list and predicates", () => {
    const src = readFileSync(new URL("../compass/CompassGraphEngine.ts", import.meta.url), "utf8");
    const reconcileAt = src.indexOf("const supportReads = {");
    assert.ok(reconcileAt > 0, "the reconcile's source reads are not where this test looks");
    const buildBody = src.slice(src.indexOf("export async function buildGraphFromSources"), src.indexOf("// ── Destination World Model"));
    for (const table of engine.GRAPH_SOURCE_TABLES) {
      const re = new RegExp(`\\.from\\("${table}"\\)\\s*\\.select\\("([^"]*)"\\)((?:\\s*\\.(?:eq|neq)\\([^)]*\\))*)`, "g");
      const hits = [...src.matchAll(re)];
      if (table === "circles") {
        // One literal site, shared: `circles` is a writerless dead lane whose reader count is ratcheted.
        assert.equal(hits.length, 1, "circles: the shared read was duplicated");
        assert.match(buildBody, /await circleSourceRows\(db\)\.limit\(BUILD_LIMIT\)/, "circles: the build no longer reads through the shared read");
        assert.match(src, /circles: \(db: SupabaseClient\) => circleSourceRows\(db\),/, "circles: the reconcile no longer reads through the shared read");
        continue;
      }
      const build = hits.find((m) => (m.index ?? 0) < reconcileAt);
      const mine = hits.find((m) => (m.index ?? 0) > reconcileAt);
      assert.ok(build && mine, `${table}: a read is missing on one side`);
      assert.equal(mine[1], build[1], `${table}: the reconcile selects different columns from the build`);
      assert.equal(mine[2].replace(/\s+/g, ""), build[2].replace(/\s+/g, ""), `${table}: the reconcile filters differently from the build`);
    }
    assert.deepEqual([...engine.GRAPH_SOURCE_TABLES], ["user_stamps", "trips", "events", "compass_outcome_events", "rank_events", "circles", "memories"]);
  });

  it("the first build over an empty graph retires nothing", async () => {
    const store = sources();
    const r = await engine.rebuildIntelligenceGraph(makeDb(store).db);
    assert.equal(supportReport(r).retired, 0);
    assert.equal(supportReport(r).unresolved, false);
    assert.ok(supportReport(r).examined > 0);
  });
});

/* ── §47: the owner's §10 location-precision rung on the graph's Memory reads ── */
//
// Every node and edge the build writes is read by every user, so each Memory is
// published there to non-owners: its city/country only as far as its owner's
// rung allows, a place or event (a venue) only at `exact`/`venue`, coordinates
// never in a node. An unreadable gate or label contributes no place at all — and
// in the reconcile it decides nothing, rather than retiring every Memory edge.
describe("§47 — a Memory reaches the world graph only as far as its owner's location-precision rung allows", () => {
  const GATE = "memory_location_precision_enabled";
  const world = (rung: string | null, gate: boolean | null = true): Store => {
    const s = sources();
    if (gate !== null) s.feature_flags = [{ flag: GATE, enabled: gate }];
    const m1 = s.memories!.find((r) => r.id === "m-1")!;
    m1.location_lat = 9.8481; m1.location_lng = 126.0458; m1.trip_id = "t-3";
    if (rung !== null) m1.location_precision = rung;
    for (const r of s.memories!) if (r.id !== "m-1") r.location_precision = "exact";
    return s;
  };
  const m1Edges = (st: Store) => (st.compass_graph_edges ?? [])
    .filter((e) => (e.src_type === "experience" && e.src_key === "m-1") || (e.src_key === C && e.edge_type === "active_in"))
    .map((e) => `${e.dst_type}:${e.edge_type}`).sort();
  const m1Node = (st: Store) => (st.compass_graph_nodes ?? []).find((n) => n.node_type === "experience" && n.node_key === "m-1");

  it("control: gate OFF — m-1 keeps its place, trip, city and slice edges", async () => {
    const st = await scratch(world("hidden", false));
    assert.deepEqual(m1Edges(st), ["city:in_city", "place:at_place", "time_slice:active_in", "trip:during_trip"]);
  });

  it("gate ON, rung `hidden`: no place, trip, city or slice — the person may still have the public Memory, with no country", async () => {
    const st = await scratch(world("hidden"));
    assert.deepEqual(m1Edges(st), []);
    assert.equal((m1Node(st)?.attrs as Row).country, null);
    assert.equal((m1Node(st)?.attrs as Row).has_place, false);
    assert.ok(hasEdge(st, (e) => e.src_key === C && e.edge_type === "experienced" && e.dst_key === "m-1"));
    // The control Memory at `exact` is untouched.
    assert.ok(hasEdge(st, (e) => e.src_key === "m-2" && e.edge_type === "at_place"));
    assert.ok(hasEdge(st, (e) => e.src_key === "m-2" && e.edge_type === "in_city"));
  });

  it("rung `country`: the country only", async () => {
    const st = await scratch(world("country"));
    assert.deepEqual(m1Edges(st), []);
    assert.equal((m1Node(st)?.attrs as Row).country, "PH");
  });

  it("rung `city`: the city, its slice and the trip — but no venue", async () => {
    const st = await scratch(world("city"));
    assert.deepEqual(m1Edges(st), ["city:in_city", "time_slice:active_in", "trip:during_trip"]);
  });

  it("rung `venue`: the place too", async () => {
    const st = await scratch(world("venue"));
    assert.deepEqual(m1Edges(st), ["city:in_city", "place:at_place", "time_slice:active_in", "trip:during_trip"]);
  });

  it("REFUSAL: a null or off-ladder label, or no label at all with the gate on, is `hidden`", async () => {
    for (const rung of [null, "EXACT"]) {
      const w = world(rung);
      if (rung === null) delete w.memories!.find((r) => r.id === "m-1")!.location_precision;
      assert.deepEqual(m1Edges(await scratch(w)), [], String(rung));
    }
  });

  it("no node carries a Memory's coordinates, at any rung", async () => {
    for (const rung of ["exact", "city", "hidden"]) {
      const st = await scratch(world(rung));
      const nodes = JSON.stringify(st.compass_graph_nodes ?? []);
      assert.doesNotMatch(nodes, /9\.848|126\.04/, rung);
    }
  });

  it("REFUSAL: an UNREADABLE gate writes no Memory's place — and the reconcile decides nothing about Memory edges rather than retiring them", async () => {
    const built = sources();
    await engine.rebuildIntelligenceGraph(makeDb(built).db); // gate absent (off): the place edges exist
    assert.ok(hasEdge(built, (e) => e.src_key === "m-1" && e.edge_type === "in_city"), "fixture");
    const report = await engine.rebuildIntelligenceGraph(makeDb(built, { failSelect: new Set(["feature_flags"]) }).db);
    assert.ok(hasEdge(built, (e) => e.src_key === "m-1" && e.edge_type === "in_city"), "a failed flag read retired a Memory edge");
    assert.ok(supportReport(report).undecidedFamilies.includes("experience"), JSON.stringify(supportReport(report)));
    // A scratch build under an unreadable gate writes none.
    const fresh = sources();
    await engine.rebuildIntelligenceGraph(makeDb(fresh, { failSelect: new Set(["feature_flags"]) }).db);
    assert.ok(!hasEdge(fresh, (e) => e.src_type === "experience" && ["in_city", "at_place", "during_trip", "at_event"].includes(String(e.edge_type))));
  });

  it("REVOCATION: an owner who moves to `hidden` has the Memory's place, city and slice edges retired on the next rebuild; the other Memory's stay", async () => {
    const store = world("exact");
    await engine.rebuildIntelligenceGraph(makeDb(store).db);
    assert.deepEqual(m1Edges(store), ["city:in_city", "place:at_place", "time_slice:active_in", "trip:during_trip"], "fixture");
    store.memories!.find((r) => r.id === "m-1")!.location_precision = "hidden";
    const report = await engine.rebuildIntelligenceGraph(makeDb(store).db);
    assert.deepEqual(m1Edges(store), [], "the hidden Memory's place survived the rebuild");
    assert.ok(hasEdge(store, (e) => e.src_key === "m-2" && e.edge_type === "at_place"), "the control Memory's place was retired");
    assert.ok(supportReport(report).retired > 0);
    await assertEqualsScratch(store);
  });
});
