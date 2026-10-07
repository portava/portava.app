/**
 * census-discovery §81 (lane W10-S2) — DV-51: graded decay in the rebuild.
 * Register: D-W10S2-10 (§56.9 Q6).
 *
 * node:test + node:assert. §67's store-backed PostgREST fake and §67's world
 * (copied, not imported: importing a test file runs its suites), with `update`
 * and `feature_flags` added. `Date` is frozen per case.
 *
 * WHAT IS PINNED
 *   D0  flag OFF, absent or unreadable: the stored graph, the world model and
 *       the rebuild report are byte-identical to each other — no decay field,
 *       `weight = observed_count`.
 *   D1  the rule, from the four named inputs: one fresh observation is 1;
 *       a confirmed edge halves in 365 days and an intent edge in 14; separate
 *       days count fully and repeats half; structural and undated edges do not
 *       decay; the outcome stages split confirmed from intent.
 *   D2  flag ON, months after the world: the intent edges (February clicks and
 *       saves) are retired; the confirmed ones survive at their derived
 *       strength; the structural ones keep their base.
 *   D3  revocation still holds under decay (§67 A1's case).
 *   D4  a stale edge that gains fresh support is kept, at its new strength.
 *   D5  NEVER from an unread source: an unreadable rank_events leaves the stale
 *       behavior edge undecided, at its stored weight.
 *   D6  idempotent: a second rebuild at the same instant changes nothing.
 *   D7  monotone: later, every surviving strength is no higher.
 *
 * Run: node --import tsx/esm --test src/test/compassGraphDecay.test.ts
 */
import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
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
  /** feature_flags rows whose READ fails, by flag name (census-compass §47: the table now holds a second flag the rebuild reads). */
  failFlags?: Set<string>;
}

interface Result { data: Row[] | Row | null; error: { message: string } | null }

let seq = 0;

class Q implements PromiseLike<Result> {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "delete" | "upsert" | "update" = "select";
  private patch: Row = {};
  private payload: Row[] = [];
  private conflict: string[] = ["id"];
  private orderKey: string | null = null;
  private asc = true;
  private lim: number | null = null;
  private rng: [number, number] | null = null;
  private one = false;

  constructor(private readonly store: Store, private readonly table: string, private readonly opts: FakeOpts, private readonly log: string[]) {}

  select(_cols?: string, _o?: unknown): Q { return this; }
  eq(k: string, v: unknown): Q { if (this.table === "feature_flags" && k === "flag" && this.opts.failFlags?.has(String(v))) this.flagFails = true; this.filters.push((r) => r[k] === v); return this; }
  private flagFails = false;
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
  update(p: Row): Q { this.op = "update"; this.patch = p; return this; }
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
    if (this.op === "update") {
      this.log.push(`update:${t}`);
      for (const r of this.rows().filter((r) => this.filters.every((f) => f(r)))) Object.assign(r, this.patch);
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
    if (this.opts.failSelect?.has(t) || this.flagFails) return { data: null, error: { message: `${t} unreadable` } };
    let out = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.orderKey) {
      const k = this.orderKey;
      out = [...out].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : String(a[k]) > String(b[k]) ? 1 : 0) * (this.asc ? 1 : -1));
    }
    if (this.rng && !this.opts.ignoreRange?.has(t)) out = out.slice(this.rng[0], this.rng[1] + 1);
    if (this.lim !== null) out = out.slice(0, this.lim);
    out = out.map((r) => ({ ...r }));
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


const DAY = 86_400_000;
const FLAG = { flag: engine.GRAPH_DECAY_FLAG, enabled: true };

afterEach(() => { mock.timers.reset(); });

function at(iso: string) { mock.timers.enable({ apis: ["Date"], now: Date.parse(iso) }); }

/** The graph and the world model, less the fake's row ids and the rebuild instant. */
function snapshot(store: Store): string {
  const strip = (rows: Row[] | undefined) => (rows ?? []).map((r) => { const { id: _i, updated_at: _u, computed_at: _c, ...rest } = r; return rest; })
    .map((r) => JSON.stringify(r)).sort();
  return JSON.stringify({
    edges: strip(store.compass_graph_edges), nodes: strip(store.compass_graph_nodes),
    models: strip(store.compass_city_models), confidence: strip(store.compass_city_confidence),
  });
}

async function rebuild(store: Store, opts: FakeOpts = {}) {
  return engine.rebuildIntelligenceGraph(makeDb(store, opts).db);
}

function edge(store: Store, pred: (e: Row) => boolean): Row | undefined {
  return (store.compass_graph_edges ?? []).find(pred);
}

describe("D0 — flag OFF / absent / unreadable are byte-identical, and carry no decay", () => {
  it("the same graph, world model and report", async () => {
    at("2026-09-28T00:00:00Z");
    const absent = sources();
    const off: Store = { ...sources(), feature_flags: [{ flag: engine.GRAPH_DECAY_FLAG, enabled: false }] };
    const unreadable = sources();
    const ra = await rebuild(absent);
    const ro = await rebuild(off);
    // The DECAY flag's read fails. (Failing the whole feature_flags table now also
    // makes §10's precision gate unreadable, which withholds Memory place edges by
    // design — census-compass §47; that case is the next test.)
    const ru = await rebuild(unreadable, { failFlags: new Set([engine.GRAPH_DECAY_FLAG]) });
    assert.equal(snapshot(off), snapshot(absent));
    assert.equal(snapshot(unreadable), snapshot(absent));
    assert.equal(JSON.stringify(ro), JSON.stringify(ra));
    assert.equal(JSON.stringify(ru), JSON.stringify(ra));
    assert.equal(ra.edgeSupport?.decayRetired, undefined);
    for (const e of absent.compass_graph_edges ?? []) assert.equal(e.weight, e.observed_count, "flag off: weight is the count");
  });
});

describe("D0b — the whole feature_flags table unreadable (census-compass §47)", () => {
  it("still no decay; and §10's gate is unreadable too, so no Memory place edge is written", async () => {
    at("2026-09-28T00:00:00Z");
    const absent = sources();
    await rebuild(absent);
    const all = sources();
    const r = await rebuild(all, { failSelect: new Set(["feature_flags"]) });
    assert.equal(r.edgeSupport?.decayRetired, undefined);
    for (const e of all.compass_graph_edges ?? []) assert.equal(e.weight, e.observed_count, "no decay");
    const place = (s: Store) => (s.compass_graph_edges ?? []).filter((e) => e.src_type === "experience" && ["in_city", "at_place"].includes(String(e.edge_type)));
    assert.ok(place(absent).length > 0, "control: with the gate absent (off) the Memories' place edges are written");
    assert.deepEqual(place(all), [], "an unreadable gate wrote a Memory's place into the graph");
  });
});

describe("D1 — the rule", () => {
  const NOW = Date.parse("2026-09-28T00:00:00Z");
  const obs = (over: Partial<engine.GraphEdgeObservation>): engine.GraphEdgeObservation => ({
    src_type: "person", dst_type: "city", edge_type: "visited", count: 1, distinctDays: 1, last: new Date(NOW).toISOString(), ...over,
  });
  it("one fresh observation is exactly 1", () => {
    assert.equal(engine.graphEdgeStrength(obs({}), NOW), 1);
  });
  it("a confirmed edge halves in 365 days; an intent edge in 14", () => {
    assert.equal(engine.graphEdgeStrength(obs({ last: new Date(NOW - 365 * DAY).toISOString() }), NOW), 0.5);
    const click = obs({ dst_type: "place", edge_type: "behavior:click", last: new Date(NOW - 14 * DAY).toISOString() });
    assert.equal(engine.graphEdgeStrength(click, NOW), 0.5);
  });
  it("separate days count fully; repeats on one day count half", () => {
    assert.equal(engine.graphEdgeStrength(obs({ count: 10, distinctDays: 10 }), NOW), Math.round(Math.log2(11) * 1e6) / 1e6);
    assert.equal(engine.graphEdgeStrength(obs({ count: 10, distinctDays: 1 }), NOW), Math.round((1 + 0.5 * Math.log2(10)) * 1e6) / 1e6);
    assert.ok(engine.graphEdgeStrength(obs({ count: 10, distinctDays: 10 }), NOW) > engine.graphEdgeStrength(obs({ count: 10, distinctDays: 1 }), NOW));
  });
  it("structural and undated edges do not decay", () => {
    const old = new Date(NOW - 3000 * DAY).toISOString();
    assert.equal(engine.graphEdgeStrength(obs({ src_type: "trip", dst_type: "city", edge_type: "destination", last: old }), NOW), 1);
    assert.equal(engine.graphEdgeStrength(obs({ last: null }), NOW), 1);
  });
  it("outcome stages: went/stayed/made_memory/returned are confirmed; viewed/saved/liked/invited are intent", () => {
    for (const s of ["went", "stayed", "made_memory", "returned"]) assert.equal(engine.graphEdgeHalfLifeDays({ src_type: "person", dst_type: "place", edge_type: `outcome:${s}` }), 365, s);
    for (const s of ["viewed", "saved", "liked", "invited"]) assert.equal(engine.graphEdgeHalfLifeDays({ src_type: "person", dst_type: "place", edge_type: `outcome:${s}` }), 14, s);
  });
  it("the retirement floor: a single tap goes after 42 days, a single stamp after three years", () => {
    const tapAt = (d: number) => engine.graphEdgeStrength(obs({ dst_type: "place", edge_type: "behavior:click", last: new Date(NOW - d * DAY).toISOString() }), NOW);
    assert.ok(tapAt(41) >= engine.GRAPH_DECAY_RETIRE_BELOW && tapAt(43) < engine.GRAPH_DECAY_RETIRE_BELOW);
    const stampAt = (d: number) => engine.graphEdgeStrength(obs({ last: new Date(NOW - d * DAY).toISOString() }), NOW);
    assert.ok(stampAt(1090) >= engine.GRAPH_DECAY_RETIRE_BELOW && stampAt(1100) < engine.GRAPH_DECAY_RETIRE_BELOW);
  });
});

describe("D2 — flag ON, months after the world", () => {
  it("intent edges retired, confirmed edges decayed, structural edges at their base", async () => {
    at("2026-03-01T00:00:00Z");
    const store: Store = { ...sources(), feature_flags: [FLAG] };
    await rebuild(store);
    assert.ok(edge(store, (e) => String(e.edge_type).startsWith("behavior:")), "fixture: in March the February clicks are fresh and stored");
    mock.timers.reset();
    at("2026-09-28T00:00:00Z");
    const r = await rebuild(store);
    const s = r.edgeSupport!;
    assert.ok((s.decayRetired ?? 0) > 0, JSON.stringify(s));
    assert.equal(edge(store, (e) => String(e.edge_type).startsWith("behavior:")), undefined, "a February click survived");
    assert.equal(edge(store, (e) => e.edge_type === "outcome:saved"), undefined, "a February save survived");
    const visited = edge(store, (e) => e.edge_type === "visited" && e.src_key === B);
    assert.ok(visited, "B's confirmed visit must survive");
    assert.ok(Number(visited!.weight) < 1 && Number(visited!.weight) > 0.5, `B's March visit decays: ${visited!.weight}`);
    const dest = edge(store, (e) => e.edge_type === "destination" && e.src_key === "t-3");
    assert.equal(Number(dest!.weight), 1, "a trip's destination is structural");
  });
});

describe("D3 — revocation still holds under decay", () => {
  it("A's revoked stamp: its visited edge is gone", async () => {
    at("2026-09-28T00:00:00Z");
    const store: Store = { ...sources(), feature_flags: [FLAG] };
    await rebuild(store);
    for (const s of store.user_stamps!) if (s.user_id === A) s.is_revoked = true;
    await rebuild(store);
    assert.equal(edge(store, (e) => e.edge_type === "visited" && e.src_key === A), undefined);
    assert.ok(edge(store, (e) => e.edge_type === "visited" && e.src_key === B), "the control survived");
  });
});

describe("D4 — fresh support keeps a stale edge", () => {
  it("a click yesterday keeps A→place-1, at its new strength", async () => {
    at("2026-09-28T00:00:00Z");
    const store: Store = { ...sources(), feature_flags: [FLAG] };
    store.rank_events!.push({ id: "re-9", user_id: A, item_id: "place-1", item_kind: "place", outcome: "click", served_at: "2026-09-27T00:00:00Z" });
    await rebuild(store);
    const e = edge(store, (x) => x.edge_type === "behavior:click" && x.src_key === A);
    assert.ok(e, "a freshly supported edge was retired");
    const want = engine.graphEdgeStrength({ src_type: "person", dst_type: "place", edge_type: "behavior:click", count: 2, distinctDays: 2, last: "2026-09-27T00:00:00Z" }, Date.parse("2026-09-28T00:00:00Z"));
    assert.equal(Number(e!.weight), want);
    assert.equal(edge(store, (x) => x.edge_type === "behavior:click" && x.src_key === B), undefined, "B's stale click must still go");
  });
});

describe("D5 — never from a source it did not read", () => {
  it("rank_events unreadable: the stale behavior edges are undecided and keep their stored weight", async () => {
    at("2026-03-01T00:00:00Z");
    const store: Store = { ...sources(), feature_flags: [FLAG] };
    await rebuild(store);
    const before = edge(store, (e) => e.edge_type === "behavior:click" && e.src_key === A);
    assert.ok(before, "fixture: the click is fresh in March");
    const w = before!.weight;
    mock.timers.reset();
    at("2026-09-28T00:00:00Z");
    const r = await rebuild(store, { failSelect: new Set(["rank_events"]) });
    const after = edge(store, (e) => e.edge_type === "behavior:click" && e.src_key === A);
    assert.ok(after, "an edge was retired on a read that failed");
    assert.equal(after!.weight, w);
    assert.ok(r.edgeSupport!.undecided > 0);
  });
});

describe("D6 — idempotent", () => {
  it("a second rebuild at the same instant retires and rewrites nothing", async () => {
    at("2026-09-28T00:00:00Z");
    const store: Store = { ...sources(), feature_flags: [FLAG] };
    await rebuild(store);
    const first = snapshot(store);
    const r = await rebuild(store);
    assert.equal(snapshot(store), first);
    assert.equal(r.edgeSupport!.decayRetired, 0);
    assert.equal(r.edgeSupport!.reweighed, 0);
  });
});

describe("D7 — monotone in time", () => {
  it("later, no surviving edge is stronger", async () => {
    at("2026-09-28T00:00:00Z");
    const store: Store = { ...sources(), feature_flags: [FLAG] };
    await rebuild(store);
    const w0 = new Map((store.compass_graph_edges ?? []).map((e) => [`${e.src_type}|${e.src_key}|${e.dst_type}|${e.dst_key}|${e.edge_type}`, Number(e.weight)]));
    mock.timers.reset();
    at("2027-03-28T00:00:00Z");
    await rebuild(store);
    for (const e of store.compass_graph_edges ?? []) {
      const k = `${e.src_type}|${e.src_key}|${e.dst_type}|${e.dst_key}|${e.edge_type}`;
      assert.ok(Number(e.weight) <= (w0.get(k) ?? Infinity) + 1e-9, `${k} grew: ${w0.get(k)} → ${e.weight}`);
    }
  });
});
