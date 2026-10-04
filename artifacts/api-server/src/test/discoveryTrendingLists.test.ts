/**
 * discoveryTrendingLists — census-discovery §84 (lane W10-R1): `11` §4's three
 * list actions and Local Pulse over loopback HTTP, and the v2 trend
 * explanation (DC-21, DV-29, DV-33).
 *
 *   L-A  both flags, fail-closed; auth; input bounds
 *   L-B  every body is CLOSED: no number, no rate, weight, traveller count or score
 *   L-C  degradations are stated: no run, stale run, a v1 run (not located)
 *   L-D  the list rule: only gains, only above the k-floor, in the decided order
 *   L-E  eligibility: active places, blocks both ways, standing, protected zones;
 *        an unapplied rule is a 503, never a list without it
 *   L-F  personalised: the viewer's affinity first; `basis: none` said out loud
 *   L-G  Local Pulse: named neighbourhoods above k only; a grid cell never
 *   L-H  emerging Trails: the v2 fold over PLACE members only, above k
 *   L-I  the explanation of a v2 run: the driver, the lifecycle, and a
 *        neighbourhood only above its own k-floor (B-3 decided, D-W10-R1-10)
 *
 * Controlled data; no production claim.
 * Run: node --import tsx/esm --test src/test/discoveryTrendingLists.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import trendingRouter from "../routes/discoveryTrending.js";
import {
  explainExposures, eligibleListPlaces, mayNameNeighbourhood, parseDestination, zoneAllowsPosition, TREND_DISCLOSURE_MIN_TRAVELERS, TREND_LIST_STATES,
  type TrendAreaRow, type TrendSnapshotRow,
} from "../lib/discoveryTrendExplanation.js";
import { TREND_STATE_MODEL_VERSION_V2, TREND_FEATURE_VERSION_V2, TREND_PRIOR_MS, explainTrendReading } from "../lib/discoveryTrendState.js";
import { clearProtectedZoneCache } from "../lib/protectedZoneStore.js";

type Row = Record<string, any>;
const K = TREND_DISCLOSURE_MIN_TRAVELERS;
const USER = "11111111-1111-4111-8111-111111111111";
const BLOCKED = "11111111-1111-4111-8111-1111111111b1";
const BANNED = "11111111-1111-4111-8111-1111111111b2";
const OK_AUTHOR = "11111111-1111-4111-8111-1111111111a1";
const pid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** A v2 row as 3477 writes it — rates, exposures, groups and all. */
const pm = (n: number, state: string, velocity: number | null, over: Row = {}): Row => ({
  place_id: `db/${pid(n)}`, computed_at: RUN, trend_state: state, recent_rate: 0.3, mid_rate: 0.1, prior_rate: 0, total_weight: 12,
  recent_unique_travelers: K + 3, window_unique_travelers: K + 9, model_version: TREND_STATE_MODEL_VERSION_V2, feature_version: TREND_FEATURE_VERSION_V2,
  window_ms: { recent_ms: 172_800_000, mid_ms: 604_800_000, prior_ms: TREND_PRIOR_MS }, source_surface: "discovery",
  recent_exposures: 40, mid_exposures: 40, prior_exposures: 0, recent_groups: 5, mid_groups: 3, prior_groups: 0,
  velocity, time_of_day_factor: 1, peer_factor: 1, lifecycle_state: state === "trending" ? "growing" : state, driver: "saves",
  cell_key: "n:lisbon:alfama", city: "lisbon", ...over,
});
let RUN = iso(60_000);

const dp = (n: number, over: Row = {}): Row => ({
  id: pid(n), name: `Place ${n}`, status: "active", submitted_by: OK_AUTHOR, lat: 38.71, lng: -9.13, category: "cafe", place_type: "venue", ...over,
});

function SEED(): Record<string, Row[]> {
  RUN = iso(60_000);
  return {
    feature_flags: [{ flag: "discovery_trending_api_enabled", enabled: true }, { flag: "discovery_trend_lists_enabled", enabled: true }],
    profiles: [
      { id: USER, account_status: "active" }, { id: OK_AUTHOR, account_status: "active" },
      { id: BLOCKED, account_status: "active" }, { id: BANNED, account_status: "suspended" },
    ],
    blocks: [{ blocker_id: USER, blocked_id: BLOCKED }],
    protected_zones: [],
    compass_user_preferences: [],
    place_momentum: [
      pm(1, "emerging", null), pm(2, "trending", 2.0), pm(3, "trending", 3.1), pm(4, "rediscovered", null),
      pm(5, "established", 1.0), pm(6, "cooling", 0.3), pm(7, "unknown", null),
      pm(8, "trending", 9.9, { recent_unique_travelers: K - 1 }),               // below the floor
      pm(9, "trending", 4.0, { city: "porto" }),                                // another city
      pm(10, "trending", 5.0), pm(11, "trending", 5.0), pm(12, "trending", 5.0), pm(13, "trending", 5.0),
      pm(14, "trending", 1.7, { driver: "trip_adds" }),
    ],
    area_momentum: [
      { cell_key: "n:lisbon:alfama", cell_label: "Alfama", city: "lisbon", computed_at: RUN, trend_state: "trending", driver: "saves",
        recent_unique_travelers: K, window_unique_travelers: K + 2, velocity: 2.2, source_surface: "discovery" },
      { cell_key: "n:lisbon:baixa", cell_label: "Baixa", city: "lisbon", computed_at: RUN, trend_state: "emerging", driver: "independent_groups",
        recent_unique_travelers: K - 1, window_unique_travelers: K + 2, velocity: null, source_surface: "discovery" },
      { cell_key: "g:1935:-457", cell_label: null, city: "lisbon", computed_at: RUN, trend_state: "trending", driver: "saves",
        recent_unique_travelers: K + 40, window_unique_travelers: K + 40, velocity: 8, source_surface: "discovery" },
    ],
    discovery_places: [
      dp(1), dp(2), dp(3), dp(4), dp(5), dp(6), dp(7), dp(8), dp(9),
      dp(10, { status: "pending" }), dp(11, { submitted_by: BLOCKED }), dp(12, { submitted_by: BANNED }), dp(13, { lat: 38.80, lng: -9.20 }),
      dp(14, { category: "nightlife" }),
    ],
    trails: [], content_trails: [], rank_events: [],
  };
}

/** PostgREST-shaped fake; anything unmodelled throws. */
function makeDb(seed: Record<string, Row[]>, faults: { erroring?: string[]; missing?: string[] } = {}) {
  const tables: Record<string, Row[]> = { ...seed };
  const reads: string[] = [];
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let orders: Array<{ col: string; asc: boolean }> = [];
    let limitN: number | null = null; let range: [number, number] | null = null; let selected: string[] = [];
    const result = () => {
      reads.push(table);
      if (faults.missing?.includes(table)) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
      if (faults.erroring?.includes(table)) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      let out = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      for (const o of [...orders].reverse()) out = [...out].sort((a, b) => (String(a[o.col] ?? "") < String(b[o.col] ?? "") ? -1 : String(a[o.col] ?? "") > String(b[o.col] ?? "") ? 1 : 0) * (o.asc ? 1 : -1));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN !== null) out = out.slice(0, limitN);
      return { data: out.map((r) => (selected.length > 0 ? Object.fromEntries(selected.filter((c) => c in r).map((c) => [c, r[c]])) : { ...r })), error: null };
    };
    const b: any = {
      select(cols?: string) { selected = String(cols ?? "").split(",").map((c) => c.trim()).filter(Boolean); return b; },
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
  const auth = {
    async getUser(token: string) {
      return tables["profiles"]!.some((p) => p["id"] === token)
        ? { data: { user: { id: token } }, error: null } : { data: { user: null }, error: { message: "invalid token" } };
    },
  };
  return { from, auth, tables, reads };
}

const app = express();
app.use(trendingRouter);
const server = http.createServer(app);
let base = "";
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.closeAllConnections(); server.close(); _clearTestClient(); });
beforeEach(() => clearProtectedZoneCache());

async function get(action: string, dest: string | null, as: string | null = USER) {
  const headers: Record<string, string> = as ? { authorization: `Bearer ${as}` } : {};
  const q = dest === null ? "" : `?destination=${encodeURIComponent(dest)}`;
  const res = await fetch(`${base}/v1/discovery/trending/${action}${q}`, { headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text, cache: res.headers.get("cache-control") };
}
const withDb = (seed = SEED(), faults: Parameters<typeof makeDb>[1] = {}) => { const db = makeDb(seed, faults); _setTestClient(db, true); return db; };
const ids = (body: any) => body.items.map((i: any) => i.placeId);
const ACTIONS = ["places", "for-you", "emerging", "areas"] as const;

describe("L-A — both flags, fail-closed; signed-in; bounded input", () => {
  it("L-A1. each action: 401 without a bearer, 404 with either flag off, 503 flag_unreadable with the flags unreadable (§104), 400 on a bad destination, 200 otherwise", async () => {
    for (const a of ACTIONS) {
      withDb();
      assert.equal((await get(a, "Lisbon", null)).status, 401, a);
      for (const flags of [[{ flag: "discovery_trending_api_enabled", enabled: true }], [{ flag: "discovery_trend_lists_enabled", enabled: true }]]) {
        const db = withDb({ ...SEED(), feature_flags: flags });
        const r = await get(a, "Lisbon");
        assert.equal(r.status, 404, `${a} ${JSON.stringify(flags)}`);
        assert.ok(!db.reads.includes("place_momentum"), "nothing read with a flag off");
      }
      withDb(SEED(), { erroring: ["feature_flags"] });
      const unread = await get(a, "Lisbon"); assert.equal(unread.status, 503, `${a}: an unreadable flag is a failed read`); assert.equal(unread.body.reason, "flag_unreadable", a);  // census-discovery §104 (DV-83, D-W11X2-56): restated — was: assert.equal((await get(a, "Lisbon")).status, 404, `${a}: an unreadable flag reads OFF`);
      withDb();
      for (const bad of [null, "", "x".repeat(81), "lisbon,porto", "a(b)"]) assert.equal((await get(a, bad)).status, 400, `${a} ${bad}`);
      const ok = await get(a, " Lisbon ");
      assert.equal(ok.status, 200, a);
      assert.equal(ok.cache, "private, no-store");
      assert.equal(ok.body.destination, "lisbon");
    }
    assert.equal(parseDestination("São Paulo"), "são paulo");
  });
});

describe("L-B — closed shapes", () => {
  it("L-B1. no number anywhere, only known keys, and none of the words a score would need", async () => {
    const allowed = new Set(["destination", "items", "unavailable", "readingProvenance", "computedAt", "window", "start", "end", "modelVersion",
      "featureVersion", "placeId", "state", "reason", "code", "text", "driver", "lifecycle", "basis", "areas", "area", "trails", "trailId", "trailsUnavailable"]);
    for (const a of ACTIONS) {
      withDb();
      const r = await get(a, "lisbon");
      const walk = (v: unknown): void => {
        assert.notEqual(typeof v, "number", `${a}: a number reached the client`);
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { assert.ok(allowed.has(k), `${a}: key ${k}`); walk(x); }
      };
      walk(r.body);
      for (const leak of ["momentum", "score", "travel", "weight", "_rate", "Rate", "total", "velocity"]) assert.ok(!r.text.includes(leak), `${a}: "${leak}"`);
    }
  });
});

describe("L-C — degradations are stated", () => {
  it("L-C1. no run, a stale run, and a v1 run each say why the list is empty", async () => {
    withDb({ ...SEED(), place_momentum: [], area_momentum: [] });
    assert.equal((await get("places", "lisbon")).body.unavailable, "no_snapshot");
    const stale = SEED(); stale["place_momentum"] = stale["place_momentum"]!.map((r) => ({ ...r, computed_at: iso(3_600_000) }));
    withDb(stale);
    assert.equal((await get("places", "lisbon")).body.unavailable, "stale_snapshot");
    const v1 = SEED(); v1["place_momentum"] = v1["place_momentum"]!.map((r) => ({ ...r, model_version: "discovery-trend-state-v1" }));
    withDb(v1);
    for (const a of ACTIONS) assert.equal((await get(a, "lisbon")).body.unavailable, "not_located", `${a}: a v1 run knows no city`);
  });

  it("L-C2. a store failure is a 503 with a closed reason, never a 200 with an empty list", async () => {
    withDb(SEED(), { missing: ["place_momentum"] });
    const r = await get("places", "lisbon");
    assert.equal(r.status, 503);
    assert.equal(r.body.reason, "trend_store_absent");
  });
});

describe("L-D — only gains, only above the floor, in the decided order", () => {
  it("L-D1. trending by velocity, then emerging, then rediscovered; no established, cooling, unknown, below-k or other city", async () => {
    withDb();
    const r = await get("places", "lisbon");
    assert.deepEqual(ids(r.body), [`db/${pid(13)}`, `db/${pid(3)}`, `db/${pid(2)}`, `db/${pid(14)}`, `db/${pid(1)}`, `db/${pid(4)}`],
      "10 pending, 11 a blocked author, 12 an author not in good standing; 13 is eligible here (no zone in this seed)");
    assert.deepEqual([...TREND_LIST_STATES], ["trending", "emerging", "rediscovered"]);
    const t = r.body.items.find((i: any) => i.placeId === `db/${pid(14)}`);
    assert.equal(t.reason.text, "Frequently added to trips in the last couple of days.");
    assert.equal(t.reason.driver, "trend_driver_trip_adds");
    assert.equal(t.lifecycle, "growing");
  });
});

describe("L-E — what a list may name, for this viewer", () => {
  it("L-E1. a pending place, a blocked author, an author not in good standing and a place in a protected zone are not named", async () => {
    const s = SEED();
    s["protected_zones"] = [{ id: "z1", category: "shelter", action: "suppress", shape: "circle", center_lat: 38.80, center_lng: -9.20, radius_meters: 200, active: true }];
    for (const r of s["place_momentum"]!) if ([10, 11, 12, 13].some((n) => r["place_id"] === `db/${pid(n)}`)) r["velocity"] = 50;
    withDb(s);
    const got = ids((await get("places", "lisbon")).body);
    for (const n of [10, 11, 12, 13]) assert.ok(!got.includes(`db/${pid(n)}`), `place ${n} was named`);
    const blockedByThem = SEED(); blockedByThem["blocks"] = [{ blocker_id: BLOCKED, blocked_id: USER }];
    withDb(blockedByThem);
    assert.ok(!ids((await get("places", "lisbon")).body).includes(`db/${pid(11)}`), "a block is honoured in both directions");
  });

  it("L-E3. the standing read failing on its own (auth already done) is a null, never a list", async () => {
    const db = makeDb(SEED(), { erroring: ["profiles"] });
    assert.equal(await eligibleListPlaces(db, USER, [`db/${pid(1)}`]), null);
    assert.deepEqual([...(await eligibleListPlaces(makeDb(SEED()), USER, [`db/${pid(1)}`, `db/${pid(12)}`]))!.keys()], [pid(1)]);
  });

  it("L-E2. an unreadable zone policy withholds positioned places; an unreadable block or standing read is a 503", async () => {
    withDb(SEED(), { erroring: ["protected_zones"] });
    assert.deepEqual(ids((await get("places", "lisbon")).body), [], "every place here is positioned: none is named");
    for (const t of ["blocks", "profiles", "discovery_places"]) {
      withDb(SEED(), { erroring: [t] });
      const r = await get("places", "lisbon");
      assert.equal(r.status, 503, `${t}: ${r.text}`);
      if (t !== "profiles") assert.equal(r.body.reason, "eligibility_read_failed", t);  // profiles down: lib/http's account-status read refuses first (503)
    }
  });
});

describe("L-F — personalised", () => {
  it("L-F1. the viewer's category affinity orders first; without one, basis is 'none' and the order is the location order", async () => {
    withDb();
    const plain = await get("for-you", "lisbon");
    assert.equal(plain.body.basis, "none");
    assert.deepEqual(ids(plain.body), ids((await get("places", "lisbon")).body));
    const s = SEED(); s["compass_user_preferences"] = [{ user_id: USER, category_weights: { nightlife: 30, food: 2 } }];
    withDb(s);
    const r = await get("for-you", "lisbon");
    assert.equal(r.body.basis, "affinity");
    assert.equal(ids(r.body)[0], `db/${pid(14)}`, "the nightlife place first for a nightlife viewer");
  });
});

describe("L-G — Local Pulse", () => {
  it("L-G1. named neighbourhoods above k, with the name in the sentence; never a grid cell, never below k", async () => {
    withDb();
    const r = await get("areas", "lisbon");
    assert.deepEqual(r.body.areas.map((a: any) => a.area), ["Alfama"]);
    assert.equal(r.body.areas[0].reason.text, "Saved more than usual in Alfama in the last couple of days.");
    assert.ok(!r.text.includes("g:1935"), "a grid square's key is a coordinate and is never served");
  });
});

describe("L-H — emerging places and Trails", () => {
  const T1 = "44444444-4444-4444-8444-444444444441", T2 = "44444444-4444-4444-8444-444444444442";
  function trailSeed(travellers: number): Record<string, Row[]> {
    const s = SEED();
    // A `content_trails` place member IS a discovery_places row: 3476's
    // discovery_trend_place_context joins content_trails.source_id against
    // lower(discovery_places.id). The fixture said otherwise, which made the
    // fold's member-eligibility rule unobservable here.
    s["discovery_places"] = [...s["discovery_places"]!, dp(20)];
    s["trails"] = [{ id: T1, destination: "lisbon", lifecycle_status: "active" }, { id: T2, destination: "lisbon", lifecycle_status: "archived" }];
    s["content_trails"] = [
      { trail_id: T1, source_type: "place", source_id: pid(20) }, { trail_id: T1, source_type: "post", source_id: pid(21) },
      { trail_id: T2, source_type: "place", source_id: pid(20) },
    ];
    const ev: Row[] = [];
    for (let i = 0; i < 40; i++) ev.push({ id: `e${i}`, user_id: `v${i % travellers}`, item_id: `db/${pid(20)}`, surface: "discovery", outcome: "impression", served_at: iso(3_600_000 + i * 60_000), outcome_at: null });
    for (let i = 0; i < 4; i++) ev.push({ id: `s${i}`, user_id: `v${i}`, item_id: pid(20), surface: "discovery", outcome: "save", served_at: iso(7_300_000 + i * 900_000), outcome_at: iso(7_200_000 + i * 900_000) });
    for (let i = 0; i < 40; i++) ev.push({ id: `p${i}`, user_id: `w${i}`, item_id: pid(21), surface: "discovery", outcome: "save", served_at: iso(3_600_000), outcome_at: iso(3_500_000 - i * 900_000) });
    s["rank_events"] = ev;
    return s;
  }
  it("L-H1. an active Trail whose place members emerged across ≥ k travellers is listed; archived Trails and post members are not folded", async () => {
    withDb(trailSeed(K + 2));
    const r = await get("emerging", "lisbon");
    assert.deepEqual(r.body.items.map((i: any) => i.placeId), [`db/${pid(1)}`]);
    assert.deepEqual(r.body.trails.map((t: any) => t.trailId), [T1]);
    assert.equal(r.body.trails[0].reason.text, explainTrendReading("emerging", "saves"));
    assert.equal(r.body.trailsUnavailable, null);
  });
  it("L-H2. below k travellers the Trail is not listed; without 2910 the Trails half says so", async () => {
    withDb(trailSeed(K - 3));
    assert.deepEqual((await get("emerging", "lisbon")).body.trails, []);
    withDb(trailSeed(K + 2), { missing: ["trails"] });
    const r = await get("emerging", "lisbon");
    assert.equal(r.status, 200);
    assert.equal(r.body.trailsUnavailable, "trails_unavailable");
  });
});

// ── L-Z — Q12 (owner, 2026-10-04): protected-zone suppression on the two legs
//          that published without asking the policy ──────────────────────────
//
// "Close Q12 with the threshold of at least 15 travellers and suppress
//  contributions inside protected zones."
//
// The k ≥ 15 half already held on every published leg (L-D, L-G, L-H, L-I).
// This block is the OTHER half, on the two legs that read no zone at all:
// Local Pulse (DV-29) and the emerging-Trails fold. Each gap gets the same
// four questions: inside a zone is withheld · a FAILED policy read withholds
// (and does not quietly answer "nothing") · outside every zone still
// publishes · and the place legs do not change.
describe("L-Z — protected zones, Local Pulse (gap 1)", () => {
  /** A suppress-action zone over exactly dp(13)'s position; dp(13) feeds n:lisbon:alfama. */
  const OVER_13 = { id: "z13", category: "shelter", action: "suppress", shape: "circle", center_lat: 38.80, center_lng: -9.20, radius_meters: 200, active: true };
  /** Same shape, 150 km away: a policy that exists and bears on nothing here. */
  const FAR = { id: "zfar", category: "shelter", action: "suppress", shape: "circle", center_lat: 40.20, center_lng: -8.40, radius_meters: 200, active: true };

  it("L-Z1. a neighbourhood a protected zone fed is NOT published by /trending/areas", async () => {
    const s = SEED();
    s["protected_zones"] = [OVER_13];
    withDb(s);
    const r = await get("areas", "lisbon");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.areas, [], "Alfama was fed by dp(13), which stands inside a suppress zone");
    assert.ok(!r.text.includes("Alfama"), "the neighbourhood's name does not reach the client either");
  });

  it("L-Z2. an UNREADABLE zone policy is a stated 503, never a 200 with an empty pulse", async () => {
    withDb(SEED(), { erroring: ["protected_zones"] });
    const r = await get("areas", "lisbon");
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.reason, "eligibility_read_failed");
    assert.equal(r.body.error, "degraded_unavailable");
    // The same for the read that attributes a cell to its places: an
    // unanswerable question is not an answer of "no zones".
    clearProtectedZoneCache();   // a second phase in one test must re-ask the policy, not reuse the 30s cache
    withDb(SEED(), { erroring: ["discovery_places"] });
    const d = await get("areas", "lisbon");
    assert.equal(d.status, 503, d.text);
    assert.equal(d.body.reason, "eligibility_read_failed");
  });

  it("L-Z3. a neighbourhood outside every zone still publishes — with a policy loaded, and with none", async () => {
    const far = SEED(); far["protected_zones"] = [FAR];
    withDb(far);
    const r = await get("areas", "lisbon");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.areas.map((a: any) => a.area), ["Alfama"], "a distant zone must not blank the feature");
    assert.equal(r.body.areas[0].reason.text, "Saved more than usual in Alfama in the last couple of days.");
    clearProtectedZoneCache();   // without this the next phase re-reads FAR from the cache and asserts nothing new
    withDb(SEED());
    assert.deepEqual((await get("areas", "lisbon")).body.areas.map((a: any) => a.area), ["Alfama"], "no zones at all: unchanged");
  });

  it("L-Z4. a cell no place of this run accounts for is withheld, not waved through", async () => {
    const s = SEED();
    s["area_momentum"] = [...s["area_momentum"]!, {
      cell_key: "n:lisbon:chiado", cell_label: "Chiado", city: "lisbon", computed_at: RUN, trend_state: "trending",
      driver: "saves", recent_unique_travelers: K + 5, window_unique_travelers: K + 5, velocity: 9, source_surface: "discovery",
    }];
    withDb(s);
    const r = await get("areas", "lisbon");
    assert.deepEqual(r.body.areas.map((a: any) => a.area), ["Alfama"], "Chiado has a reading but no place behind it: unclearable");
    assert.ok(!r.text.includes("Chiado"));
    // And when NO candidate cell has a place behind it, the pulse is empty
    // rather than wholly waved through — the branch the case above skips,
    // because Alfama still supplies places there.
    clearProtectedZoneCache();
    // Built from `s`, NOT from a fresh SEED(): SEED() re-stamps RUN, and area
    // rows carrying the old instant would simply fall outside the new run —
    // an empty pulse that proves nothing.
    const alone = { ...s, area_momentum: s["area_momentum"]!.filter((a) => a["cell_key"] !== "n:lisbon:alfama") };
    withDb(alone);
    const only = await get("areas", "lisbon");
    assert.equal(only.status, 200);
    assert.deepEqual(only.body.areas, [], "not one cell could be cleared");
    assert.ok(!only.text.includes("Chiado"));
  });

  it("L-Z5. the place legs are unchanged by the refactor: one decision, same answers", async () => {
    // The zone decision moved into zoneAllowsPosition; these are the four
    // answers eligibleListPlaces relied on, asserted on the shared function.
    const zones = [{ id: "z", category: "shelter", action: "suppress" as const, shape: "circle" as const, center: { lat: 38.80, lng: -9.20 }, radiusMeters: 200 }];
    assert.equal(zoneAllowsPosition("p", "P", 38.80, -9.20, zones), false, "inside: withheld");
    assert.equal(zoneAllowsPosition("p", "P", 38.71, -9.13, zones), true, "outside: published");
    assert.equal(zoneAllowsPosition("p", "P", 38.71, -9.13, null), false, "unreadable policy: withheld");
    assert.equal(zoneAllowsPosition("p", "P", 38.71, -9.13, []), true, "asked, no zones: published");
    assert.equal(zoneAllowsPosition("p", "P", null, null, null), true, "no position: no zone can decide it");
    // A COARSEN zone also withholds here: these wires have no coarse rung.
    const med = [{ id: "m", category: "medical_facility" as const, shape: "circle" as const, center: { lat: 38.71, lng: -9.13 }, radiusMeters: 300 }];
    assert.equal(zoneAllowsPosition("p", "P", 38.71, -9.13, med), false, "coarsened is not published at full precision");
  });
});

describe("L-Z — protected zones, the emerging-Trails fold (gap 2)", () => {
  const T1 = "44444444-4444-4444-8444-444444444441";
  /** The L-H fixture, whose Trail T1 has one PLACE member, dp(20), at 38.71/-9.13. */
  function seed(travellers: number): Record<string, Row[]> {
    const s = SEED();
    s["discovery_places"] = [...s["discovery_places"]!, dp(20)];
    s["trails"] = [{ id: T1, destination: "lisbon", lifecycle_status: "active" }];
    s["content_trails"] = [{ trail_id: T1, source_type: "place", source_id: pid(20) }];
    const ev: Row[] = [];
    for (let i = 0; i < 40; i++) ev.push({ id: `e${i}`, user_id: `v${i % travellers}`, item_id: `db/${pid(20)}`, surface: "discovery", outcome: "impression", served_at: iso(3_600_000 + i * 60_000), outcome_at: null });
    for (let i = 0; i < 4; i++) ev.push({ id: `s${i}`, user_id: `v${i}`, item_id: pid(20), surface: "discovery", outcome: "save", served_at: iso(7_300_000 + i * 900_000), outcome_at: iso(7_200_000 + i * 900_000) });
    s["rank_events"] = ev;
    return s;
  }
  /** A suppress zone over dp(20)'s own position. */
  const OVER_20 = { id: "z20", category: "private_residence", action: "suppress", shape: "circle", center_lat: 38.71, center_lng: -9.13, radius_meters: 150, active: true };

  it("L-Z6. a Trail whose place member stands inside a protected zone is NOT listed", async () => {
    const s = seed(K + 2); s["protected_zones"] = [OVER_20];
    withDb(s);
    const r = await get("emerging", "lisbon");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.trails, [], "the fold must not count a member it withholds");
    assert.ok(!r.text.includes(T1), "the Trail id does not reach the client either");
  });

  it("L-Z7. a FAILED zone read withholds the Trail rather than listing it", async () => {
    withDb(seed(K + 2), { erroring: ["protected_zones"] });
    const r = await get("emerging", "lisbon");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.trails, [], "an unreadable policy over a positioned member: withheld");
    // And a rule that could not be applied at all is STATED on this leg.
    clearProtectedZoneCache();
    const stale = seed(K + 2);
    stale["place_momentum"] = stale["place_momentum"]!.map((x) => ({ ...x, computed_at: iso(3_600_000) }));
    withDb(stale, { erroring: ["blocks"] });
    const f = await get("emerging", "lisbon");
    assert.equal(f.status, 200, f.text);
    assert.equal(f.body.unavailable, "stale_snapshot");
    assert.equal(f.body.trailsUnavailable, "trail_read_failed");
    assert.deepEqual(f.body.trails, []);
  });

  it("L-Z8. a Trail whose members are outside every zone is still listed", async () => {
    const far = seed(K + 2);
    far["protected_zones"] = [{ id: "zfar", category: "shelter", action: "suppress", shape: "circle", center_lat: 40.20, center_lng: -8.40, radius_meters: 200, active: true }];
    withDb(far);
    const r = await get("emerging", "lisbon");
    assert.deepEqual(r.body.trails.map((t: any) => t.trailId), [T1], "a distant zone must not blank the Trails half");
    assert.equal(r.body.trailsUnavailable, null);
    clearProtectedZoneCache();
    withDb(seed(K + 2));
    assert.deepEqual((await get("emerging", "lisbon")).body.trails.map((t: any) => t.trailId), [T1], "no zones at all: unchanged");
  });

  it("L-Z9. an inactive place member is not folded either (the same gate, not a second one)", async () => {
    const s = seed(K + 2);
    s["discovery_places"] = s["discovery_places"]!.map((p) => (p["id"] === pid(20) ? { ...p, status: "pending" } : p));
    withDb(s);
    assert.deepEqual((await get("emerging", "lisbon")).body.trails, []);
  });
});

describe("L-I — the explanation of a v2 run", () => {
  const run = { computedAt: new Date().toISOString(), modelVersion: TREND_STATE_MODEL_VERSION_V2, featureVersion: TREND_FEATURE_VERSION_V2, priorMs: TREND_PRIOR_MS };
  const row = (over: Partial<TrendSnapshotRow> = {}): TrendSnapshotRow => ({
    place_id: "db/p", trend_state: "trending", recent_unique_travelers: K, window_unique_travelers: K, driver: "trip_adds", lifecycle_state: "growing", cell_key: "n:lisbon:alfama", ...over,
  });
  const area = (over: Partial<TrendAreaRow> = {}): TrendAreaRow => ({
    cell_key: "n:lisbon:alfama", cell_label: "Alfama", trend_state: "trending", driver: "saves", recent_unique_travelers: K, window_unique_travelers: K, ...over,
  });
  const explain = (r: TrendSnapshotRow, areas: TrendAreaRow[]) =>
    explainExposures(["rid".padEnd(22, "x")], [{ recommendationId: "rid".padEnd(22, "x"), itemId: "db/p" }], run, [r], Date.now() + 1_000, areas).explanations[0]!.trend;

  it("L-I1. the driver's sentence and code, the lifecycle, and the neighbourhood only above ITS floor", () => {
    assert.deepEqual(explain(row(), [area()]), {
      state: "trending", lifecycle: "growing",
      reason: { code: "trend_accelerating", text: "Frequently added to trips in Alfama in the last couple of days.", driver: "trend_driver_trip_adds" },
    });
    assert.equal(explain(row(), [area({ recent_unique_travelers: K - 1 })])!.reason.text, "Frequently added to trips in the last couple of days.", "below k: no name");
    assert.equal(explain(row(), [area({ cell_label: null })])!.reason.text, "Frequently added to trips in the last couple of days.");
    assert.equal(explain(row(), [])!.reason.text, "Frequently added to trips in the last couple of days.", "no area row: no name");
    assert.equal(explain(row({ cell_key: "g:1:2" }), [area({ cell_key: "g:1:2" })])!.reason.text, "Frequently added to trips in the last couple of days.", "a grid cell is never named");
    assert.equal(explain(row({ recent_unique_travelers: K - 1 }), [area()]), null, "the place's own floor still governs the state");
  });
  it("L-I2. mayNameNeighbourhood needs a name, an `n:` cell and k in both windows", () => {
    assert.equal(mayNameNeighbourhood(area()), true);
    assert.equal(mayNameNeighbourhood(area({ window_unique_travelers: K - 1 })), false);
    assert.equal(mayNameNeighbourhood(area({ cell_label: "" })), false);
    assert.equal(mayNameNeighbourhood(undefined), false);
  });
  it("L-I3. an unknown driver or lifecycle value in a row is not served", () => {
    const t = explain(row({ driver: "bribes", lifecycle_state: "viral" }), [])!;
    assert.deepEqual(t, { state: "trending", reason: { code: "trend_accelerating", text: "Picking up across independent groups in the last couple of days." } });
  });
});
