/**
 * census-discovery §97 (lane W11-S) — a tripped stop reaches every path the
 * Discovery rollout turned on, not only DISCOVERY_ENGINE_MODE.
 *
 * Before §97 a tripped `12` stop condition resolved the engine mode to legacy
 * (lib/discoveryEngineMode.ts) and nothing else. 3455 (`for_you` by PDE), 3456
 * (Cache A ranked in every mode), §78's six design flags and §85's pipeline
 * flags are read without the stop state, so they stayed in force and the
 * recovery was a manual flag flip (owner approval request, action 8).
 *
 * Every case is: stop TRIPPED with the path's flag ON serves exactly what the
 * stop CLEAR with the flag OFF serves; and a control with the stop clear and
 * the flag ON still serves the flag's behaviour.
 *
 *   B0  BYTE-IDENTITY: every flag OFF — a tripped stop serves the same bytes,
 *       with no new reads, as a clear one.
 *   B1  every flag OFF, stop clear: the gate is never consulted (no read of
 *       the manual stop or the arming flag on a legacy serve).
 *   G1  3455, serve points 5 then 4 (Compass for_you): tripped ⇒ Compass's page.
 *   G2  3456, a signed-in Cache A hit in legacy mode: tripped ⇒ unranked.
 *   G3  §78 (3450 + 3453): rankForViewer — the function serve points 1 and 6
 *       call — scores exactly as with every design flag off. DRS's
 *       negative-feedback input and Pulse's objective read OFF too.
 *   G4  §85 (3480 + 3483): the pipeline flags read OFF, and the output-kinds
 *       route answers its flag-off 404.
 *   G5  the manual stop, `disable_discovery_pde` TRUE, is the same halt.
 *   G6  legacy mode with 3456 ON still MEASURES: the gate refreshes 3391's
 *       database conditions, so an armed RLS deviation halts 3456 without a
 *       non-legacy engine mode.
 *   C*  controls: the stop clear, every ON behaviour unchanged.
 *
 * CONTROLLED DATA ONLY; nothing here is production evidence.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryStopGate.test.ts
 */
import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";

import discoveryRouter, {
  _setTestDbPlacesOverride, _clearTestCompassCache, _injectTestCacheEntry, _clearTestCacheEntry,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import outputKindsRouter from "../routes/discoveryOutputKinds.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateLiveRankFlagCache } from "../lib/discoveryLiveRankRead.js";
import { invalidateCandidateProjectionFlagCache, type DiscoveryCandidate } from "../lib/discoveryCandidate.js";
import { invalidateFlagsCache as invalidateCompassFlagsCache } from "../compass/flags.js";
import { invalidateOnePipelineFlagCache } from "../lib/discoveryOnePipeline.js";
import { invalidateRankDesignFlagCache, loadRankDesignFlags, ALL_RANK_DESIGN_FLAGS_OFF } from "../lib/discoveryRankFlags.js";
import { surfaceObjectiveOptions } from "../lib/discoveryRankDesigns.js";
import { invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import { loadPipelineFlags, PIPELINE_FLAGS_OFF } from "../lib/discoveryCandidates/pipelineFlags.js";
import { rankForViewer, type PdePlace, type PdeViewer } from "../lib/discoveryPde.js";
import { withDiscoveryNegativeFeedback, type RankingInput } from "../services/ranking/DiscoveryRankingService.js";
import {
  _resetStopConditionsForTest, recordServeLogOutcome, evaluateStopConditions,
  STOP_ENFORCEMENT_VALUES_VERSION,
} from "../lib/discoveryStopConditions.js";
import { makeFakeMapDb, type FakeState } from "./helpers/fakeMapDb.js";
import { makeFakeCandidateDb, flagRow } from "./helpers/fakeCandidateDb.js";

// ── No network: the cold path must not reach Overpass or Nominatim. ──────────
const realFetch = globalThis.fetch;

const USER = "cccc3333-0000-0000-0000-000000000097";
const TOKEN = "w11s-stop-gate-tok";
const CACHE_A_FOR_YOU = "miami:for_you:10";
const Q = "destination=Miami&lat=25.77&lng=-80.19&radiusKm=10";

const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-bbbb-4bbb-8bbb-${n.toString(16).padStart(12, "0")}`;
function place(n: number, category: string, savedCount: number): DiscoveryPlace {
  const id = uuid(n);
  return {
    id: `db/${id}`, canonicalPlaceId: id, name: `Place ${n}`, category, type: "traveler_pick",
    description: null, distanceKm: n / 10, lat: 25.77 + n / 1000, lng: -80.19, tags: [], address: "Miami, FL",
    website: null, phone: null, openingHours: null, rating: null, isOpenNow: null, savedCount,
  } as DiscoveryPlace;
}
/** Saved counts disagree with distance order, so a ranker that runs is visible. */
const rows = (category: string) => [place(1, category, 5), place(2, category, 900), place(3, category, 40)];

interface Opts { forYouPde?: boolean; cacheARanked?: boolean; killSwitch?: boolean; armed?: boolean }
function world(o: Opts = {}): FakeState {
  return {
    feature_flags: [
      { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true },
      { flag: "DISCOVERY_ENGINE_MODE", enabled: false, metadata: { mode: "legacy" } },
      { flag: "disable_discovery_pde", enabled: o.killSwitch ?? false },
      { flag: "discovery_candidate_projection_enabled", enabled: true },
      { flag: "discovery_for_you_pde_enabled", enabled: o.forYouPde ?? false },
      { flag: "discovery_cache_a_ranked_enabled", enabled: o.cacheARanked ?? false },
      ...(o.armed ? [{ flag: "discovery_stop_enforcement_enabled", enabled: true, metadata: { values_version: STOP_ENFORCEMENT_VALUES_VERSION } }] : []),
    ],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }],
    intel_state_snapshots: [],
    user_location_state: [{ user_id: USER, city: "Miami", country: "US", lat: 25.77, lng: -80.19 }],
  };
}

const flagReads: string[] = [];
let rpcBody: unknown = null;

/** fakeMapDb plus `.like()`, a write sink, a recorded flag-read sequence and a settable rpc body. */
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
          const tableRows = (Array.isArray(state[table]) ? state[table] : []) as any[];
          const wrap = (builder: any): any => new Proxy(builder, {
            get(bt, p) {
              if (p === "insert" || p === "upsert" || p === "update" || p === "delete") return () => accept();
              if (p === "like" || p === "ilike") {
                return (col: string, pattern: string) => {
                  const body = String(pattern).split("%").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join(".*");
                  const re = new RegExp(`^${body}$`, p === "ilike" ? "i" : "");
                  return { then: (r: any, j?: any) => Promise.resolve({ data: tableRows.filter((x) => re.test(String(x[col] ?? ""))), error: null }).then(r, j) };
                };
              }
              if (p === "eq" && table === "feature_flags") {
                return (col: string, v: unknown) => { if (col === "flag") flagReads.push(String(v)); return wrap(bt.eq(col, v)); };
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
      if (prop === "rpc") return async () => ({ data: rpcBody, error: null });
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

interface Body { cached: boolean; total: number; places: Array<{ id: string; candidate?: DiscoveryCandidate }>; meta?: unknown }
const rankers = (b: Body) => [...new Set(b.places.map((p) => p.candidate?.rankedBy))];
/** The response minus the per-request stamps (ids, clocks) that differ between any two serves. */
const norm = (b: Body) => JSON.stringify(
  { ...b, places: b.places.map((p) => ({ ...p, candidate: p.candidate ? { ...p.candidate, whyNowValidForMs: null } : undefined })) },
  (k, v) => (/recommendation|exposure|servedAt|sessionId|timings|ageMs|rankedAt|endMs/i.test(k) ? undefined : v),
);

/** Trip the stop the way production does: the serve log's inserts are rejected (the unratified 5 % value, enforced disarmed). */
function trip(): void {
  for (let i = 0; i < 25; i++) recordServeLogOutcome({ outcome: "rejected", servedItems: 3 });
  assert.ok(evaluateStopConditions().tripped.includes("event_rejection_rate"), "precondition: the stop is tripped");
}

function resetAll(): void {
  _clearTestCompassCache();
  _clearTestCacheEntry(CACHE_A_FOR_YOU);
  invalidateDiscoveryEngineModeCache();
  invalidateLiveRankFlagCache();
  invalidateCandidateProjectionFlagCache();
  invalidateCompassFlagsCache();
  invalidateOnePipelineFlagCache();
  invalidateRankDesignFlagCache();
  invalidateDiscoveryModifiersFlagCache();
  _clearPromotedScopeCache();
  _resetStopConditionsForTest();
  flagReads.length = 0;
  rpcBody = null;
}

let server: Server;
let url = "";
before(async () => {
  globalThis.fetch = (async (u: any, init?: any) => {
    const s = String(typeof u === "string" ? u : (u as URL).href ?? "");
    if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
    return realFetch(u, init);
  }) as typeof globalThis.fetch;
  server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(discoveryRouter)
    .use(outputKindsRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  server.unref();
  url = `http://127.0.0.1:${(server.address() as any).port as number}`;
});
after(async () => {
  globalThis.fetch = realFetch;
  _setTestDbPlacesOverride(null);
  _setTestServiceClient(null);
  resetAll();
  await new Promise<void>((r) => server.close(() => r()));
});

async function page(state: FakeState, opts: { category?: string; places?: DiscoveryPlace[] } = {}): Promise<Body> {
  const category = opts.category ?? "for_you";
  const list = opts.places ?? rows(category);
  _setTestDbPlacesOverride(async () => list.map((p) => ({ ...p })));
  _setTestServiceClient(capable(state));
  const res = await realFetch(`${url}/discovery?${Q}&category=${category}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  return (await res.json()) as Body;
}

describe("§97 — GET /discovery: a tripped stop serves every rollout flag's flag-off page", () => {
  beforeEach(resetAll);
  afterEach(() => { _setTestDbPlacesOverride(null); _setTestServiceClient(null); resetAll(); });

  it("B0. BYTE-IDENTITY: every flag OFF — tripped and clear serve the same bytes, with the same flag reads", async () => {
    for (const cat of ["for_you", "food"]) {
      resetAll();
      const clear = await page(world(), { category: cat });
      const clearReads = [...flagReads];
      resetAll(); trip();
      const tripped = await page(world(), { category: cat });
      assert.equal(norm(tripped), norm(clear), cat);
      // Other modules' own flag caches survive resetAll, so the second serve can read fewer; it must read nothing new.
      assert.deepEqual(flagReads.filter((f) => !clearReads.includes(f)), [], `${cat}: flag-off reads nothing new when tripped`);
    }
  });

  it("B1. every flag OFF, stop clear: the gate is never consulted — no manual-stop or arming read on a legacy serve", async () => {
    for (const cat of ["for_you", "food"]) {
      resetAll();
      await page(world(), { category: cat });
      assert.deepEqual(flagReads.filter((f) => f === "disable_discovery_pde" || f === "discovery_stop_enforcement_enabled"), [], cat);
    }
  });

  it("G1. 3455 ON + stop TRIPPED: serve points 5 then 4 are Compass's, byte-identical to 3455 OFF", async () => {
    const off5 = await page(world({ forYouPde: false }));
    const off4 = await page(world({ forYouPde: false }));
    assert.deepEqual(rankers(off5), ["compass"]);
    resetAll(); trip();
    const on5 = await page(world({ forYouPde: true }));
    const on4 = await page(world({ forYouPde: true }));
    assert.equal(norm(on5), norm(off5), "serve point 5");
    assert.equal(norm(on4), norm(off4), "serve point 4");
  });

  it("C1. CONTROL: 3455 ON + stop clear — the for_you page is PDE's", async () => {
    const on = await page(world({ forYouPde: true }));
    assert.deepEqual(rankers(on), ["pde"]);
  });

  it("G2. 3456 ON + stop TRIPPED: a signed-in Cache A hit (legacy mode) is the unranked flag-off page", async () => {
    _injectTestCacheEntry(CACHE_A_FOR_YOU, rows("for_you"));
    const off = await page(world({ cacheARanked: false }), { places: [] });
    assert.deepEqual(rankers(off), ["none"]);
    resetAll(); trip();
    _injectTestCacheEntry(CACHE_A_FOR_YOU, rows("for_you"));
    const on = await page(world({ cacheARanked: true }), { places: [] });
    assert.equal(on.cached, true);
    assert.equal(norm(on), norm(off));
  });

  it("C2. CONTROL: 3456 ON + stop clear — the same hit is ranked for the viewer", async () => {
    _injectTestCacheEntry(CACHE_A_FOR_YOU, rows("for_you"));
    const on = await page(world({ cacheARanked: true }), { places: [] });
    assert.deepEqual(rankers(on), ["pde"]);
  });

  it("G5. the manual stop: disable_discovery_pde TRUE halts 3455 and 3456 as a tripped condition does", async () => {
    const off = await page(world());
    resetAll();
    const on = await page(world({ forYouPde: true, killSwitch: true }));
    assert.equal(norm(on), norm(off), "3455");
    resetAll();
    _injectTestCacheEntry(CACHE_A_FOR_YOU, rows("for_you"));
    const offA = await page(world(), { places: [] });
    resetAll();
    _injectTestCacheEntry(CACHE_A_FOR_YOU, rows("for_you"));
    const onA = await page(world({ cacheARanked: true, killSwitch: true }), { places: [] });
    assert.equal(norm(onA), norm(offA), "3456");
  });

  it("G6. legacy mode, 3456 ON, stop ARMED: the gate measures 3391's conditions itself, and an RLS deviation halts 3456", async () => {
    rpcBody = { rls_leak: { state: "measured", deviations: 1, detail: ["discovery_places: anon insert"] } };
    _injectTestCacheEntry(CACHE_A_FOR_YOU, rows("for_you"));
    await page(world({ cacheARanked: true, armed: true }), { places: [] });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(evaluateStopConditions().tripped.includes("rls_leak"),
      "the measurement ran although the engine mode is legacy (the resolver never refreshes in legacy)");
    invalidateOnePipelineFlagCache();
    _injectTestCacheEntry(CACHE_A_FOR_YOU, rows("for_you"));
    const halted = await page(world({ cacheARanked: true, armed: true }), { places: [] });
    assert.deepEqual(rankers(halted), ["none"]);
  });
});

// ── §78 and §85: the readers every ranking call goes through ─────────────────

const pdePlaces = (): PdePlace[] => Array.from({ length: 8 }, (_, i) => ({
  id: `node/${900 + i}`, category: ["food", "nightlife", "culture"][i % 3]!, distanceKm: i / 2, savedCount: i, tags: i % 2 ? ["rooftop"] : ["local"],
}));
const pdeViewer = (): PdeViewer => ({
  userId: USER, city: "miami", followedIds: new Set(), interestTags: new Set(["rooftop"]),
  seenIds: new Set(), placeAffinities: {}, degraded: [], neighborhood: null,
});
const outcomeBytes = (o: Awaited<ReturnType<typeof rankForViewer>>) => JSON.stringify({
  ranked: o.ranked.map((p) => p.id),
  scored: [...o.scoredById].map(([id, s]) => [id, s.features, s.score]),
  stages: o.stages,
}, (k, v) => (/timings|Ms$/.test(k) ? undefined : v));

async function rankWith(flags: string[], tripped: boolean) {
  resetAll();
  if (tripped) trip();
  const db = makeFakeCandidateDb({ feature_flags: flags.map((f) => flagRow(f, true)), rank_events: [] });
  return rankForViewer(pdePlaces(), pdeViewer(), { sc: db, served: false, intentMode: "right_now" });
}

describe("§97 — §78's design flags read OFF while the stop is tripped", () => {
  afterEach(resetAll);
  const DESIGNS = ["discovery_surface_objectives_enabled", "discovery_intent_term_enabled"];

  it("G3a. rankForViewer with 3450 + 3453 ON and the stop TRIPPED scores exactly as with no design flag", async () => {
    const off = await rankWith([], false);
    const on = await rankWith(DESIGNS, true);
    assert.equal(outcomeBytes(on), outcomeBytes(off));
  });

  it("C3a. CONTROL: stop clear — the designs run (intentMatch scored, stages.rankDesigns recorded)", async () => {
    const on = await rankWith(DESIGNS, false);
    assert.deepEqual(on.stages.rankDesigns, { degraded: [] });
    assert.ok([...on.scoredById.values()].every((s) => typeof s.features["intentMatch"] === "number"));
  });

  it("G3b. the one reader: loadRankDesignFlags answers ALL OFF while tripped, and the real flags once clear", async () => {
    const db = makeFakeCandidateDb({ feature_flags: DESIGNS.map((f) => flagRow(f, true)) });
    trip();
    assert.deepEqual(await loadRankDesignFlags(db), ALL_RANK_DESIGN_FLAGS_OFF);
    _resetStopConditionsForTest();
    const clear = await loadRankDesignFlags(db);
    assert.equal(clear.objectives.enabled, true, "the stop is not a latch: clear again, the flags read as set");
    assert.equal(clear.intent.enabled, true);
  });

  it("G3c. Pulse's objective (3450) and DRS's negative-feedback input (3452) read OFF while tripped", async () => {
    const db = makeFakeCandidateDb({
      feature_flags: [flagRow("discovery_surface_objectives_enabled", true), flagRow("discovery_feature_families_enabled", true)],
      rank_events: [{ user_id: USER, item_id: "place-1", outcome: "dismiss", surface: "discovery", served_at: new Date().toISOString() }],
    });
    trip();
    assert.deepEqual(await surfaceObjectiveOptions(db, "pulse"), {});
    const inputs = [{ itemId: "place-1", viewerHasHiddenItem: false }] as unknown as RankingInput[];
    const out = await withDiscoveryNegativeFeedback(inputs, "discovery", { viewerId: USER } as never, db as never);
    assert.equal(out, inputs, "the same array, unread, as with 3452 off");
  });

  it("C3c. CONTROL: stop clear — Pulse ranks on its own objective", async () => {
    const db = makeFakeCandidateDb({ feature_flags: [flagRow("discovery_surface_objectives_enabled", true)] });
    assert.ok("objective" in (await surfaceObjectiveOptions(db, "pulse")));
  });
});

describe("§97 — §85's pipeline flags read OFF while the stop is tripped", () => {
  afterEach(() => { _setTestServiceClient(null); resetAll(); });
  const STAGES = ["discovery_candidate_sources_enabled", "discovery_output_kinds_enabled", "discovery_integrity_stage_enabled"];

  it("G4a. loadPipelineFlags answers ALL OFF while tripped, and the real flags once clear", async () => {
    const db = makeFakeCandidateDb({ feature_flags: STAGES.map((f) => flagRow(f, true)) });
    trip();
    assert.deepEqual(await loadPipelineFlags(db), { ...PIPELINE_FLAGS_OFF });
    _resetStopConditionsForTest();
    const clear = await loadPipelineFlags(db);
    assert.equal(clear.candidateSources, true);
    assert.equal(clear.outputKinds, true);
  });

  it("G4b. rankForViewer with 3480 + 3483 ON and the stop TRIPPED is the flags-off ranking", async () => {
    const off = await rankWith([], false);
    const on = await rankWith(STAGES, true);
    assert.equal(outcomeBytes(on), outcomeBytes(off));
  });

  const kinds = async (on: boolean) => {
    const db = makeFakeCandidateDb({
      feature_flags: on ? [flagRow("discovery_output_kinds_enabled", true)] : [],
      trails: [], profiles: [{ id: USER, account_status: "active" }], rank_events: [],
    });
    const client = Object.assign(db, { auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "invalid token" } }) } });
    _setTestServiceClient(client as never); _setTestClient(client, true);
    const res = await realFetch(`${url}/v1/discovery/recommendations/trails?destination=Miami`, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: await res.text(), trailsRead: db.reads.some((r) => r.table === "trails") };
  };

  it("G4c. the output-kinds route: flag ON + stop TRIPPED answers exactly its flag-off 404, and reads no Trail", async () => {
    const off = await kinds(false);
    assert.equal(off.status, 404);
    resetAll(); trip();
    const on = await kinds(true);
    assert.deepEqual(on, off);
  });

  it("C4c. CONTROL: flag ON + stop clear — the route serves", async () => {
    const on = await kinds(true);
    assert.equal(on.status, 200, on.body);
  });
});
