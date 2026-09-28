/**
 * census-discovery §93 (lane W11-X1) — DV-09's last three surfaces: Trail,
 * Trending and Trip Planning rank on their own `01` §9 objective through their
 * REAL call sites, behind 3500's three flags AND 3450 (D-W11X1-3, D-W11X1-4).
 *
 *   S0  every flag-off combination (surface flag absent / FALSE / TRUE-with-3450
 *       off / 3450-only) serves exactly the bytes the call site served before
 *       §93, pinned to hashes captured at 44ff6ca63 (the tree before DV-09's
 *       wiring); with the surface flag off 3450 is not even read
 *   S1  Trail: GET /v1/discovery/trails/:id/modules (getTrailModules) gains
 *       `personalized_picks` — in the explored branch too — in the Trail
 *       objective's order, worked by hand below; the other four modules are
 *       unchanged
 *   S2  Trending: GET /v1/discovery/trending/places orders INSIDE each claimed
 *       state by the Trending objective (hand-worked); the state order stays
 *   S3  Trip Planning: GET /trips/:tripId/nearby-places orders by the Trip
 *       Planning objective (hand-worked); the response shape is unchanged
 *   S4  each order IS portavaRank on objectiveForSurface(surface) — and differs
 *       from the same ranker on the Discovery objective, so no surface is
 *       quietly ranked on another's weights
 *   S5  an unread input leaves the call site's own order (never a partial rank)
 *
 * Controlled data only. Nothing here measures real-world effectiveness.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoverySurfaceObjectiveRank.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import express from "express";
import pino from "pino";
import { getTrailModules } from "../services/trails/TrailService.js";
import { trendingByLocation, TREND_DISCLOSURE_MIN_TRAVELERS } from "../lib/discoveryTrendExplanation.js";
import { TREND_STATE_MODEL_VERSION_V2, TREND_FEATURE_VERSION_V2, TREND_PRIOR_MS } from "../lib/discoveryTrendState.js";
import { invalidateRankDesignFlagCache } from "../lib/discoveryRankFlags.js";
import { objectiveForSurface } from "../lib/discoveryRankObjectives.js";
import { rankCandidates } from "../lib/portavaRank.js";
import {
  trailPickCandidate, tripPlanningObjectiveOrder, SURFACE_OBJECTIVE_RANK_FLAGS, loadSurfaceObjective,
} from "../lib/discoverySurfaceObjectiveRank.js";
import { clearProtectedZoneCache } from "../lib/protectedZoneStore.js";
import tripsExpansionRouter from "../routes/trips-expansion.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { makeRulesDb, type Row } from "./helpers/fakeTrailRulesDb.js";

const H = 3_600_000, D = 24 * H;
const rel = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const U = (n: number) => `11111111-1111-4111-8111-1111111111${String(n).padStart(2, "0")}`;
const T = "22222222-2222-4222-8222-222222222201";
const PL = (n: number) => `33333333-3333-4333-8333-3333333333${String(n).padStart(2, "0")}`;
const M = (n: number) => `66666666-6666-4666-8666-6666666666${String(n).padStart(2, "0")}`;
const TRIP = "77777777-7777-4777-8777-777777777701";
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const OBJECTIVES = "discovery_surface_objectives_enabled";
const f = (flag: string, enabled: boolean): Row => ({ flag, enabled, metadata: null });
/** Every flag-off combination: the surface does not rank in any of them. */
const OFF_COMBOS = (surfaceFlag: string): Array<[string, Row[]]> => [
  ["nothing seeded", []],
  ["surface FALSE", [f(surfaceFlag, false)]],
  ["surface FALSE, 3450 TRUE", [f(surfaceFlag, false), f(OBJECTIVES, true)]],
  ["surface TRUE, 3450 FALSE", [f(surfaceFlag, true), f(OBJECTIVES, false)]],
  ["surface TRUE, 3450 absent", [f(surfaceFlag, true)]],
];
const ON = (surfaceFlag: string): Row[] => [f(surfaceFlag, true), f(OBJECTIVES, true)];

/**
 * The flag-off bytes of each call site, captured at 44ff6ca63 — the tree
 * before this section's DV-09 wiring — from exactly the fixtures below.
 */
const GOLDEN = {
  trail: "718978a971a21b51431d90d64e74d3afd6e5b020502c4230575d4cc04bd194da",
  trailExplored: "e71dbdd0a41ae20770b5c848045469d2d95017afe4602910d610314c84492e1d",
  trending: "3e5223bf4c7d672130954f3475d66ba67419d61de6e289b1e8b2944f8c749e12",
  trip: "72249c3b8147582c33ac63674736870169d1eb8cd4dd3dad391bb7363788b746",
};

beforeEach(() => { invalidateRankDesignFlagCache(); clearProtectedZoneCache(); });

// ── Trail ────────────────────────────────────────────────────────────────────
//
// Four place members of one Trail, all attached at the same instant (3 h
// ago), so recency is equal and nothing but the objective's inputs separates
// them:
//   M1  confidence 0.6, contributor U1
//   M2  confidence 0.2, contributor U2 — a creator the viewer FOLLOWS
//   M3  confidence 0.4, contributor U3
//   M4  confidence 0.5, contributor U4
// By hand, on the Trail objective: recency is the same for all four (a place's
// freshness is DE_EMPHASISE 0.75 for every one of them). trail_relevance is
// confidence × 0.10 (TRAIL_AFFINITY weight) × DEFINING 1.5 — 0.09, 0.03, 0.06,
// 0.075, all under the 0.10 cap. followedAuthor is 0.5 (DEFAULT_WEIGHTS, ×1 on
// Trail), so M2 leads; then confidence orders the rest: M1, M4, M3. The four
// are distinct places by distinct contributors, so the Trail's author and place
// penalties do not reorder them. Hence [M2, M1, M4, M3].
const AT = rel(3 * H);
const trailRow: Row = {
  id: T, slug: "bangkok-after-dark", title: "Bangkok After Dark", description: null, destination: "bangkok", place_scope: null,
  parent_trail_id: null, lifecycle_status: "active", created_by: U(1), created_at: rel(90 * D), updated_at: rel(90 * D),
};
const member = (n: number, confidence: number, over: Row = {}): Row => ({
  id: M(n), trail_id: T, source_type: "place", source_id: PL(n), relationship: "supporting", signal: null, source: "user",
  confidence, contributor_id: U(n), content_state: "evergreen", created_at: AT, ...over,
});
const VIEWER = U(9);
function trailDb(flags: Row[]) {
  return makeRulesDb({
    profiles: Array.from({ length: 9 }, (_, i) => ({ id: U(i + 1), account_status: "active", role: "user" })),
    trails: [{ ...trailRow }], feature_flags: flags,
    content_trails: [member(1, 0.6), member(2, 0.2), member(3, 0.4), member(4, 0.5)],
    discovery_places: [1, 2, 3, 4].map((n) => ({ id: PL(n), submitted_by: U(n), name: `P${n}`, lat: null, lng: null })),
    user_follows: [{ follower_id: VIEWER, following_id: U(2) }],
    rank_events: [], trail_member_exposures: [], content_trails_stamp: [],
  });
}
const TRAIL_BY_HAND = [M(2), M(1), M(4), M(3)];

describe("S — Trail: `02` §8's Personalized Picks on `01` §9's Trail objective", () => {
  it("S0-trail every flag-off combination serves the pre-§93 bytes, and with the surface flag off 3450 is not read", async () => {
    for (const [name, flags] of OFF_COMBOS(SURFACE_OBJECTIVE_RANK_FLAGS.trail)) {
      invalidateRankDesignFlagCache();
      const r = await getTrailModules(trailDb(flags), T, { viewerId: VIEWER, pageSize: 8 });
      assert.deepEqual(r.modules.map((m) => m.key), ["just_arrived", "trending_now", "evergreen", "local_picks"], name);
      assert.equal(sha(r.modules), GOLDEN.trail, `${name}: ${sha(r.modules)}`);
    }
    for (const [name, flags] of OFF_COMBOS(SURFACE_OBJECTIVE_RANK_FLAGS.trail)) {
      invalidateRankDesignFlagCache();
      const r = await getTrailModules(trailDb([...flags, f("discovery_trail_exploration_enabled", true)]), T, { viewerId: VIEWER, pageSize: 8 });
      assert.equal(r.modules.some((m) => m.key === "personalized_picks"), false, name);
      assert.equal(sha(r.modules), GOLDEN.trailExplored, `explored, ${name}: ${sha(r.modules)}`);
    }
    const reads: string[] = [];
    const db = trailDb([f(OBJECTIVES, true)]);
    const from = db.from.bind(db);
    (db as any).from = (t: string) => { const b = from(t); if (t !== "feature_flags") return b; const eq = b.eq.bind(b); b.eq = (c: string, v: string) => { if (c === "flag") reads.push(v); return eq(c, v); }; return b; };
    await getTrailModules(db, T, { viewerId: VIEWER, pageSize: 8 });
    assert.ok(reads.includes(SURFACE_OBJECTIVE_RANK_FLAGS.trail), "precondition: the surface flag is read");
    assert.equal(reads.includes(OBJECTIVES), false, "surface flag off ⇒ 3450 is not read");
  });

  it("S1-trail ON: a fifth module, `personalized_picks`, in the hand-worked Trail-objective order; the four others unchanged", async () => {
    const off = await getTrailModules(trailDb([]), T, { viewerId: VIEWER, pageSize: 8 });
    invalidateRankDesignFlagCache();
    const on = await getTrailModules(trailDb(ON(SURFACE_OBJECTIVE_RANK_FLAGS.trail)), T, { viewerId: VIEWER, pageSize: 8 });
    assert.equal(on.refusal, null);
    assert.deepEqual(on.modules.map((m) => m.key), ["just_arrived", "trending_now", "evergreen", "local_picks", "personalized_picks"]);
    assert.equal(sha(on.modules.slice(0, 4)), sha(off.modules), "the four §8 modules are the flag-off modules");
    const picks = on.modules[4]!;
    assert.equal(picks.objective, "trail_objective");
    assert.deepEqual(picks.items.map((i) => i.id), TRAIL_BY_HAND);
    const evergreen = on.modules.find((m) => m.key === "evergreen")!;
    assert.notDeepEqual(evergreen.items.map((i) => i.id), TRAIL_BY_HAND, "picks are not the confidence order: the viewer's follow moved M2 to the top");
  });

  it("S1-trail-explored ON with the exploration machinery on: the picks come from the decided states, in the same order", async () => {
    const on = await getTrailModules(trailDb([...ON(SURFACE_OBJECTIVE_RANK_FLAGS.trail), f("discovery_trail_exploration_enabled", true)]), T, { viewerId: VIEWER, pageSize: 8 });
    const picks = on.modules.find((m) => m.key === "personalized_picks");
    assert.ok(picks, "the explored branch serves the spotlight too");
    assert.deepEqual(picks!.items.map((i) => i.id), TRAIL_BY_HAND);
  });

  it("S4-trail the Trail objective is not Discovery's: an event and a place, worked by hand", () => {
    // E: an event member attached 40 h ago, confidence 0.1. P: a place member
    // attached 3 h ago, confidence 0.6. Recency (weight 1, half-life ~36 h) is
    // ≈0.46 for E and ≈0.94 for P; kindPrior 0.15 for an event, 0 for a place.
    //   Trail:     E = 0.46×1.5 + 0.15 + 0.015 ≈ 0.86;  P = 0.94×0.75 + 0.09 ≈ 0.80  ⇒ [E, P]
    //   Discovery: E = 0.46 + 0.15×1.25 + 0.01 ≈ 0.66;   P = 0.94 + 0.06 ≈ 1.00         ⇒ [P, E]
    // `01` §9's "freshness appropriate to content type" is exactly the difference.
    const row = (id: string, st: string, conf: number, agoH: number, u: string) => ({
      id, source_type: st, source_id: `s-${id}`, created_at: rel(agoH * H), confidence: conf, contributor_id: u, creatorId: null, clusterPlaceId: `pl-${id}`, content_state: "evergreen",
    });
    const rows = [row("P", "place", 0.6, 3, U(1)), row("E", "event", 0.1, 40, U(2))];
    const ctx = { userId: VIEWER, nowMs: Date.now(), trailAffinity: { P: 0.6, E: 0.1 } };
    const order = (s: "trail" | "discovery") => rankCandidates(rows.map(trailPickCandidate), ctx, { objective: objectiveForSurface(s), exploration: false }).map((x) => x.candidate.id);
    assert.deepEqual(order("trail"), ["E", "P"]);
    assert.deepEqual(order("discovery"), ["P", "E"]);
  });
});

// ── Trending ─────────────────────────────────────────────────────────────────
//
// One v2 run in Lisbon. Three `trending` places and one `emerging`:
//   P3  trending, velocity 3.1, created 300 d ago
//   P2  trending, velocity 2.0, created 1 d ago
//   P5  trending, velocity 1.7, created 30 d ago
//   P1  emerging (no velocity), created 2 d ago
// Flag off (D-W10-R1-13): trending first, by velocity — [P3, P2, P5], then P1.
// By hand, on the Trending objective: freshness is DEFINING (×1.5) and the
// recency kernel halves at ~36 h, so P2 (1 d old: 2^(-24/36) ≈ 0.63, ×1.5 ≈
// 0.94) leads by far more than the capped momentum term (≤ 0.15) can close.
// P3 (300 d) and P5 (30 d) are both many half-lives old — recency ≈ 0 — so
// velocity, normalised inside the state, decides: P3 = 3.1/3.1 = 1 → the 0.15
// cap; P5 = 1.7/3.1 ≈ 0.55 → 0.082 × 1.5 ≈ 0.12. So inside `trending`:
// [P2, P3, P5]; `emerging` stays after it: P1.
const K = TREND_DISCLOSURE_MIN_TRAVELERS;
const RUN_AGO = 60_000;
const pm = (n: number, state: string, velocity: number | null): Row => ({
  place_id: `db/${PL(n)}`, computed_at: rel(RUN_AGO), trend_state: state, recent_rate: 0.3, mid_rate: 0.1, prior_rate: 0, total_weight: 12,
  recent_unique_travelers: K + 3, window_unique_travelers: K + 9, model_version: TREND_STATE_MODEL_VERSION_V2, feature_version: TREND_FEATURE_VERSION_V2,
  window_ms: { recent_ms: 172_800_000, mid_ms: 604_800_000, prior_ms: TREND_PRIOR_MS }, source_surface: "discovery",
  recent_exposures: 40, mid_exposures: 40, prior_exposures: 0, recent_groups: 5, mid_groups: 3, prior_groups: 0,
  velocity, time_of_day_factor: 1, peer_factor: 1, lifecycle_state: state === "trending" ? "growing" : state, driver: "saves",
  cell_key: "n:lisbon:alfama", city: "lisbon",
});
const dp = (n: number, createdAgo: number): Row => ({
  id: PL(n), name: `Place ${n}`, status: "active", submitted_by: U(1), lat: null, lng: null, category: "cafe", place_type: "venue",
  created_at: rel(createdAgo), saved_count: 4, verified: false,
});
/**
 * The trend lists' own fake shape (discoveryTrendingLists makeDb): eq, neq,
 * in, gte, not.eq, the blocks or(), order, limit, range. `failFeatureRead`
 * fails the SECOND discovery_places read — the objective's own feature read;
 * the first is eligibility.
 */
function trendDb(flags: Row[], opts: { failFeatureRead?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    feature_flags: flags, profiles: [{ id: U(1), account_status: "active" }, { id: VIEWER, account_status: "active" }],
    blocks: [], protected_zones: [], compass_user_preferences: [], area_momentum: [], trend_integrity_reviews: [],
    place_momentum: [pm(3, "trending", 3.1), pm(2, "trending", 2.0), pm(5, "trending", 1.7), pm(1, "emerging", null)],
    discovery_places: [dp(3, 300 * D), dp(2, D), dp(5, 30 * D), dp(1, 2 * D)],
  };
  let placesReads = 0;
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let orders: Array<{ col: string; asc: boolean }> = [];
    let limitN: number | null = null; let range: [number, number] | null = null;
    const result = () => {
      if (table === "discovery_places" && ++placesReads === 2 && opts.failFeatureRead) return { data: null, error: { code: "57014", message: "timeout" } };
      let out = (tables[table] ?? []).filter((r) => filters.every((fn) => fn(r)));
      for (const o of [...orders].reverse()) out = [...out].sort((a, b) => (String(a[o.col] ?? "") < String(b[o.col] ?? "") ? -1 : String(a[o.col] ?? "") > String(b[o.col] ?? "") ? 1 : 0) * (o.asc ? 1 : -1));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN !== null) out = out.slice(0, limitN);
      return { data: out.map((r) => ({ ...r })), error: null };
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      gte(c: string, v: any) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      not(c: string, op: string, v: any) { if (op !== "eq") throw new Error(`fake: not.${op}`); filters.push((r) => r[c] !== v); return b; },
      or(expr: string) {
        const m = /^blocker_id\.eq\.([^,]+),blocked_id\.eq\.(.+)$/.exec(expr);
        if (!m) throw new Error(`fake: unsupported or() ${expr}`);
        filters.push((r) => r["blocker_id"] === m[1] || r["blocked_id"] === m[2]);
        return b;
      },
      order(c: string, o?: { ascending?: boolean }) { orders = [...orders, { col: c, asc: o?.ascending !== false }]; return b; },
      limit(n: number) { limitN = n; return b; },
      range(a: number, z: number) { range = [a, z]; return b; },
      maybeSingle() { const r = result(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      then(res: (r: any) => any, rej?: (e: any) => any) { return Promise.resolve(result()).then(res, rej); },
    };
    return b;
  }
  return { from, tables };
}
const TRENDING_OFF = [3, 2, 5, 1].map((n) => `db/${PL(n)}`);
const TRENDING_BY_HAND = [2, 3, 5, 1].map((n) => `db/${PL(n)}`);

describe("S — Trending: the Trending objective inside each claimed state", () => {
  it("S0-trending every flag-off combination serves the pre-§93 body", async () => {
    for (const [name, flags] of OFF_COMBOS(SURFACE_OBJECTIVE_RANK_FLAGS.trending)) {
      invalidateRankDesignFlagCache(); clearProtectedZoneCache();
      const out = await trendingByLocation(trendDb(flags), VIEWER, "lisbon", Date.now());
      assert.ok(out.ok, `${name}: ${JSON.stringify(out)}`);
      if (!out.ok) continue;
      assert.deepEqual(out.body.items.map((i) => i.placeId), TRENDING_OFF, name);
      assert.equal(sha(out.body.items), GOLDEN.trending, `${name}: ${sha(out.body.items)}`);
    }
  });

  it("S2-trending ON: inside `trending`, the hand-worked order; the state order stays first", async () => {
    const out = await trendingByLocation(trendDb(ON(SURFACE_OBJECTIVE_RANK_FLAGS.trending)), VIEWER, "lisbon", Date.now());
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.deepEqual(out.body.items.map((i) => i.placeId), TRENDING_BY_HAND);
    assert.deepEqual(out.body.items.map((i) => i.state), ["trending", "trending", "trending", "emerging"]);
    assert.equal(JSON.stringify(out.body).includes("velocity"), false, "still no number on the wire");
  });

  it("S5-trending ON with the place features unreadable: the decided order, never a partial rank", async () => {
    const db = trendDb(ON(SURFACE_OBJECTIVE_RANK_FLAGS.trending), { failFeatureRead: true });
    const out = await trendingByLocation(db, VIEWER, "lisbon", Date.now());
    assert.ok(out.ok);
    if (out.ok) assert.deepEqual(out.body.items.map((i) => i.placeId), TRENDING_OFF);
  });
});

// ── Trip Planning ────────────────────────────────────────────────────────────
//
// A public trip to Lisbon (38.7223, -9.1393). Three places in the city, which
// GET …/nearby-places lists by rating:
//   A  rating 4.9, ~30 km out     B  rating 4.5, ~1 km out     C  rating 4.0, ~5 km out
// Flag off: [A, B, C]. By hand, on the Trip Planning objective: trip fit is
// travel_intent ×2 and is 1/(1 + d/25) inside 50 km (lib/discoveryRankTrip),
// route fit (distance) favours the nearer place too, and saves are equal — so
// nearest first: [B, C, A]. Rating is not a ranker term; it only breaks ties.
const DEST = { lat: 38.7223, lng: -9.1393 };
const PA = "44444444-4444-4444-8444-4444444444a1", PB = "44444444-4444-4444-8444-4444444444b1", PC = "44444444-4444-4444-8444-4444444444c1";
const TOKEN = "tok-trip-viewer";
function tripDb(flags: Row[]) {
  const db = makeRulesDb({
    feature_flags: flags,
    trips: [{ id: TRIP, owner_id: U(1), status: "planning", visibility: "public", destination_city: "Lisbon", destination_country: "PT", destination_lat: DEST.lat, destination_lng: DEST.lng }],
    discovery_places: [
      { id: PA, name: "A", category: "culture", lat: DEST.lat + 0.27, lng: DEST.lng, city: "Lisbon", image_url: null, rating: 4.9, saved_count: 5 },
      { id: PB, name: "B", category: "food", lat: DEST.lat + 0.009, lng: DEST.lng, city: "Lisbon", image_url: null, rating: 4.5, saved_count: 5 },
      { id: PC, name: "C", category: "food", lat: DEST.lat + 0.045, lng: DEST.lng, city: "Lisbon", image_url: null, rating: 4.0, saved_count: 5 },
    ],
    user_follows: [], compass_user_preferences: [], rank_events: [],
  });
  return Object.assign(db, { auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) } });
}

let server: Server;
let base = "";
async function nearby(flags: Row[]): Promise<{ status: number; body: any }> {
  invalidateRankDesignFlagCache();
  const db = tripDb(flags);
  _setTestServiceClient(db as any);
  _setTestClient(db as any, true);
  const res = await fetch(`${base}/trips/${TRIP}/nearby-places`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: await res.json() };
}

describe("S — Trip Planning: GET /trips/:tripId/nearby-places on the Trip Planning objective", () => {
  before(async () => {
    server = createServer(express().use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); }).use(tripsExpansionRouter));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  after(async () => {
    _setTestServiceClient(null);
    _setTestClient(null as any, false);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("S0-trip every flag-off combination serves the pre-§93 body (rating order)", async () => {
    for (const [name, flags] of OFF_COMBOS(SURFACE_OBJECTIVE_RANK_FLAGS.trip_planning)) {
      const r = await nearby(flags);
      assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.places.map((p: any) => p.id), [PA, PB, PC], name);
      assert.equal(sha(r.body), GOLDEN.trip, `${name}: ${sha(r.body)}`);
    }
  });

  it("S3-trip ON: nearest first, by hand [B, C, A]; the same places, the same shape, no ranking field added", async () => {
    const off = await nearby([]);
    const on = await nearby(ON(SURFACE_OBJECTIVE_RANK_FLAGS.trip_planning));
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.places.map((p: any) => p.id), [PB, PC, PA]);
    const byId = (b: any) => Object.fromEntries(b.places.map((p: any) => [p.id, p]));
    assert.deepEqual(byId(on.body), byId(off.body), "every place's bytes are the flag-off bytes; only the order moved");
    assert.deepEqual(Object.keys(on.body).sort(), Object.keys(off.body).sort());
  });

  it("S4-trip the order IS portavaRank on the Trip Planning objective (the lib entry point, same inputs)", async () => {
    const db = tripDb(ON(SURFACE_OBJECTIVE_RANK_FLAGS.trip_planning));
    const places = [
      { id: PA, category: "culture", lat: DEST.lat + 0.27, lng: DEST.lng }, { id: PB, category: "food", lat: DEST.lat + 0.009, lng: DEST.lng },
      { id: PC, category: "food", lat: DEST.lat + 0.045, lng: DEST.lng },
    ];
    const trip = { destination_city: "Lisbon", destination_lat: DEST.lat, destination_lng: DEST.lng };
    assert.deepEqual((await tripPlanningObjectiveOrder(db, VIEWER, trip, places)).map((p) => p.id), [PB, PC, PA]);
    invalidateRankDesignFlagCache();
    const same = await tripPlanningObjectiveOrder(tripDb([]), VIEWER, trip, places);
    assert.equal(same, places, "off: the SAME array comes back");
    assert.equal(await loadSurfaceObjective(null, "trip_planning"), null);
  });
});
