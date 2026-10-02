/**
 * census-discovery §79 (lane W10-R4) — one ranking pipeline for GET /discovery.
 *
 * Every case drives the REAL router over a controlled in-memory database. None
 * of it is production evidence: it proves what the code does with the flags in
 * a given state, and says nothing about what any deployment serves.
 *
 *   Z0  BYTE-IDENTITY: with both new flags present and FALSE, and 2850 FALSE,
 *       the eleven legacy scenarios (every serve path, Compass's two included)
 *       replay the 709b7b800 golden exactly. (L0 in discoveryServePathIsolation
 *       replays it with the rows absent.)
 *   C32 / DC-24 — `discovery_for_you_pde_enabled` (3455)
 *     P1  ON: a signed-in for_you page is ordered by the PDE pipeline, and no
 *         Cache B entry is written or replayed.
 *     P2  ON: Compass's gates still decide which candidates enter PDE — a place
 *         Compass refuses (definitely closed) is not served; with Compass off
 *         the same place is served, so the gate is Compass's.
 *     P3  ON: the page IS the PDE page over Compass's eligible candidates —
 *         identical to the Compass-off for_you page when Compass refuses none.
 *     P4  OFF (absent and FALSE): serve points 4 and 5 are Compass's, as before.
 *   DV-03 — `discovery_cache_a_ranked_enabled` (3456)
 *     V1  ON, legacy mode: a signed-in Cache A hit is ranked for the viewer.
 *     V2  ON: an anonymous Cache A hit is exactly the flag-off response.
 *   A05 — the intent mode reaches For You once For You is PDE's
 *     M1  3455 ON + 2850 ON: `?intentMode=quiet` is the mode the for_you page
 *         is live-ranked in. M1c: with 3455 OFF the Compass path carries none.
 *   A07 — a Live-claim read that fails, fails CLOSED
 *     F1  Compass path, 2850 ON, the live gates refuse: every row is still
 *         served in Compass's order, none says "open around now", and the
 *         envelope says the read failed.
 *     F2  (restated §94, W11-X2) a claim read that ERRORS fails closed too:
 *         lib/liveClaimRead now marks it failed, so the row is `unreadable`.
 *     F3  CONTROL: gates open, read fine, nothing dangerous — `nearby_now` is
 *         kept and no degradation is reported.
 *     F4  The cold PDE path follows the same rule.
 *     F5  2850 OFF: no claim read, nothing withheld, no key added.
 *   DC-14 — the consolidated pipeline is inside the shadow comparison
 *     S1  shadow mode, cohort open, Compass fresh rank: the served page is the
 *         legacy page, and one shadow row compares it with the consolidated
 *         pipeline's page (serve point 5).
 *     S2  the same on the Cache B hit (serve point 4).
 *     S3  the Cache A shadow's PDE side for for_you is the consolidated
 *         pipeline's too: a place Compass refuses is not on it.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryOnePipeline.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";

import discoveryRouter, {
  _setTestDbPlacesOverride,
  _clearTestCompassCache,
  _injectTestCacheEntry,
  _clearTestCacheEntry,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateLiveRankFlagCache } from "../lib/discoveryLiveRankRead.js";
import { invalidateCandidateProjectionFlagCache, type DiscoveryCandidate } from "../lib/discoveryCandidate.js";
import { invalidateFlagsCache as invalidateCompassFlagsCache } from "../compass/flags.js";
import { invalidateOnePipelineFlagCache } from "../lib/discoveryOnePipeline.js";
import { _resetStopConditionsForTest } from "../lib/discoveryStopConditions.js";
import { makeFakeMapDb, type FakeState } from "./helpers/fakeMapDb.js";
import { readFileSync } from "node:fs";
import { runLegacyScenarios } from "./helpers/discoveryLegacyScenarios.js";
import { flag } from "./helpers/fakeDiscoveryWorld.js";
import { liveClaimReadFailures, withLiveClaimsWithheld, liveSafetyDegradation, LIVE_NOW_REASON_CODE } from "../lib/discoveryLiveRank.js";

// ── No network: the cold path must not reach Overpass or Nominatim. ──────────
const _originalFetch = globalThis.fetch;
globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (u.includes("overpass-api.de")) return new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { "content-type": "application/json" } }); if (u.includes("overpass-api.de") || u.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
  return _originalFetch(url as string, init);
};

const USER = "cccc3333-0000-0000-0000-000000000079";
const TOKEN = "w10-r4-one-pipeline-tok";
const CACHE_A_FOR_YOU = "miami:for_you:10";
const Q = "destination=Miami&lat=25.77&lng=-80.19&radiusKm=10";

const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-bbbb-4bbb-8bbb-${n.toString(16).padStart(12, "0")}`;
function place(n: number, category: string, savedCount: number, over: Partial<DiscoveryPlace> = {}): DiscoveryPlace {
  const id = uuid(n);
  return {
    id: `db/${id}`, canonicalPlaceId: id, name: `Place ${n}`, category, type: "traveler_pick",
    description: null, distanceKm: n / 10, lat: 25.77 + n / 1000, lng: -80.19, tags: [], address: "Miami, FL",
    website: null, phone: null, openingHours: null, rating: null, isOpenNow: null, savedCount,
    ...over,
  } as DiscoveryPlace;
}
/** Three places whose saved counts disagree with their distance order, so a ranker that runs is visible. */
const rows = (category: string) => [place(1, category, 5), place(2, category, 900), place(3, category, 40)];
/** The same three plus one Compass's safety gate refuses: definitely closed. */
const CLOSED = place(4, "for_you", 2000, { isOpenNow: false });

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];

interface Opts {
  compass?: boolean;
  forYouPde?: boolean | null;
  cacheARanked?: boolean | null;
  liveRank?: boolean;
  gatesOpen?: boolean;
  engine?: { mode: string; cohort?: unknown } | null;
}
function world(o: Opts = {}): FakeState {
  const f = (name: string, v: boolean | null | undefined) => (v === null || v === undefined ? [] : [{ flag: name, enabled: v }]);
  return {
    feature_flags: [
      { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: o.compass ?? true },
      o.engine
        ? { flag: "DISCOVERY_ENGINE_MODE", enabled: true, metadata: { mode: o.engine.mode, cohort: o.engine.cohort ?? { kind: "none" } } }
        : { flag: "DISCOVERY_ENGINE_MODE", enabled: false, metadata: { mode: "legacy" } },
      { flag: "disable_discovery_pde", enabled: false },
      { flag: "discovery_candidate_projection_enabled", enabled: true },
      ...f("discovery_for_you_pde_enabled", o.forYouPde),
      ...f("discovery_cache_a_ranked_enabled", o.cacheARanked),
      ...f("discovery_live_rank_enabled", o.liveRank),
      ...(o.gatesOpen === false ? [] : LIVE_GATES_OPEN),
    ],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }],
    intel_state_snapshots: [],
    // The viewer's own city, so Compass's city factor and PDE's cityMatch both
    // ground a `nearby_now` reason the A07 cases can see withheld.
    user_location_state: [{ user_id: USER, city: "Miami", country: "US", lat: 25.77, lng: -80.19 }],
  };
}

/** Writes the serve path attempted, in order. Recorded, never applied. */
const writes: Array<{ table: string; op: string; payload: unknown }> = [];
const tablesRead: string[] = [];

/** fakeMapDb plus `.like()` (the Compass flag family) and a RECORDING sink for writes. */
function capable(state: FakeState): any {
  const inner = makeFakeMapDb(state, { token: TOKEN, userId: USER });
  const accept = () => {
    const done: any = {
      select: () => done, eq: () => done, in: () => done,
      single: async () => ({ data: null, error: null }), maybeSingle: async () => ({ data: null, error: null }),
      then: (r: any, j?: any) => Promise.resolve({ data: null, error: null }).then(r, j),
    };
    return done;
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => {
          tablesRead.push(table);
          const tableRows = (Array.isArray(state[table]) ? state[table] : ((state[table] as any)?.rows ?? [])) as any[];
          const wrap = (builder: any): any => new Proxy(builder, {
            get(bt, p) {
              if (p === "insert" || p === "upsert" || p === "update" || p === "delete") {
                return (payload: unknown) => { writes.push({ table, op: String(p), payload }); return accept(); };
              }
              if (p === "like" || p === "ilike") {
                return (col: string, pattern: string) => {
                  const body = String(pattern).split("%").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join(".*");
                  const re = new RegExp(`^${body}$`, p === "ilike" ? "i" : "");
                  const hit = tableRows.filter((r) => re.test(String(r[col] ?? "")));
                  return { then: (r: any, j?: any) => Promise.resolve({ data: hit, error: null }).then(r, j) };
                };
              }
              const v = bt[p];
              if (typeof v !== "function") return v;
              if (p === "then") return v.bind(bt);
              return (...args: unknown[]) => { const out = v.apply(bt, args); return out === bt ? wrap(out) : out; };
            },
          });
          return wrap(target.from(table));
        };
      }
      if (prop === "rpc") return async () => ({ data: null, error: null });
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

interface Body {
  cached: boolean;
  total: number;
  places: Array<{ id: string; candidate?: DiscoveryCandidate }>;
  meta?: { cacheLevel?: string; liveRank?: { mode: string | null; readable: boolean }; liveSafety?: { readable: boolean; claimsWithheld: number } };
}

const rankers = (b: Body) => [...new Set(b.places.map((p) => p.candidate?.rankedBy))];
const servedFrom = (b: Body) => [...new Set(b.places.map((p) => p.candidate?.freshness.servedFrom))];
const ids = (b: Body) => b.places.map((p) => p.id);
const nearbyNow = (b: Body) => b.places.filter((p) => p.candidate?.reasons.some((r) => r.code === "nearby_now")).map((p) => p.id);

async function waitFor(pred: () => boolean, ms = 3_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

describe("§79 — one ranking pipeline for GET /discovery (controlled, in-process)", () => {
  let server: Server;
  let url: string;
  const reset = () => {
    _clearTestCompassCache();
    _clearTestCacheEntry(CACHE_A_FOR_YOU);
    invalidateDiscoveryEngineModeCache();
    invalidateLiveRankFlagCache();
    invalidateCandidateProjectionFlagCache();
    invalidateCompassFlagsCache();
    invalidateOnePipelineFlagCache();
    _clearPromotedScopeCache();
    _resetStopConditionsForTest();
    writes.length = 0;
    tablesRead.length = 0;
  };
  beforeEach(async () => {
    server = createServer((() => {
      const app = express();
      app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
      app.use(discoveryRouter);
      return app;
    })());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    server.unref();
    url = `http://127.0.0.1:${(server.address() as any).port as number}`;
    reset();
  });
  afterEach(async () => {
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    reset();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function page(state: FakeState, opts: { category?: string; places?: DiscoveryPlace[]; auth?: boolean; extra?: string } = {}): Promise<Body> {
    const category = opts.category ?? "for_you";
    const list = opts.places ?? rows(category);
    _setTestDbPlacesOverride(async () => list.map((p) => ({ ...p })));
    _setTestServiceClient(capable(state));
    const res = await fetch(`${url}/discovery?${Q}&category=${category}${opts.extra ?? ""}`, {
      headers: opts.auth === false ? {} : { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Body;
  }

  // ── C32 / DC-24 ─────────────────────────────────────────────────────────────
  it("P1. 3455 ON: the signed-in for_you page is ordered by the PDE pipeline, and Cache B is neither written nor replayed", async () => {
    const first = await page(world({ forYouPde: true }));
    assert.ok(first.places.length > 0);
    assert.deepEqual(rankers(first), ["pde"], "the for_you page is ranked by rankForViewer, not by Compass");
    assert.deepEqual(servedFrom(first), ["miss"]);
    const again = await page(world({ forYouPde: true }));
    assert.deepEqual(servedFrom(again), ["miss"], "a second request is not a compass_candidate_hit: no Compass order was stored");
    assert.deepEqual(rankers(again), ["pde"]);
  });

  it("P2. 3455 ON: Compass's gates decide which candidates enter PDE — a definitely-closed place is not served", async () => {
    const list = [...rows("for_you"), CLOSED];
    const on = await page(world({ forYouPde: true }), { places: list });
    assert.ok(!ids(on).includes(CLOSED.id), `Compass's safety gate refuses a closed place, and PDE never saw it: ${JSON.stringify(ids(on))}`);
    assert.equal(on.total, 3);
    reset();
    const compassOff = await page(world({ forYouPde: true, compass: false }), { places: list });
    assert.ok(ids(compassOff).includes(CLOSED.id), "with Compass off the same place IS served — so the exclusion above is Compass's gate, not PDE's");
  });

  it("P3. 3455 ON: the page is the PDE page over Compass's eligible candidates (equal to the Compass-off for_you page when Compass refuses none)", async () => {
    const on = await page(world({ forYouPde: true }));
    reset();
    const compassOff = await page(world({ forYouPde: true, compass: false }));
    assert.deepEqual(ids(on), ids(compassOff));
    assert.deepEqual(rankers(compassOff), ["pde"]);
  });

  for (const [label, v] of [["absent", null], ["FALSE", false]] as const) {
    it(`P4. 3455 ${label}: serve points 5 then 4 are Compass's, exactly as before`, async () => {
      const fresh = await page(world({ forYouPde: v }));
      assert.deepEqual(rankers(fresh), ["compass"]);
      assert.deepEqual(servedFrom(fresh), ["compass_fresh_rank"]);
      const hit = await page(world({ forYouPde: v }));
      assert.deepEqual(servedFrom(hit), ["compass_candidate_hit"]);
    });
  }

  // ── DV-03 ───────────────────────────────────────────────────────────────────
  it("V1. 3456 ON, legacy mode: a signed-in Cache A hit is ranked for the viewer", async () => {
    const cached = rows("for_you");
    const off = await (async () => { _injectTestCacheEntry(CACHE_A_FOR_YOU, cached); return page(world({ cacheARanked: false }), { places: [] }); })();
    assert.equal(off.cached, true);
    assert.deepEqual(rankers(off), ["none"], "flag off: the cached order is served unranked (the DV-03 defect, legacy)");
    reset();
    _injectTestCacheEntry(CACHE_A_FOR_YOU, cached);
    const on = await page(world({ cacheARanked: true }), { places: [] });
    assert.equal(on.cached, true);
    assert.deepEqual(rankers(on), ["pde"], "flag on: the same cache hit is ranked by rankForViewer");
    assert.deepEqual([...ids(on)].sort(), [...ids(off)].sort(), "the same candidates, only the order is the viewer's");
  });

  it("V2. 3456 ON: an anonymous Cache A hit is exactly the flag-off response", async () => {
    const norm = (b: Body) => JSON.stringify({ ...b, places: b.places.map((p) => ({ ...p, candidate: p.candidate ? { ...p.candidate, whyNowValidForMs: null } : undefined })) }, (k, v) => (/recommendation|exposure|servedAt|sessionId|timings|ageMs/i.test(k) ? undefined : v));
    _injectTestCacheEntry(CACHE_A_FOR_YOU, rows("for_you"));
    const off = await page(world({ cacheARanked: false }), { places: [], auth: false });
    reset();
    _injectTestCacheEntry(CACHE_A_FOR_YOU, rows("for_you"));
    const on = await page(world({ cacheARanked: true }), { places: [], auth: false });
    assert.equal(norm(on), norm(off));
  });

  // ── A05 ─────────────────────────────────────────────────────────────────────
  it("M1. 3455 ON + 2850 ON: the intent mode the user chose is the mode For You is ranked in", async () => {
    const body = await page(world({ forYouPde: true, liveRank: true }), { extra: "&intentMode=quiet" });
    assert.equal(body.meta?.liveRank?.mode, "quiet");
    assert.deepEqual(rankers(body), ["pde"]);
  });

  it("M1c. 3455 OFF + 2850 ON: the Compass path carries no mode (the §71.6 Q71-2 gap, still pinned with the flag off)", async () => {
    const body = await page(world({ forYouPde: false, liveRank: true }), { extra: "&intentMode=quiet" });
    assert.deepEqual(rankers(body), ["compass"]);
    assert.equal(body.meta?.liveRank, undefined);
  });

  // ── A07 ─────────────────────────────────────────────────────────────────────
  it("F3. CONTROL: Compass path, 2850 ON, gates open, nothing dangerous — nearby_now is kept, nothing is reported degraded", async () => {
    const body = await page(world({ liveRank: true }));
    assert.deepEqual(servedFrom(body), ["compass_fresh_rank"]);
    assert.ok(nearbyNow(body).length > 0, `the harness must produce a "now" reason for F1/F2 to withhold: ${JSON.stringify(body.places.map((p) => p.candidate?.reasons))}`);
    assert.equal(body.meta?.liveSafety, undefined);
  });

  it("F1. Compass path, 2850 ON, the live gates refuse: served in Compass's order, no 'open around now', and the envelope says so", async () => {
    const baseline = await page(world({ liveRank: false }));
    reset();
    const body = await page(world({ liveRank: true, gatesOpen: false }));
    assert.deepEqual(servedFrom(body), ["compass_fresh_rank"]);
    assert.deepEqual(ids(body), ids(baseline), "the candidates are still served, in the order Compass gave them");
    assert.deepEqual(nearbyNow(body), [], "no row claims 'Close to you and open around now.' when its live state could not be read");
    for (const p of body.places) assert.equal(p.candidate?.whyNow, null);
    assert.deepEqual(body.meta?.liveSafety, { readable: false, claimsWithheld: body.places.length });
  });

  it("F2. (restated §94) a claim read that ERRORS fails closed: rows served in Compass's order, no 'open around now', and the envelope says so", async () => {
    // Until §94 lib/liveClaimRead.readLiveClaims resolved [] on a snapshot read
    // error, and withDiscoveryLiveRank graded the row `none` — "looked, nothing
    // there". Sensing §20: a failure is not an absence. The read now marks the
    // failure (liveClaimReadFailed), the row is `unreadable`, and §79's rule
    // withholds its claim, exactly as for the refused gates in F1 (§79.10).
    const state = world({ liveRank: true });
    state.intel_state_snapshots = { error: { message: "claim read failed" } } as any;
    const body = await page(state);
    assert.deepEqual(servedFrom(body), ["compass_fresh_rank"]);
    assert.ok(tablesRead.includes("intel_state_snapshots"), "the claim read was attempted");
    assert.equal(body.places.length, 3);
    assert.deepEqual(nearbyNow(body), [], "no row claims 'open around now' on a claim read that errored");
    assert.deepEqual(body.meta?.liveSafety, { readable: false, claimsWithheld: body.places.length }, "every served row had a canonical subject, and every one's read failed");
    for (const p of body.places) assert.equal(p.candidate?.whyNow, null, `${p.id}: no why-now rests on a read that failed`);
  });

  it("F4. the cold PDE path follows the same rule: gates refused ⇒ nearby_now withheld, rows served", async () => {
    const ok = await page(world({ liveRank: true }), { category: "food" });
    assert.ok(nearbyNow(ok).length > 0, "control: PDE grounds a nearby_now reason here");
    reset();
    const body = await page(world({ liveRank: true, gatesOpen: false }), { category: "food" });
    assert.deepEqual(rankers(body), ["pde"]);
    assert.equal(body.places.length, 3);
    assert.deepEqual(nearbyNow(body), []);
    assert.equal(body.meta?.liveSafety?.readable, false);
  });

  it("F5. 2850 OFF: no claim is read, nothing is withheld, and no key is added", async () => {
    const body = await page(world({ liveRank: false, gatesOpen: false }));
    assert.equal(tablesRead.includes("intel_state_snapshots"), false);
    assert.ok(nearbyNow(body).length > 0);
    assert.equal(body.meta, undefined, "the Compass envelope carries no meta key at all with the flag off, as before");
  });

  // ── DC-14 ───────────────────────────────────────────────────────────────────
  const SHADOW = { mode: "shadow", cohort: { kind: "users", userIds: [USER] } };
  const shadowRows = () => writes.filter((w) => w.table === "discovery_shadow_serves").map((w) => w.payload as any);

  it("S1. shadow mode, Compass fresh rank: the served page is legacy's, and one shadow row compares it with the consolidated pipeline", async () => {
    const list = [...rows("for_you"), CLOSED];
    const legacy = await page(world({}), { places: list });
    await new Promise((r) => setTimeout(r, 150));
    const legacyTables = new Set(writes.map((w) => w.table));
    const legacyWriteCount = writes.length;
    reset();
    const consolidated = await page(world({ forYouPde: true }), { places: list });
    reset();
    const shadow = await page(world({ engine: SHADOW }), { places: list });
    assert.deepEqual(ids(shadow), ids(legacy), "shadow never changes what is served");
    assert.deepEqual(servedFrom(shadow), ["compass_fresh_rank"]);
    assert.ok(await waitFor(() => shadowRows().length > 0), "no shadow row was written for the Compass serve point");
    const row = shadowRows()[0]!;
    assert.equal(row.serve_point, 5);
    assert.equal(row.category, "for_you");
    assert.deepEqual(row.legacy_ids, ids(shadow));
    assert.deepEqual(row.pde_ids, ids(consolidated), "the PDE side is the page the consolidated pipeline would serve");
    assert.equal(row.pde_stages?.candidateSource, "compass_eligible");
    assert.equal(row.cohort_reason, "user_listed");
    assert.equal(shadowRows().length, 1);
    await new Promise((r) => setTimeout(r, 150));
    const extra = [...new Set(writes.map((w) => w.table))].filter((t) => !legacyTables.has(t));
    assert.deepEqual(extra, ["discovery_shadow_serves"], `the shadow run wrote beyond its own table — Compass's eligibility run must not write: ${JSON.stringify(extra)}`);
    assert.equal(writes.length, legacyWriteCount + 1, `the shadow added writes beyond its one row (legacy tables: ${JSON.stringify([...legacyTables])})`);
  });

  it("S2. shadow mode, Compass Cache B hit: serve point 4 is compared too", async () => {
    await page(world({ engine: SHADOW }));
    assert.ok(await waitFor(() => shadowRows().length === 1));
    writes.length = 0;
    const hit = await page(world({ engine: SHADOW }));
    assert.deepEqual(servedFrom(hit), ["compass_candidate_hit"]);
    assert.ok(await waitFor(() => shadowRows().length === 1), "no shadow row for the Cache B hit");
    assert.equal(shadowRows()[0]!.serve_point, 4);
    assert.deepEqual(shadowRows()[0]!.legacy_ids, ids(hit));
  });

  it("S3. shadow mode, Cache A hit for for_you: the PDE side is the consolidated pipeline's — Compass's refusal holds there too", async () => {
    _injectTestCacheEntry(CACHE_A_FOR_YOU, [...rows("for_you"), CLOSED]);
    const body = await page(world({ engine: SHADOW }), { places: [] });
    assert.equal(body.cached, true);
    assert.ok(ids(body).includes(CLOSED.id), "legacy serves the cached order, closed place included (unchanged)");
    assert.ok(await waitFor(() => shadowRows().length === 1));
    const row = shadowRows()[0]!;
    assert.ok(!row.pde_ids.includes(CLOSED.id), `the consolidated pipeline would not serve it: ${JSON.stringify(row.pde_ids)}`);
    assert.equal(row.pde_stages?.candidateSource, "compass_eligible");
  });
});

describe("§79 A07 — the fail-closed rule, as pure functions", () => {
  const rowsWith = [{ id: "a", canonicalPlaceId: "ca" }, { id: "b", canonicalPlaceId: "cb" }, { id: "osm", canonicalPlaceId: null }];
  const grades = (m: Record<string, "reading" | "forecast" | "none" | "unreadable">) => new Map(Object.entries(m).map(([k, evidence]) => [k, { evidence }]));

  it("U1. flag OFF: nothing was attempted, so nothing failed — whatever the outcome says", () => {
    assert.equal(liveClaimReadFailures(rowsWith, { flagOn: false, applied: false, byId: new Map() }).size, 0);
    assert.equal(liveClaimReadFailures(rowsWith, { flagOn: false, applied: true, byId: grades({ a: "unreadable" }) }).size, 0);
  });

  it("U2. flag ON and the layer did not run (it threw): every row that owed a read failed; a row with no subject never owed one", () => {
    assert.deepEqual([...liveClaimReadFailures(rowsWith, { flagOn: true, applied: false, byId: new Map() })], ["a", "b"]);
  });

  it("U3. flag ON and the layer ran: exactly the rows graded `unreadable` — `none` is 'looked, nothing there', not a failure", () => {
    const failed = liveClaimReadFailures(rowsWith, { flagOn: true, applied: true, byId: grades({ a: "unreadable", b: "none", osm: "unreadable" }) });
    assert.deepEqual([...failed], ["a"]);
  });

  it("U4. withholding: nothing failed ⇒ the SAME array; otherwise only nearby_now and the why-now go, the row and its other reasons stay", () => {
    const served = [
      { id: "a", candidate: { reasons: [{ code: "nearby_now" }, { code: "saved_similar" }], whyNow: ["crowd_quiet"], whyNowValidForMs: 1000 } },
      { id: "b", candidate: { reasons: [{ code: "nearby_now" }], whyNow: null, whyNowValidForMs: null } },
      { id: "c" },
    ];
    assert.equal(withLiveClaimsWithheld(served, new Set()), served);
    const out = withLiveClaimsWithheld(served, new Set(["a", "c"]));
    assert.deepEqual(out.map((r) => r.id), ["a", "b", "c"]);
    assert.deepEqual(out[0]!.candidate, { reasons: [{ code: "saved_similar" }], whyNow: null, whyNowValidForMs: null });
    assert.equal(out[1], served[1], "a row whose read did not fail is untouched");
    assert.equal(out[2], served[2], "a row with no projection is untouched");
    assert.equal(LIVE_NOW_REASON_CODE, "nearby_now");
  });

  it("U5. the envelope statement: absent when nothing failed; counts only the served rows that lost a claim", () => {
    assert.equal(liveSafetyDegradation(new Set(), ["a"]), null);
    assert.deepEqual(liveSafetyDegradation(new Set(["a", "z"]), ["a", "b"]), { readable: false, claimsWithheld: 1 });
  });
});

describe("§79 Z0 — flags FALSE is byte-identical to the tree before them", () => {
  it("Z0. 3455, 3456 and 2850 present and FALSE: the eleven legacy scenarios replay the 709b7b800 golden exactly", async () => {
    const golden = JSON.parse(readFileSync(new URL("./fixtures/discoveryLegacyGolden.json", import.meta.url), "utf8"));
    const now = await runLegacyScenarios([
      flag("discovery_for_you_pde_enabled", false),
      flag("discovery_cache_a_ranked_enabled", false),
      flag("discovery_live_rank_enabled", false),
    ]);
    assert.deepEqual(Object.keys(now), Object.keys(golden));
    for (const k of Object.keys(golden)) assert.deepEqual(now[k], golden[k], `output moved for "${k}" with the flags FALSE`);
  });
});
