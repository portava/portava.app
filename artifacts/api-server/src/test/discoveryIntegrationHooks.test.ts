/**
 * discoveryIntegrationHooks — census-discovery §91 (lane W10-I): the hooks the
 * three wave-10 ranking lanes (§78, §85, §79) left for the integrator, each
 * proven ON through its REAL call site — the route, or `rankForViewer` where
 * the hook lives inside it — never through the module alone. Every flag-OFF
 * byte is held by the lanes' own goldens (portavaRankDesignGolden,
 * discoveryCandidatePipelineGolden, discoveryServePathIsolation L0,
 * discoveryOnePipeline Z0, discoveryServedGraphReading H1–H6), which this lane
 * runs unchanged.
 *
 *   X0  §85's pipeline flags are read as literals, and the literals ARE
 *       PIPELINE_FLAG_NAMES (check:flag-polarity reads call sites)
 *   H1  §78 H1: rankForViewer runs the scoring designs — with 3453's intent
 *       term on, every scored row carries `intentMatch` and `stages.rankDesigns`
 *       exists; off, neither does
 *   H2  §78 H2: GET /discovery hands `?intentMode=` to rankForViewer on serve
 *       points 1 (Cache A, pde) and 6 (the cold fetch), and the served rows
 *       STORE `intentMatch` (the DV-39 screen classifies §78's four terms)
 *   H3  §78 H3: GET /pulse ranks on Pulse's own objective under 3450 — the
 *       served impression rows' `recency` is 1.5× (freshness is DEFINING)
 *   R1  §85 R1: the route passes the tab — a for_you page admits a generated
 *       row of a category its pool lacks; a food page does not
 *   R2  §85 R1: the served rows' request context carries the graph reading's
 *       own record (`graphProvenance`) under 3484; absent with it off
 *   I   §85 R3 / D-W10-I-3: DC-11's integrity stage calls DV-12's detector —
 *       a place whose saves are mostly its submitter's own side sinks; a place
 *       farmed by third parties does not; with 3451 off the detector reads
 *       nothing and says `detector_off`
 *   K   §85 R2 / D-W10-I-4: GET /v1/discovery/recommendations/:kind serves the
 *       three kinds behind 3483's output-kinds flag
 *
 * CONTROLLED DATA ONLY; nothing here is production evidence.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryIntegrationHooks.test.ts
 */
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import express from "express";
import pino from "pino";
import discoveryRouter, { _injectTestCacheEntry, _clearTestCacheEntry, _clearTestCompassCache } from "../routes/discovery.js";
import outputKindsRouter from "../routes/discoveryOutputKinds.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { invalidateServeLogFlagCache, SERVE_REQUEST_RPC } from "../lib/discoveryServeLog.js";
import { invalidateCandidateProjectionFlagCache } from "../lib/discoveryCandidate.js";
import { invalidateLiveRankFlagCache } from "../lib/discoveryLiveRankRead.js";
import { invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import { invalidateOnePipelineFlagCache } from "../lib/discoveryOnePipeline.js";
import { _resetStopConditionsForTest } from "../lib/discoveryStopConditions.js";
import { invalidateRankDesignFlagCache } from "../lib/discoveryRankFlags.js";
import { loadPipelineFlags, PIPELINE_FLAG_NAMES } from "../lib/discoveryCandidates/pipelineFlags.js";
import { rankForViewer, type PdePlace, type PdeViewer } from "../lib/discoveryPde.js";
import { worldClient, newWorld, flag, communityRow, overpassBody, type WorldState } from "./helpers/fakeDiscoveryWorld.js";
import { legacyWorld, osmCached, LEGACY_TOKEN as TOK, LEGACY_VIEWER, CACHE_A_FOR_YOU } from "./helpers/discoveryLegacyScenarios.js";
import { makeFakeCandidateDb, flagRow, type Row } from "./helpers/fakeCandidateDb.js";

const Q = "destination=Miami&lat=25.77&lng=-80.19&radiusKm=10";
const CACHE_A_PATH = `/discovery?${Q}&category=for_you`;
const COLD_PATH = `/discovery?${Q}&category=food`;

const realFetch = globalThis.fetch;
let overpassOn = false;
let server: Server;
let base = "";

function resetCaches(): void {
  _clearTestCompassCache();
  _clearTestCacheEntry(CACHE_A_FOR_YOU);
  _clearTestCacheEntry("miami:food:10");
  invalidateDiscoveryEngineModeCache();
  invalidateFlagsCache();
  invalidateServeLogFlagCache();
  invalidateCandidateProjectionFlagCache();
  invalidateLiveRankFlagCache();
  invalidateDiscoveryModifiersFlagCache();
  invalidateOnePipelineFlagCache();
  invalidateRankDesignFlagCache();
  _resetStopConditionsForTest();
}

async function waitFor(pred: () => boolean, ms = 3_000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

interface Served { status: number; ids: string[]; rows: Array<{ item_id: string; features: Record<string, unknown> }>; world: WorldState; body: any }

/** One signed-in GET /discovery in engine mode `pde` for every viewer, with the serve log on. */
async function serve(path: string, flags: ReturnType<typeof flag>[], seed: (w: WorldState) => void = () => {}): Promise<Served> {
  resetCaches();
  const w = legacyWorld();
  w.tables.feature_flags!.push(
    flag("discovery_serve_log_enabled", true),
    flag("DISCOVERY_ENGINE_MODE", true, { mode: "pde", cohort: { kind: "all" } }),
    flag("disable_discovery_pde", false),
    ...flags,
  );
  w.tables.intel_coverage_snapshots = [];
  seed(w);
  const c = worldClient(w);
  _setTestServiceClient(c);
  _setTestClient(c, true);
  if (path.startsWith(CACHE_A_PATH)) _injectTestCacheEntry(CACHE_A_FOR_YOU, osmCached());
  overpassOn = path.startsWith(COLD_PATH);
  const res = await realFetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOK}` } });
  const body = await res.json() as any;
  const ids = ((body.places ?? []) as any[]).map((p) => p.id as string);
  await waitFor(() => w.writes.some((x) => x.table === "rank_events") && w.writes.some((x) => x.table === `rpc:${SERVE_REQUEST_RPC}`));
  await new Promise((r) => setTimeout(r, 50));
  const rows = w.writes.filter((x) => x.table === "rank_events" && x.op === "insert" && Array.isArray(x.payload))
    .flatMap((x) => x.payload as any[]).filter((r) => r.outcome === "impression")
    .map((r) => ({ item_id: r.item_id as string, features: r.features as Record<string, unknown> }));
  return { status: res.status, ids, rows, world: w, body };
}

function assertServed(name: string, s: Served): void {
  assert.equal(s.status, 200, `${name}: ${JSON.stringify(s.body).slice(0, 300)}`);
  assert.ok(s.ids.length >= 3, `${name}: precondition — a page was served`);
  assert.ok(s.rows.length >= 3, `${name}: precondition — its impressions were logged (else every 'absent' below is vacuous)`);
}

before(async () => {
  server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(discoveryRouter)
    .use(outputKindsRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  globalThis.fetch = (async (url: any, init?: any) => {
    const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
    if (s.includes("overpass-api.de")) {
      if (!overpassOn) throw new Error("Network blocked in test environment");
      return new Response(JSON.stringify(overpassBody([
        { id: 11, name: "Taco Stand", amenity: "fast_food" },
        { id: 12, name: "Bistro Doce", amenity: "restaurant", lat: 25.775 },
        { id: 13, name: "Corner Bar", amenity: "bar", lat: 25.78 },
      ])), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
    return realFetch(url, init);
  }) as typeof globalThis.fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  resetCaches();
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});

// ── X0 ───────────────────────────────────────────────────────────────────────

describe("X0 — §85's flags are read as literals, and the literals are PIPELINE_FLAG_NAMES", () => {
  it("the one bulk read names exactly the eight flags", async () => {
    const db = makeFakeCandidateDb({ feature_flags: [] });
    await loadPipelineFlags(db, Date.now());
    const named = db.reads.flatMap((r) => r.ops).find((o) => o.startsWith("in(flag="));
    assert.equal(named, `in(flag=${[...PIPELINE_FLAG_NAMES].sort().join("|")})`);
  });
});

// ── H1: rankForViewer runs the §78 designs ───────────────────────────────────

const pdePlaces = (): PdePlace[] => Array.from({ length: 8 }, (_, i) => ({
  id: `node/${900 + i}`, category: ["food", "nightlife", "culture"][i % 3]!, distanceKm: i / 2, savedCount: i, tags: i % 2 ? ["rooftop"] : ["local"],
}));
const pdeViewer = (): PdeViewer => ({
  userId: LEGACY_VIEWER, city: "miami", followedIds: new Set(), interestTags: new Set(["rooftop"]),
  seenIds: new Set(), placeAffinities: {}, degraded: [], neighborhood: null,
});

describe("H1 — §78 H1: rankForViewer runs the scoring designs behind their flags", () => {
  it("3453's intent term ON + a request mode: every scored row carries intentMatch, and stages.rankDesigns is recorded", async () => {
    invalidateRankDesignFlagCache(); invalidateDiscoveryModifiersFlagCache();
    const db = makeFakeCandidateDb({ feature_flags: [flagRow("discovery_intent_term_enabled", true)], rank_events: [] });
    const o = await rankForViewer(pdePlaces(), pdeViewer(), { sc: db, served: false, intentMode: "right_now" });
    assert.deepEqual(o.stages.rankDesigns, { degraded: [] });
    assert.ok([...o.scoredById.values()].every((s) => typeof s.features["intentMatch"] === "number"), "every row scored the intent");
  });

  it("3450's objectives ON: rankForViewer ranks on the `discovery` objective — relevance (FAVOUR) is 1.25× on every row that has it", async () => {
    const run = async (on: boolean) => {
      invalidateRankDesignFlagCache(); invalidateDiscoveryModifiersFlagCache();
      const db = makeFakeCandidateDb({ feature_flags: on ? [flagRow("discovery_surface_objectives_enabled", true)] : [], rank_events: [] });
      return rankForViewer(pdePlaces(), pdeViewer(), { sc: db, served: false });
    };
    const off = await run(false), on = await run(true);
    const tagged = [...off.scoredById].filter(([, s]) => (s.features["interestTag"] ?? 0) > 0);
    assert.ok(tagged.length >= 2, "precondition: rows carry an interest-tag term");
    for (const [id, s] of tagged) assert.ok(Math.abs(on.scoredById.get(id)!.features["interestTag"]! - 1.25 * s.features["interestTag"]!) < 1e-9, id);
    assert.deepEqual(on.stages.rankDesigns, { degraded: [] });
  });

  it("OFF (flag absent): no stage key and no intentMatch, whatever the request says", async () => {
    invalidateRankDesignFlagCache(); invalidateDiscoveryModifiersFlagCache();
    const db = makeFakeCandidateDb({ feature_flags: [], rank_events: [] });
    const o = await rankForViewer(pdePlaces(), pdeViewer(), { sc: db, served: false, intentMode: "right_now" });
    assert.ok(!("rankDesigns" in o.stages));
    assert.ok([...o.scoredById.values()].every((s) => !("intentMatch" in s.features)));
  });
});

// ── H2: the route hands the mode to the ranker ───────────────────────────────

describe("H2 — §78 H2: GET /discovery passes ?intentMode= to rankForViewer, and the row stores what it scored", () => {
  for (const [name, path] of [["serve point 1 (Cache A, pde)", CACHE_A_PATH], ["serve point 6 (cold fetch)", COLD_PATH]] as const) {
    it(`${name}: 3453 ON — every served row carries intentMatch`, async () => {
      const s = await serve(`${path}&intentMode=right_now`, [flag("discovery_intent_term_enabled", true)]);
      assertServed(name, s);
      for (const r of s.rows) {
        assert.equal(typeof r.features["intentMatch"], "number", `${r.item_id}: ${JSON.stringify(r.features)}`);
        assert.ok(!((r.features["privacyRefused"] as string[] | undefined) ?? []).includes("intentMatch"), "the DV-39 screen keeps it");
      }
    });
    it(`${name}: 3453 OFF — the same request stores no intentMatch`, async () => {
      const s = await serve(`${path}&intentMode=right_now`, [flag("discovery_intent_term_enabled", false)]);
      assertServed(name, s);
      for (const r of s.rows) assert.ok(!("intentMatch" in r.features), r.item_id);
    });
  }
});

// ── R1: the tab reaches candidate generation ─────────────────────────────────

const GEN = "44440000-0000-4000-8000-000000000004";
const seedGenerated = (w: WorldState) => {
  // Beyond the route's own capped read (queryDbPlaces takes 200 rows), as a real city's rows past the cap are,
  // so only generation — which materialises by id — can bring it onto the page. The fillers sit ~90 km out, so
  // the route's own radius filter drops them after ranking and the page is the pool's near rows plus what was generated.
  for (let i = 0; i < 200; i++) w.tables.discovery_places!.push(communityRow(`fill-${i}`, { saved_count: 0, rating: null, lat: 26.6, lng: -80.19 }));
  w.tables.discovery_places!.push(communityRow(GEN, { category: "beaches", primary_category: "beaches", name: "Generated Beach", saved_count: 50, rating: 4.9 }));
  w.tables.place_momentum = [{ place_id: `db/${GEN}`, trend_state: "trending", recent_rate: 9, computed_at: "2026-09-28T03:00:00.000Z", source_surface: "discovery" }];
};

describe("R1 — §85 R1: the served PDE calls pass the tab, which bounds a generated row's category", () => {
  it("for_you (serve point 1): a trending row of a category the pool lacks is generated onto the page", async () => {
    const s = await serve(CACHE_A_PATH, [flag("discovery_candidate_sources_enabled", true)], seedGenerated);
    assertServed("for_you", s);
    assert.ok(s.ids.includes(`db/${GEN}`), `the generated beaches row is served: ${s.ids.join(", ")}`);
  });
  it("food (serve point 6): the same row is refused by the tab", async () => {
    const s = await serve(COLD_PATH, [flag("discovery_candidate_sources_enabled", true)], seedGenerated);
    assertServed("food", s);
    assert.ok(!s.ids.includes(`db/${GEN}`));
  });
  it("control — 3480 OFF: nothing is generated on for_you", async () => {
    const s = await serve(CACHE_A_PATH, [flag("discovery_candidate_sources_enabled", false)], seedGenerated);
    assertServed("for_you off", s);
    assert.ok(!s.ids.includes(`db/${GEN}`));
  });
});

// ── R2: the request context carries the graph reading's own record ───────────

const COMPUTED = "2026-09-27T03:00:00.000Z";
const WINDOW = { kind: "unbounded_start", startMs: null, endMs: Date.parse(COMPUTED), truncated: false, rows: {} };
const seedReading = (w: WorldState) => {
  w.tables.compass_city_confidence = [{
    city: "miami", depth_score: 72, tier: "deep", signals: { posts: 40 }, computed_at: COMPUTED,
    model_version: "compass-city-depth-v1", feature_version: "compass-city-depth-signals-v1", source_window: WINDOW,
  }];
};

describe("R2 — §85 R1 (DC-17): servedGraphReadingFeatures copies the reading's provenance", () => {
  for (const [name, path] of [["serve point 1", CACHE_A_PATH], ["serve point 6", COLD_PATH]] as const) {
    it(`${name}: 3484 ON with the modifiers — every served row stores graphProvenance, all four facts`, async () => {
      const s = await serve(path, [flag("discovery_ranking_modifiers_enabled", true), flag("compass_city_confidence_windowed_reads_enabled", true)], seedReading);
      assertServed(name, s);
      for (const r of s.rows) {
        assert.deepEqual(r.features["graphProvenance"], {
          status: "recorded", modelVersion: "compass-city-depth-v1", featureVersion: "compass-city-depth-signals-v1", sourceWindow: WINDOW, computedAt: COMPUTED,
        }, r.item_id);
      }
    });
    it(`${name}: 3484 OFF — no graphProvenance key (the six §63 keys unchanged)`, async () => {
      const s = await serve(path, [flag("discovery_ranking_modifiers_enabled", true), flag("compass_city_confidence_windowed_reads_enabled", false)], seedReading);
      assertServed(name, s);
      for (const r of s.rows) {
        assert.ok(!("graphProvenance" in r.features), r.item_id);
        assert.equal(r.features["graphTier"], "deep", "precondition: the reading itself was recorded");
      }
    });
  }
});

// ── I: DC-11's integrity stage calls DV-12's detector ────────────────────────

const A = "a0000000-0000-4000-8000-00000000000a";   // mostly saved by its submitter's own side
const B = "b0000000-0000-4000-8000-00000000000b";   // clean
const C = "c0000000-0000-4000-8000-00000000000c";   // farmed by third parties
const SUB_A = "5a000000-0000-4000-8000-000000000001", SUB_B = "5b000000-0000-4000-8000-000000000001", SUB_C = "5c000000-0000-4000-8000-000000000001";
const X1 = "e1000000-0000-4000-8000-000000000001", X2 = "e2000000-0000-4000-8000-000000000001", X3 = "e3000000-0000-4000-8000-000000000001", X4 = "e4000000-0000-4000-8000-000000000001";
const F1 = "f1000000-0000-4000-8000-000000000001", F2 = "f2000000-0000-4000-8000-000000000001";
const OLD = "2024-01-01T00:00:00.000Z";
const savedAt = (h: number) => new Date(Date.parse("2026-09-01T00:00:00.000Z") + h * 3_600_000).toISOString();

function integrityWorld(flags: Array<ReturnType<typeof flag>>): WorldState {
  return newWorld({
    tables: {
      feature_flags: flags,
      discovery_places: [
        { id: A, submitted_by: SUB_A }, { id: B, submitted_by: SUB_B }, { id: C, submitted_by: SUB_C },
      ],
      saved_places: [
        { user_id: SUB_A, place_id: A, saved_at: savedAt(1) },       // self
        { user_id: X1, place_id: A, saved_at: savedAt(30) },         // X1 ↔ SUB_A: self-network
        { user_id: X2, place_id: A, saved_at: savedAt(60) },         // clean
        { user_id: X4, place_id: B, saved_at: savedAt(90) },         // clean
        { user_id: F1, place_id: C, saved_at: savedAt(120) },        // farm
        { user_id: F2, place_id: C, saved_at: savedAt(150) },        // farm
        { user_id: X3, place_id: C, saved_at: savedAt(180) },        // clean
      ],
      trust_reviews: [F1, F2].map((u) => ({ user_id: u, review_type: "gaming_suspected", status: "open" })),
      profiles: [SUB_A, SUB_B, SUB_C, X1, X2, X3, X4, F1, F2].map((id) => ({ id, created_at: OLD, account_status: "active" })),
      user_follows: [{ follower_id: X1, following_id: SUB_A }, { follower_id: SUB_A, following_id: X1 }],
      trust_profiles: [],
      rank_events: [],
    },
  });
}
const integrityPlaces = (): PdePlace[] => [
  { id: `db/${A}`, category: "food", savedCount: 40, tags: ["rooftop"], distanceKm: 0.5 },
  { id: `db/${B}`, category: "food", savedCount: 8, tags: ["local"], distanceKm: 1 },
  { id: `db/${C}`, category: "food", savedCount: 30, tags: ["rooftop"], distanceKm: 0.8 },
  { id: "node/501", category: "food", savedCount: 2, tags: [], distanceKm: 2 },
];

describe("I — DC-11: the integrity stage calls DV-12's detector (registered by lib/discoveryPde.ts)", () => {
  const STAGE = flag("discovery_integrity_stage_enabled", true);
  const DV12 = flag("discovery_engagement_integrity_enabled", true);

  it("3483 stage + 3451 ON: the self-serving place sinks to the foot; the third-party-farmed place is not discounted", async () => {
    invalidateRankDesignFlagCache();
    const w = integrityWorld([STAGE, DV12]);
    const o = await rankForViewer(integrityPlaces(), pdeViewer(), { sc: worldClient(w), served: false });
    assert.deepEqual(o.stages.integrity, { status: "applied", discounted: 1, withheld: 0 });
    const ids = o.ranked.map((p) => p.id);
    assert.equal(ids[ids.length - 1], `db/${A}`, `A sinks: ${ids.join(", ")}`);
    assert.equal(ids.length, 4, "nothing is withheld");
  });

  it("3451 OFF: the detector reads nothing and says detector_off; the order is the stage-off order", async () => {
    invalidateRankDesignFlagCache();
    const base = await rankForViewer(integrityPlaces(), pdeViewer(), { sc: worldClient(integrityWorld([])), served: false });
    invalidateRankDesignFlagCache();
    const w = integrityWorld([STAGE]);
    const o = await rankForViewer(integrityPlaces(), pdeViewer(), { sc: worldClient(w), served: false });
    assert.deepEqual(o.stages.integrity, { status: "detector_off", discounted: 0, withheld: 0 });
    assert.deepEqual(o.ranked.map((p) => p.id), base.ranked.map((p) => p.id));
    assert.ok(!w.reads.includes("saved_places") && !w.reads.includes("trust_reviews"), `no save-evidence read: ${w.reads.join(",")}`);
  });

  it("a failed evidence read changes nothing (detector_failed)", async () => {
    invalidateRankDesignFlagCache();
    const w = integrityWorld([STAGE, DV12]); w.errorTables.add("saved_places");
    const o = await rankForViewer(integrityPlaces(), pdeViewer(), { sc: worldClient(w), served: false });
    assert.equal(o.stages.integrity!.status, "detector_failed");
  });
});

// ── K: the three output kinds are served ─────────────────────────────────────

const T_OLD = "55555555-5555-4555-8555-555555555501";
const T_NEW = "55555555-5555-4555-8555-555555555502";
const trailRow = (id: string, daysAgo: number): Row => ({
  id, slug: `slug-${id.slice(-2)}`, title: `Trail ${id.slice(-2)}`, description: null, destination: "miami", destination_key: "miami", place_scope: null,
  parent_trail_id: null, lifecycle_status: "active", created_by: null,
  created_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), updated_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
});
/** A fake is structurally a partial client; the seam's parameter type names the real one. */
const asServiceClient = (c: object) => c as unknown as Parameters<typeof _setTestServiceClient>[0];
function kindsDb(on: boolean) {
  const db = makeFakeCandidateDb({
    feature_flags: on ? [flagRow("discovery_output_kinds_enabled", true)] : [],
    trails: [trailRow(T_OLD, 90), trailRow(T_NEW, 1)],
    content_trails: [{ trail_id: T_OLD, source_type: "place", source_id: "p", relationship: "signal", signal: "rooftop", created_at: new Date().toISOString() }],
    trail_follows: Array.from({ length: 30 }, (_, i) => ({ trail_id: T_OLD, user_id: `f-${i}` })),
    profiles: [{ id: LEGACY_VIEWER, account_status: "active" }],
    compass_user_preferences: [{ user_id: LEGACY_VIEWER, interests: ["rooftop"], category_weights: null }],
    user_follows: [], rank_events: [], ranking_config: [],
  });
  const client = Object.assign(db, { auth: { getUser: async (t: string) => (t === TOK ? { data: { user: { id: LEGACY_VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid token" } }) } });
  _setTestServiceClient(asServiceClient(client)); _setTestClient(client, true);
  return db;
}
const getKind = async (path: string, auth = true) => {
  const res = await realFetch(`${base}${path}`, { headers: auth ? { authorization: `Bearer ${TOK}` } : {} });
  return { status: res.status, body: await res.json() as any, cache: res.headers.get("cache-control") };
};

describe("K — DC-01: GET /v1/discovery/recommendations/:kind serves what PDE ranks", () => {
  it("401 without a viewer", async () => {
    kindsDb(true);
    assert.equal((await getKind("/v1/discovery/recommendations/trails", false)).status, 401);
  });
  it("flag OFF: 404 feature_disabled, and no Trail is read", async () => {
    const db = kindsDb(false);
    const r = await getKind("/v1/discovery/recommendations/trails?destination=Miami");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
    assert.ok(!db.reads.some((x) => x.table === "trails"));
  });
  it("flag ON: Trails are RANKED — the older Trail that matches the viewer and has followers first", async () => {
    kindsDb(true);
    const r = await getKind("/v1/discovery/recommendations/trails?destination=Miami");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.rankedBy, "pde");
    assert.deepEqual(r.body.items.map((t: any) => t.id), [T_OLD, T_NEW]);
    assert.equal(r.body.cursor, null);
    assert.equal(r.cache, "private, no-store");
  });
  it("emerging discoveries without a destination: 400; an unknown kind: 404", async () => {
    kindsDb(true);
    assert.equal((await getKind("/v1/discovery/recommendations/emerging_discoveries")).status, 400);
    assert.equal((await getKind("/v1/discovery/recommendations/postcards")).status, 404);
  });
  it("a failed read is 503 with the ranker's reason, never an empty 200", async () => {
    const e = makeFakeCandidateDb({ feature_flags: [flagRow("discovery_output_kinds_enabled", true)], profiles: [{ id: LEGACY_VIEWER, account_status: "active" }] }, { erroring: ["trails"] });
    const client = Object.assign(e, { auth: { getUser: async () => ({ data: { user: { id: LEGACY_VIEWER } }, error: null }) } });
    _setTestServiceClient(asServiceClient(client)); _setTestClient(client, true);
    const r = await getKind("/v1/discovery/recommendations/trails?destination=Miami");
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });
});


// ── H3: Pulse ranks on its own objective ─────────────────────────────────────
//
// The fake is a trimmed copy of pulseServedImpressions.test.ts's (that file is a
// suite, not a helper). Pulse's impression rows carry portavaRank's features
// unscreened, so the objective's re-weighting is visible on the served rows.

const ALICE = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const BOB = "b2b2b2b2-bbbb-4bbb-8bbb-000000000002";
const PULSE_CITY = "Manila";

function pulseClient(objectives: boolean | null) {
  const created = "2026-09-28T03:30:00.000Z";
  const post = (n: number) => ({
    id: `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`, author_id: BOB, content: `post ${n}`, created_at: created,
    visibility: "public", status: "active", post_status: "published", location_city: PULSE_CITY, location_country: "Philippines",
    location_name: null, location_source: null, media_urls: [], trip_id: null, canonical_place_id: null, pulse_geo_tags: null, post_media: [],
    profiles: { id: BOB, username: "bob", full_name: "Bob", avatar_url: null },
  });
  const db: Record<string, any[]> = {
    posts: [post(1), post(2), post(3)], events: [], rent_buddy_profiles: [], trips: [], trip_members: [],
    profiles: [{ id: ALICE, account_status: "active" }], blocks: [], follows: [],
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }, ...(objectives === null ? [] : [{ flag: "discovery_surface_objectives_enabled", enabled: objectives, metadata: null }])],
    compass_profiles: [{ user_id: ALICE, current_city: PULSE_CITY, persona_type: "explorer", travel_intensity: "moderate", active_trip_id: null, vibe_tags: [] }],
    user_location_state: [{ user_id: ALICE, city: PULSE_CITY, country: "Philippines" }], rank_events: [],
  };
  function builder(rows: any[]) {
    let filtered = [...rows];
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { filtered = filtered.filter((r) => r[c] === v); return b; },
      neq: (c: string, v: any) => { filtered = filtered.filter((r) => r[c] !== v); return b; },
      in: (c: string, vs: any[]) => { filtered = filtered.filter((r) => vs.includes(r[c])); return b; },
      not: (c: string, op: string, v: any) => { if (op === "in" && Array.isArray(v)) filtered = filtered.filter((r) => !v.includes(r[c])); return b; },
      ilike: (c: string, p: string) => { const rx = new RegExp("^" + p.replace(/%/g, ".*").replace(/_/g, ".") + "$", "i"); filtered = filtered.filter((r) => typeof r[c] === "string" && rx.test(r[c])); return b; },
      like: () => b, lt: () => b, lte: () => b, gt: () => b, gte: () => b, contains: () => b, overlaps: () => b, or: () => b, order: () => b, limit: () => b, range: () => b,
      is: (c: string, v: any) => { filtered = filtered.filter((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (res: any, rej?: any) => Promise.resolve({ data: [...filtered], error: null }).then(res, rej),
    };
    return b;
  }
  const client: any = {
    auth: { getUser: (t?: string) => Promise.resolve(t === "alice-token" ? { data: { user: { id: ALICE } }, error: null } : { data: { user: null }, error: { message: "no token" } }) },
    from: (table: string) => {
      const b = builder(db[table] ?? []);
      b.insert = (data: any) => { for (const r of Array.isArray(data) ? data : [data]) (db[table] ??= []).push({ ...r }); return Promise.resolve({ data: null, error: null }); };
      b.update = () => ({ eq: () => Promise.resolve({ data: null, error: null }) });
      return b;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  return { client, impressions: () => (db["rank_events"] ?? []).filter((r: any) => r.outcome === "impression") };
}

describe("H3 — §78 H3: GET /pulse ranks on Pulse's own objective under discovery_surface_objectives_enabled", () => {
  let pulseServer: Server; let pulseBase = "";
  before(async () => {
    const { default: pulseRouter } = await import("../routes/pulse.js");
    pulseServer = createServer(express().use(express.json()).use("/api", pulseRouter));
    await new Promise<void>((r) => pulseServer.listen(0, "127.0.0.1", () => r()));
    pulseBase = `http://127.0.0.1:${(pulseServer.address() as any).port}`;
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T09:30:00Z") });   // the three serves share one clock, so recency is comparable
  });
  after(async () => { mock.timers.reset(); await new Promise<void>((r) => pulseServer.close(() => r())); _setTestClient(null, false); });

  async function servedRecency(objectives: boolean | null): Promise<Map<string, number>> {
    invalidateFlagsCache(); invalidateRankDesignFlagCache();
    const f = pulseClient(objectives);
    _setTestClient(f.client, true);
    const r = await realFetch(`${pulseBase}/api/pulse`, { headers: { Authorization: "Bearer alice-token" } });
    assert.equal(r.status, 200);
    const served = ((await r.json()) as any).posts as any[];
    assert.equal(served.length, 3, "precondition: three posts served");
    await waitFor(() => f.impressions().length >= 3);
    return new Map(f.impressions().map((x: any) => [x.item_id as string, Number(x.features?.recency)]));
  }

  it("ON: every served row's freshness term is Pulse's DEFINING 1.5×; absent and FALSE are the same serve", async () => {
    const absent = await servedRecency(null);
    const off = await servedRecency(false);
    const on = await servedRecency(true);
    assert.deepEqual([...off], [...absent], "FALSE ≡ absent");
    for (const [id, v] of absent) {
      assert.ok(v > 0, `precondition: ${id} has a freshness term`);
      assert.ok(Math.abs(on.get(id)! - v * 1.5) < 1e-9, `${id}: ${on.get(id)} vs 1.5 × ${v}`);
    }
  });
});

// ── R2p: census-discovery §94 (lane W11-X2), DC-17 on the PLATFORM path ──────
// Appended at the foot so no cited line above moves. Where the platform's
// coverage store answers the reading (CPV2-12), served rows used to carry
// `graphProvenance: { status: "platform_producer" }` and no facts. Under 3490's
// `discovery_platform_graph_provenance_enabled` they carry the platform
// reading's own four (lib/discoveryPlatformGraphProvenance.ts).

const P_NEWEST = new Date(Date.now() - 10 * 60_000).toISOString();
const P_OLDEST = new Date(Date.now() - 40 * 60_000).toISOString();
const seedPlatform = (w: WorldState) => {
  const exp = new Date(Date.now() + 50 * 60_000).toISOString();
  w.tables.intel_coverage_snapshots = [
    { city: "Miami", zone_id: "z1", claim_family: "crowd.level", coverage_state: "covered", current_confidence: 0.9, score: 0.1, computed_at: P_NEWEST, expires_at: exp },
    { city: "Miami", zone_id: "z2", claim_family: "crowd.level", coverage_state: "covered", current_confidence: 0.7, score: 0.2, computed_at: P_OLDEST, expires_at: exp },
  ];
};

describe("R2p — §94 (DC-17): the platform path's served rows carry the platform reading's own record", () => {
  for (const [name, path] of [["serve point 1", CACHE_A_PATH], ["serve point 6", COLD_PATH]] as const) {
    it(`${name}: 3484 + 3490 ON with the modifiers — every served row stores all four facts of the PLATFORM reading`, async () => {
      const s = await serve(path, [flag("discovery_ranking_modifiers_enabled", true), flag("compass_city_confidence_windowed_reads_enabled", true), flag("discovery_platform_graph_provenance_enabled", true)], seedPlatform);
      assertServed(name, s);
      for (const r of s.rows) {
        assert.equal(r.features["graphSource"], "platform_coverage", "precondition: the platform answered the reading");
        const p = r.features["graphProvenance"] as any;
        assert.equal(p?.status, "recorded", `${r.item_id}: ${JSON.stringify(p)}`);
        assert.equal(p.modelVersion, "compass-platform-coverage-fold-v1");
        assert.equal(p.featureVersion, "intel-coverage-cell-state-v1");
        assert.equal(p.computedAt, P_NEWEST);
        assert.equal(p.sourceWindow?.startMs, Date.parse(P_OLDEST));
        assert.equal(p.sourceWindow?.rows?.intel_coverage_snapshots, 2);
      }
    });
    it(`${name}: 3490 OFF — the platform reading is still recorded as platform_producer, with no facts (as before §94)`, async () => {
      const s = await serve(path, [flag("discovery_ranking_modifiers_enabled", true), flag("compass_city_confidence_windowed_reads_enabled", true), flag("discovery_platform_graph_provenance_enabled", false)], seedPlatform);
      assertServed(name, s);
      for (const r of s.rows) assert.deepEqual(r.features["graphProvenance"], { status: "platform_producer" }, r.item_id);
    });
  }
});

// ── R1c: census-discovery §94 (lane W11-X2), routed hunk R-X3-1 from §95 ────
// A generated row carries the request's distance. §95 gave `rankForViewer` a
// `center` option (lib/discoveryCandidates/stages.ts); until the served calls
// pass the request's distance reference, a generated row is served with
// `distanceKm: null` while every pooled row beside it carries one.

const seedGeneratedFood = (w: WorldState) => {
  for (let i = 0; i < 200; i++) w.tables.discovery_places!.push(communityRow(`fill-${i}`, { saved_count: 0, rating: null, lat: 26.6, lng: -80.19 }));
  w.tables.discovery_places!.push(communityRow(GEN, { name: "Generated Food", saved_count: 50, rating: 4.9, lat: 25.78, lng: -80.2 }));
  w.tables.place_momentum = [{ place_id: `db/${GEN}`, trend_state: "trending", recent_rate: 9, computed_at: "2026-09-28T03:00:00.000Z", source_surface: "discovery" }];
};

describe("R1c — §94 (R-X3-1): a generated row is served with the request's distance", () => {
  for (const [name, path, seed] of [["for_you (serve point 1)", CACHE_A_PATH, seedGenerated], ["food (serve point 6)", COLD_PATH, seedGeneratedFood]] as const) {
    it(`${name}: the generated row carries a non-null distanceKm, measured from the request`, async () => {
      const s = await serve(path, [flag("discovery_candidate_sources_enabled", true)], seed);
      assertServed(name, s);
      const gen = (s.body.places as any[]).find((p) => p.id === `db/${GEN}`);
      assert.ok(gen, `precondition: the row was generated onto the page: ${s.ids.join(", ")}`);
      assert.equal(typeof gen.distanceKm, "number", `generated row distanceKm: ${JSON.stringify(gen.distanceKm)}`);
      assert.ok(gen.distanceKm >= 0 && gen.distanceKm < 5, `measured from the request's point (25.77, -80.19): ${gen.distanceKm}`);
    });
  }
});
