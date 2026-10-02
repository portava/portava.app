/**
 * census-discovery §63 (DV-52 b, §62.7 hunk H3) — a SERVED Discovery page records
 * the graph reading its ranking consumed, and that record is provenance only.
 *
 * `05` §9: the graph is useful when "it remains explainable enough for
 * debugging". §62 put the reading on `stages.graphReading` inside the engine,
 * but the two SERVED `rankForViewer` calls in routes/discovery.ts (cache-A in
 * engine mode `pde`, serve points 1/2/3; the signed-in cold fetch, serve point
 * 6) dropped `stages`, so a served row could not say which city-confidence
 * reading ordered it — and `compass_city_confidence` is overwritten daily.
 * Now each served row's `features` carries six keys, classified in
 * DISCOVERY_FEATURE_KEY_CLASSES so DV-39's screen keeps them:
 *   graphDepth, graphTier, graphSource, graphComputedAt, momentumScale,
 *   explorationBudgetPct.
 *
 * ABSENT, NOT NULL, WITH THE MODIFIERS OFF. `discovery_ranking_modifiers_enabled`
 * (2289) is seeded FALSE, and with it off `stages.graphReading` is not assigned,
 * so the six keys are not written at all: a flags-off row is byte-for-byte the
 * row it was. With the modifiers ON all six are written; a field the reading
 * lacks (no confidence record, or an unreadable one — the loader cannot tell
 * them apart, and both mean THIN) is JSON null, beside the thin scale and budget
 * it produced.
 *
 * GOLDEN. `fixtures/discoveryServedGraphReadingGolden.json` was captured by THIS
 * file (P16_CAPTURE_GOLDEN=1) on tree 7c083b524 — routes/discovery.ts and
 * lib/discoveryRecommendationRecord.ts as they were BEFORE §63 — with the clock
 * frozen at FIXED_NOW, so the ranker's time terms are fixed. Normalised away:
 * the per-request ids (`recommendationId`, `serveId`, the response's
 * recommendation/exposure/servedAt/sessionId keys — minted from a random session
 * id, and pinned by the telemetry suites) and `meta.timings`. Nothing else.
 *
 *   H1  modifiers OFF (flag absent, and flag FALSE): the served order, the
 *       response bytes, every logged row's features and the per-request
 *       context hash are the pre-§63 golden exactly; none of the six keys exists
 *   H2  modifiers ON with a confidence record: order, response and every other
 *       feature byte are the pre-§63 golden; the six keys carry the reading
 *   H3  modifiers ON, no record / an UNREADABLE record: the four record fields
 *       are null (never a confident zero), scale and budget are the thin ones
 *   H4  the cold fetch (serve point 6), off and on: the same two properties
 *   H5  the storage screen keeps the six keys: none is refused and none is a
 *       position (the governor's own per-item keys stay refused, as before)
 *   H6  the helper itself: no key without a reading; nulls kept; nothing extra
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryServedGraphReading.test.ts
 */
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import express from "express";
import pino from "pino";
import discoveryRouter, {
  _injectTestCacheEntry, _clearTestCacheEntry, _clearTestCompassCache, servedGraphReadingFeatures,
} from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { invalidateServeLogFlagCache, SERVE_REQUEST_RPC } from "../lib/discoveryServeLog.js";
import { invalidateCandidateProjectionFlagCache } from "../lib/discoveryCandidate.js";
import { invalidateLiveRankFlagCache } from "../lib/discoveryLiveRankRead.js";
import { invalidateDiscoveryModifiersFlagCache, cityConfidenceInputs } from "../lib/discoveryModifiers.js";
import { _resetStopConditionsForTest } from "../lib/discoveryStopConditions.js";
import { featureKeyClass } from "../lib/discoveryRecommendationRecord.js";
import { worldClient, flag, overpassBody, type WorldState } from "./helpers/fakeDiscoveryWorld.js";
import {
  legacyWorld, osmCached, normalise, LEGACY_TOKEN as TOK, CACHE_A_FOR_YOU,
} from "./helpers/discoveryLegacyScenarios.js";

const GOLDEN_URL = new URL("./fixtures/discoveryServedGraphReadingGolden.json", import.meta.url);
const FIXED_NOW = Date.parse("2026-09-27T12:00:00.000Z");
const Q = "destination=Miami&lat=25.77&lng=-80.19&radiusKm=10";
const CACHE_A_PATH = `/discovery?${Q}&category=for_you`;
const COLD_PATH = `/discovery?${Q}&category=food`;
const GRAPH_KEYS = ["graphDepth", "graphTier", "graphSource", "graphComputedAt", "momentumScale", "explorationBudgetPct"] as const;

/** A `compass_city_confidence` row as the baseline declares it (city, depth_score, tier, signals, computed_at). */
const CONFIDENCE = { city: "miami", depth_score: 72, tier: "deep", signals: { posts: 40 }, computed_at: "2026-09-27T03:00:00.000Z" };

interface Scenario {
  path: string;
  /** undefined ⇒ no flag row (the production default); a boolean ⇒ a row with that value. */
  modifiers?: boolean;
  confidence?: Record<string, unknown>;
  confidenceUnreadable?: boolean;
}

interface Capture {
  status: number;
  ids: string[];
  body: unknown;
  /** Every rank_events impression row the serve wrote: item, position, features (ids normalised away). */
  rows: Array<{ item_id: string; position: number; features: Record<string, unknown> }>;
  /** The per-request row's `context_hash` — a digest of the screened context. */
  contextHash: string | null;
}

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

const withoutIds = (f: Record<string, unknown>) => {
  const { recommendationId: _r, serveId: _s, featureVersion: _fv, rankedAt: _ra, sourceWindow: _sw, momentumProvenance: _mp, ...rest } = f;  // §75 (H-P21-2): the four PDE provenance keys are compared apart, at the foot — every OTHER byte stays the pre-§63 golden
  return rest;
};

async function serve(sc: Scenario): Promise<Capture & { world: WorldState; rawRows: any[] }> {
  resetCaches();
  const w = legacyWorld();
  w.tables.feature_flags!.push(
    flag("discovery_serve_log_enabled", true),
    flag("DISCOVERY_ENGINE_MODE", true, { mode: "pde", cohort: { kind: "all" } }),
    flag("disable_discovery_pde", false),
  );
  if (sc.modifiers !== undefined) w.tables.feature_flags!.push(flag("discovery_ranking_modifiers_enabled", sc.modifiers));
  w.tables.compass_city_confidence = sc.confidence ? [sc.confidence] : [];
  w.tables.intel_coverage_snapshots = [];
  if (sc.confidenceUnreadable) w.errorTables.add("compass_city_confidence");
  const c = worldClient(w);
  _setTestServiceClient(c as any);
  _setTestClient(c as any, true);
  if (sc.path === CACHE_A_PATH) _injectTestCacheEntry(CACHE_A_FOR_YOU, osmCached());
  overpassOn = sc.path === COLD_PATH;

  const res = await realFetch(`${base}${sc.path}`, { headers: { authorization: `Bearer ${TOK}` } });
  const body = await res.json() as any;
  const ids = ((body.places ?? []) as any[]).map((p) => p.id);
  await waitFor(() => w.writes.some((x) => x.table === "rank_events") && w.writes.some((x) => x.table === `rpc:${SERVE_REQUEST_RPC}`));
  await new Promise((r) => setTimeout(r, 50));
  // The IMPRESSION rows (one batch per serve). The DRS analytics events the ranked
  // path also inserts into rank_events carry no `features` and are not the record.
  const rawRows = w.writes.filter((x) => x.table === "rank_events" && x.op === "insert" && Array.isArray(x.payload))
    .flatMap((x) => x.payload as any[]).filter((r) => r.outcome === "impression");
  const req = w.writes.find((x) => x.table === `rpc:${SERVE_REQUEST_RPC}`)?.payload as any;
  return {
    status: res.status, ids, body: normalise(body), world: w, rawRows,
    rows: rawRows.map((r) => ({ item_id: r.item_id, position: r.position, features: withoutIds(r.features) })),
    contextHash: req?.p_row?.context_hash ?? null,
  };
}

const SCENARIOS: Record<string, Scenario> = {
  "cacheA.off.absent":      { path: CACHE_A_PATH },
  "cacheA.off.false":       { path: CACHE_A_PATH, modifiers: false },
  "cacheA.on.record":       { path: CACHE_A_PATH, modifiers: true, confidence: CONFIDENCE },
  "cacheA.on.noRecord":     { path: CACHE_A_PATH, modifiers: true },
  "cacheA.on.unreadable":   { path: CACHE_A_PATH, modifiers: true, confidence: CONFIDENCE, confidenceUnreadable: true },
  "cold.off.absent":        { path: COLD_PATH },
  "cold.on.record":         { path: COLD_PATH, modifiers: true, confidence: CONFIDENCE },
};

const captured: Record<string, Capture & { world: WorldState; rawRows: any[] }> = {};
let golden: Record<string, Capture> = {};

before(async () => {
  mock.timers.enable({ apis: ["Date"], now: FIXED_NOW });
  server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(discoveryRouter));
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
  for (const [name, sc] of Object.entries(SCENARIOS)) captured[name] = await serve(sc);
  if (process.env["P16_CAPTURE_GOLDEN"] === "1") {
    const out: Record<string, Capture> = {};
    for (const [name, c] of Object.entries(captured)) out[name] = { status: c.status, ids: c.ids, body: c.body, rows: c.rows, contextHash: c.contextHash };
    writeFileSync(GOLDEN_URL, JSON.stringify(out, null, 2) + "\n");
  }
  golden = JSON.parse(readFileSync(GOLDEN_URL, "utf8"));
});

after(async () => {
  globalThis.fetch = realFetch;
  resetCaches();
  _setTestServiceClient(null);
  mock.timers.reset();
  await new Promise<void>((r) => server.close(() => r()));
});

/** The scenario's rows with the six graph keys removed — what the pre-§63 tree wrote. */
const minusGraphKeys = (rows: Capture["rows"]) =>
  rows.map((r) => ({ ...r, features: Object.fromEntries(Object.entries(r.features).filter(([k]) => !(GRAPH_KEYS as readonly string[]).includes(k))) }));

function assertPreconditions(name: string, c: Capture): void {
  assert.equal(c.status, 200, `${name}: ${JSON.stringify(c.body).slice(0, 300)}`);
  assert.ok(c.ids.length >= 3, `${name}: precondition — a page was served`);
  assert.ok(c.rows.length >= 3, `${name}: precondition — the serve logged its impressions (without rows every 'absent' below is vacuous)`);
  assert.ok(c.rows.every((r) => r.features["rankedInRequest"] === true), `${name}: precondition — these are RANKED serves`);
}

describe("H1 — modifiers OFF: nothing the pre-§63 tree wrote or served moves (census-discovery §63, DV-52 b)", () => {
  for (const name of ["cacheA.off.absent", "cacheA.off.false"]) {
    it(`${name}: order, response, row features and context hash are the golden, and no graph key exists`, () => {
      const c = captured[name]!;
      assertPreconditions(name, c);
      assert.deepEqual(c.ids, golden[name]!.ids, "the served ORDER");
      assert.deepEqual(c.body, golden[name]!.body, "the response");
      assert.deepEqual(c.rows, golden[name]!.rows, "every logged row, byte for byte");
      assert.equal(c.contextHash, golden[name]!.contextHash, "the per-request context digest");
      for (const r of c.rawRows) for (const k of GRAPH_KEYS) assert.ok(!(k in r.features), `${name}: ${k} was written with the modifiers off`);
    });
  }
  it("flag absent and flag FALSE are the same serve", () => {
    assert.deepEqual(captured["cacheA.off.absent"]!.rows, captured["cacheA.off.false"]!.rows);
    assert.deepEqual(captured["cacheA.off.absent"]!.body, captured["cacheA.off.false"]!.body);
  });
});

describe("H2 — modifiers ON with a confidence record: the row names the reading, and nothing else moved", () => {
  const name = "cacheA.on.record";
  it("the order, the response and every other feature byte are the pre-§63 golden", () => {
    const c = captured[name]!;
    assertPreconditions(name, c);
    assert.deepEqual(c.ids, golden[name]!.ids, "the served ORDER");
    assert.deepEqual(c.body, golden[name]!.body, "the response");
    assert.deepEqual(minusGraphKeys(c.rows), golden[name]!.rows, "every other feature, byte for byte");
  });
  it("every served row carries the six keys, with the reading the modifiers consumed", () => {
    const c = captured[name]!;
    const expected = { ...cityConfidenceInputs({ depthScore: 72 } as any) };
    for (const r of c.rawRows) {
      assert.deepEqual(Object.fromEntries(GRAPH_KEYS.map((k) => [k, r.features[k]])), {
        graphDepth: 72, graphTier: "deep", graphSource: "compass_graph", graphComputedAt: "2026-09-27T03:00:00.000Z",
        momentumScale: expected.momentumScale, explorationBudgetPct: expected.explorationBudgetPct,
      }, `row ${r.item_id}`);
    }
  });
  it("the per-request row's context digest now covers the reading — ON only (stated, because it is the one other byte that moves)", () => {
    // logImpression screens the same context into the per-request row
    // (`recommendations.context_hash`, a digest of the screened request context),
    // so two serves under different readings no longer share a digest. OFF is
    // pinned unchanged in H1.
    assert.notEqual(captured[name]!.contextHash, golden[name]!.contextHash);
    assert.match(String(captured[name]!.contextHash), /^[A-Za-z0-9_-]{22}$/, "still 3376's CHECK shape");
  });
  it("the modifiers really ran: the ON golden differs from the OFF golden in order or features (H2 is not the OFF serve relabelled)", () => {
    const on = golden[name]!, off = golden["cacheA.off.absent"]!;
    assert.ok(JSON.stringify(on.rows) !== JSON.stringify(off.rows) || JSON.stringify(on.ids) !== JSON.stringify(off.ids));
  });
});

describe("H3 — modifiers ON, no usable record: absent is recorded as absent, never as a confident zero", () => {
  for (const name of ["cacheA.on.noRecord", "cacheA.on.unreadable"]) {
    it(`${name}: the four record fields are null; scale and budget are the THIN ones; order and other bytes are the golden`, () => {
      const c = captured[name]!;
      assertPreconditions(name, c);
      assert.deepEqual(c.ids, golden[name]!.ids);
      assert.deepEqual(minusGraphKeys(c.rows), golden[name]!.rows);
      const thin = cityConfidenceInputs(null);
      for (const r of c.rawRows) {
        assert.deepEqual(Object.fromEntries(GRAPH_KEYS.map((k) => [k, r.features[k]])), {
          graphDepth: null, graphTier: null, graphSource: null, graphComputedAt: null,
          momentumScale: thin.momentumScale, explorationBudgetPct: thin.explorationBudgetPct,
        }, `row ${r.item_id}`);
      }
    });
  }
  it("PAIR: the record, readable, is recorded (so the nulls above are the failure's, not the fixture's)", () => {
    assert.equal(captured["cacheA.on.record"]!.rawRows[0].features.graphDepth, 72);
  });
});

describe("H4 — the cold fetch (serve point 6) records the same way", () => {
  it("off: the golden exactly, and no graph key", () => {
    const c = captured["cold.off.absent"]!;
    assertPreconditions("cold.off.absent", c);
    assert.deepEqual(c.ids, golden["cold.off.absent"]!.ids);
    assert.deepEqual(c.body, golden["cold.off.absent"]!.body);
    assert.deepEqual(c.rows, golden["cold.off.absent"]!.rows);
    assert.equal(c.contextHash, golden["cold.off.absent"]!.contextHash);
    for (const r of c.rawRows) for (const k of GRAPH_KEYS) assert.ok(!(k in r.features), k);
  });
  it("on: order, response and other bytes are the golden, and every row names the reading", () => {
    const c = captured["cold.on.record"]!;
    assertPreconditions("cold.on.record", c);
    assert.deepEqual(c.ids, golden["cold.on.record"]!.ids);
    assert.deepEqual(c.body, golden["cold.on.record"]!.body);
    assert.deepEqual(minusGraphKeys(c.rows), golden["cold.on.record"]!.rows);
    for (const r of c.rawRows) {
      assert.equal(r.features.graphDepth, 72);
      assert.equal(r.features.graphComputedAt, "2026-09-27T03:00:00.000Z");
      assert.equal(r.features.graphSource, "compass_graph");
    }
  });
});

describe("H5 — DV-39's screen keeps the six keys", () => {
  it("each is classified derived_ranking_signal, none is a position, and no served row refuses one", () => {
    for (const k of GRAPH_KEYS) assert.equal(featureKeyClass(k), "derived_ranking_signal", k);
    for (const name of Object.keys(SCENARIOS)) {
      for (const r of captured[name]!.rawRows) {
        const refused: string[] = r.features.privacyRefused ?? [];
        for (const k of GRAPH_KEYS) assert.ok(!refused.includes(k), `${name}: ${k} was refused by the storage screen`);
      }
    }
  });
  it("what the screen refused before §63 it still refuses: the governor's per-item keys (a residual, not this hunk's)", () => {
    // With the modifiers ON the governor stamps governorApplied / governorBudgetPct /
    // governorSlot / governor_* on its items; DV-39 classifies none of them, so the
    // screen refuses them BY NAME and records `privacyRefused` — pre-§63 and now.
    // The golden comparisons above include `privacyRefused`, so this hunk cannot
    // have changed it; this line only makes the residual visible.
    const refused = new Set(captured["cacheA.on.record"]!.rawRows.flatMap((r) => (r.features.privacyRefused ?? []) as string[]));
    assert.ok(refused.has("governorBudgetPct"), `the governor residual moved: ${[...refused].join(",")}`);
    assert.ok(captured["cacheA.off.absent"]!.rawRows.every((r) => !("privacyRefused" in r.features)), "with the modifiers off nothing is refused");
  });
});

describe("H6 — servedGraphReadingFeatures, directly", () => {
  it("no stages, or stages without a reading (the modifiers off): no key at all", () => {
    assert.deepEqual(servedGraphReadingFeatures(null), {});
    assert.deepEqual(servedGraphReadingFeatures(undefined), {});
    assert.deepEqual(servedGraphReadingFeatures({}), {});
  });
  it("a reading: the six keys, copied; its nulls stay null; its city and sourceReason are not copied", () => {
    const out = servedGraphReadingFeatures({ graphReading: {
      city: "miami", depthScore: null, tier: null, source: null, sourceReason: "platform_unreadable",
      computedAt: null, momentumScale: 0.5, explorationBudgetPct: 20,
    } });
    assert.deepEqual(out, { graphDepth: null, graphTier: null, graphSource: null, graphComputedAt: null, momentumScale: 0.5, explorationBudgetPct: 20 });
    assert.deepEqual(Object.keys(out), [...GRAPH_KEYS]);
  });
});

// ── census-discovery §75 (DC-17, lane P33, H-P21-2): the vector's own provenance ─
//
// Every PDE-ranked row now carries four record keys beside `modelVersion`:
// `featureVersion`, `rankedAt` (the rank clock), `sourceWindow`, and — only when
// momentum was an input, i.e. the modifiers ran — `momentumProvenance`. They are
// stripped by `withoutIds` above, so every golden comparison in this file still
// proves that nothing ELSE a row, the response or the context digest carries
// moved. Here they are asserted on their own. Appended at the foot so the cited
// lines above do not move.
import { DISCOVERY_PDE_FEATURE_VERSION } from "../lib/discoveryRankProvenance.js";
import { LOCAL_MOMENTUM_MODEL_VERSION, LOCAL_MOMENTUM_FEATURE_VERSION, MOMENTUM_BASELINE_WINDOW_MS } from "../lib/discoveryLocalMomentum.js";

describe("§75 H-P21-2 — a PDE row names its feature version, its rank clock, its window and the momentum input's record", () => {
  for (const name of Object.keys(SCENARIOS)) {
    it(`${name}: every ranked row carries the four facts; the momentum record exactly when the modifiers ran`, () => {
      const c = captured[name]!;
      assertPreconditions(name, c);
      const on = SCENARIOS[name]!.modifiers === true;
      for (const r of c.rawRows) {
        const f = r.features;
        assert.equal(f.featureVersion, DISCOVERY_PDE_FEATURE_VERSION);
        assert.equal(f.rankedAt, FIXED_NOW, "the rank clock — the ranker ran under the frozen clock, and it is not the serve clock's string");
        assert.deepEqual(f.sourceWindow, { kind: "unbounded_start", startMs: null, endMs: f.rankedAt }, "one clock, so the window cannot drift from it");
        assert.equal(f.modelVersion, "portava-rank-pde-2026-09", "beside §48's model version");
        if (!on) { assert.ok(!("momentumProvenance" in f), `${name}: momentum was not an input, so no momentum record`); continue; }
        assert.deepEqual(f.momentumProvenance, {
          modelVersion: LOCAL_MOMENTUM_MODEL_VERSION, featureVersion: LOCAL_MOMENTUM_FEATURE_VERSION, computedAt: FIXED_NOW,
          window: { kind: "bounded", startMs: FIXED_NOW - MOMENTUM_BASELINE_WINDOW_MS, endMs: FIXED_NOW },
        }, `${name}: the momentum input's own window, versions and computation clock`);
        for (const k of ["featureVersion", "rankedAt", "sourceWindow", "momentumProvenance"]) assert.ok(!((f.privacyRefused ?? []) as string[]).includes(k), `${name}: the screen refused ${k}`);  // the governor keys it refused before §63 it still refuses (H5)
      }
    });
  }
  it("each of the four keys is classified record_metadata, and none is a position", () => {
    for (const k of ["featureVersion", "rankedAt", "sourceWindow", "momentumProvenance"]) assert.equal(featureKeyClass(k), "record_metadata", k);
  });
});
