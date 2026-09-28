/**
 * census-discovery §93 (lane W11-X1) — DV-31 on the page: hunk H-W10R1-1
 * (§84.5), the rediscovery retest called from `rankForViewer`, proven through
 * the real serve path (signed-in GET /discovery, engine mode `pde`, Cache A),
 * in the shape of discoveryServePathIsolation.
 *
 *   Q0  FLAG-OFF GOLDEN: with the modifiers on and the v2 model on, the
 *       served page and its impression rows are identical whether 3475's
 *       `discovery_trend_rediscovery_retest_enabled` is ABSENT or FALSE, and
 *       they hash to the golden captured at 3cc027a06, BEFORE the hunk.
 *   Q1  FLAG ON with a v2 pool: the cooled place moves to the middle slot —
 *       the flag-off page, permuted by exactly that one move — and ONLY its
 *       served impression row stores `rediscoveryRetest: 1` (DV-39's screen
 *       keeps it). The top slot is not touched.
 *   Q2  FLAG ON without the v2 model: no pool, so the page is the flag-off page.
 *   Q3  FLAG ON with the modifiers OFF (production today): the retest never
 *       runs, and the retest flag is not even read.
 *
 * With the modifiers off, §47's L0 and §85's P1–P3 goldens (run unchanged)
 * hold every flag-off byte; Q3 shows why this hunk cannot move them.
 *
 * CONTROLLED DATA ONLY; nothing here is production evidence.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryRediscoveryRetestServe.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import express from "express";
import pino from "pino";
import discoveryRouter, { _injectTestCacheEntry, _clearTestCacheEntry, _clearTestCompassCache } from "../routes/discovery.js";
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
import { _resetLocalMomentumCacheForTest } from "../lib/discoveryLocalMomentum.js";
import { applyRediscoveryRetest } from "../lib/discoveryTrendRediscovery.js";
import { worldClient, flag, type WorldState } from "./helpers/fakeDiscoveryWorld.js";
import { legacyWorld, osmCached, LEGACY_TOKEN as TOK, CACHE_A_FOR_YOU } from "./helpers/discoveryLegacyScenarios.js";

const PATH = "/discovery?destination=Miami&lat=25.77&lng=-80.19&radiusKm=10&category=for_you";
const RETEST_FLAG = "discovery_trend_rediscovery_retest_enabled";
const H = 3_600_000;
/** The one place the evidence below makes a v2 `cooling` reading. */
const COOLED = "node/1";

/**
 * sha256 of Q0's flag-off page — served ids in order, then each served
 * impression's item and ranking features (the clock-bound provenance keys
 * dropped) — captured at 3cc027a06 with `discoveryPde.ts` BEFORE the hunk.
 */
const FLAG_OFF_GOLDEN = "77d378a68886743b85be7268ecbf69762ffdc5800f5b1f032203daa76c433a85";

const realFetch = globalThis.fetch;
let server: Server;
let base = "";

function resetCaches(): void {
  _clearTestCompassCache();
  _clearTestCacheEntry(CACHE_A_FOR_YOU);
  invalidateDiscoveryEngineModeCache();
  invalidateFlagsCache();
  invalidateServeLogFlagCache();
  invalidateCandidateProjectionFlagCache();
  invalidateLiveRankFlagCache();
  invalidateDiscoveryModifiersFlagCache();
  invalidateOnePipelineFlagCache();
  invalidateRankDesignFlagCache();
  _resetLocalMomentumCacheForTest();
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

/** `02` §9.5's cooled place, as discoveryTrendOps R4 builds it: a confirmed middle window, a quieter recent one. */
function coolingEvidence(itemId: string, nowMs: number): Record<string, unknown>[] {
  const ev: Record<string, unknown>[] = [];
  const t = (h: number) => new Date(nowMs - h * H).toISOString();
  let n = 0;
  const row = (r: Record<string, unknown>) => ev.push({ id: `ev-${++n}`, surface: "discovery", item_id: itemId, ...r });
  for (let i = 0; i < 40; i++) row({ outcome: "impression", served_at: t(1 + i * 0.5), outcome_at: null, user_id: `v${i}` });
  for (let i = 0; i < 3; i++) row({ outcome: "tap", served_at: t(2 + i), outcome_at: t(1.9 + i), user_id: `r${i}` });
  for (let i = 0; i < 40; i++) row({ outcome: "impression", served_at: t(50 + i * 2), outcome_at: null, user_id: `w${i}` });
  for (let i = 0; i < 12; i++) row({ outcome: "save", served_at: t(60 + i * 4), outcome_at: t(59.9 + i * 4), user_id: `m${i}` });
  return ev;
}

interface Served { status: number; ids: string[]; rows: Array<{ item_id: string; features: Record<string, unknown> }>; world: WorldState; body: any; flagsRead: string[] }

/** The world's client, recording every flag name a `feature_flags` read names (eq or in on `flag`). */
function spyFlagReads(c: any, seen: string[]): any {
  const wrap = (b: any): any => new Proxy(b, {
    get(o, prop) {
      const v = o[prop];
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if ((prop === "eq" || prop === "in") && args[0] === "flag") seen.push(...(Array.isArray(args[1]) ? args[1] : [args[1]]).map(String));
        const r = v.apply(o, args);
        return r === o ? wrap(o) : r;
      };
    },
  });
  return { ...c, from: (t: string) => (t === "feature_flags" ? wrap(c.from(t)) : c.from(t)) };
}

async function serve(flags: ReturnType<typeof flag>[], opts: { evidence?: boolean } = {}): Promise<Served> {
  resetCaches();
  const w = legacyWorld();
  w.tables.feature_flags!.push(
    flag("discovery_serve_log_enabled", true),
    flag("DISCOVERY_ENGINE_MODE", true, { mode: "pde", cohort: { kind: "all" } }),
    flag("disable_discovery_pde", false),
    ...flags,
  );
  w.tables.intel_coverage_snapshots = [];
  if (opts.evidence !== false) w.tables.rank_events!.push(...coolingEvidence(COOLED, Date.now()));
  const flagsRead: string[] = [];
  const c = spyFlagReads(worldClient(w), flagsRead);
  _setTestServiceClient(c);
  _setTestClient(c, true);
  _injectTestCacheEntry(CACHE_A_FOR_YOU, osmCached());
  const res = await realFetch(`${base}${PATH}`, { headers: { authorization: `Bearer ${TOK}` } });
  const body = await res.json() as any;
  const ids = ((body.places ?? []) as any[]).map((p) => p.id as string);
  await waitFor(() => w.writes.some((x) => x.table === "rank_events") && w.writes.some((x) => x.table === `rpc:${SERVE_REQUEST_RPC}`));
  await new Promise((r) => setTimeout(r, 50));
  const rows = w.writes.filter((x) => x.table === "rank_events" && x.op === "insert" && Array.isArray(x.payload))
    .flatMap((x) => x.payload as any[]).filter((r) => r.outcome === "impression")
    .map((r) => ({ item_id: r.item_id as string, features: r.features as Record<string, unknown> }));
  return { status: res.status, ids, rows, world: w, body, flagsRead };
}

/** The clock- and request-bound keys; everything else a served row stores is pinned. */
const VOLATILE = new Set(["rankedAt", "serveId", "recommendationId", "sourceWindow", "graphComputedAt", "momentumProvenance"]);
function digest(s: Served): string {
  const rows = [...s.rows].sort((a, b) => (a.item_id < b.item_id ? -1 : 1)).map((r) => ({
    item: r.item_id,
    features: Object.fromEntries(Object.entries(r.features).filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => (a < b ? -1 : 1))),
  }));
  return createHash("sha256").update(JSON.stringify({ ids: s.ids, rows })).digest("hex");
}

function assertServed(name: string, s: Served): void {
  assert.equal(s.status, 200, `${name}: ${JSON.stringify(s.body).slice(0, 300)}`);
  assert.ok(s.ids.length >= 4, `${name}: precondition — a page with a middle was served`);
  assert.ok(s.rows.length >= 4, `${name}: precondition — its impressions were logged`);
}

const MODIFIERS_V2 = [flag("discovery_ranking_modifiers_enabled", true), flag("discovery_trend_normalised_enabled", true)];

before(async () => {
  server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(discoveryRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  globalThis.fetch = (async (url: any, init?: any) => {
    const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
    if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
    return realFetch(url, init);
  }) as typeof globalThis.fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  resetCaches();
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});

describe("DV-31 on the page: the rediscovery retest, called from rankForViewer (H-W10R1-1)", () => {
  it("Q0 FLAG-OFF GOLDEN: absent and FALSE serve the same page and rows, and both hash as captured before the hunk", async () => {
    const absent = await serve(MODIFIERS_V2);
    const off = await serve([...MODIFIERS_V2, flag(RETEST_FLAG, false)]);
    assertServed("absent", absent);
    assertServed("off", off);
    assert.deepEqual(off.ids, absent.ids);
    assert.equal(digest(off), digest(absent));
    assert.equal(digest(off), FLAG_OFF_GOLDEN, `flag-off page moved: ${digest(off)} ${JSON.stringify(off.ids)}`);
    assert.ok(off.rows.every((r) => !("rediscoveryRetest" in r.features)), "flag off: no row carries the stamp");
  });

  it("Q1 FLAG ON with a v2 pool: the cooled place moves to the middle slot, and only its row is stamped", async () => {
    const off = await serve([...MODIFIERS_V2, flag(RETEST_FLAG, false)]);
    const on = await serve([...MODIFIERS_V2, flag(RETEST_FLAG, true)]);
    assertServed("off", off);
    assertServed("on", on);
    const from = off.ids.indexOf(COOLED);
    const slot = Math.max(1, Math.floor(off.ids.length / 2));
    assert.ok(from > slot, `precondition: the cooled place sits below the middle with the flag off (${from} of ${off.ids.length})`);
    const expected = applyRediscoveryRetest(off.ids, COOLED);
    assert.deepEqual(expected.retest, { id: COOLED, slot, fromIndex: from });
    assert.deepEqual(on.ids, expected.order, "exactly one move: the cooled place, to the middle");
    assert.equal(on.ids[0], off.ids[0], "the top slot stays the ranker's");
    const stamped = on.rows.filter((r) => r.features["rediscoveryRetest"] === 1).map((r) => r.item_id);
    assert.deepEqual(stamped, [COOLED], "the served impression row of the retested place stores the stamp; no other row does");
  });

  it("Q2 FLAG ON without the v2 model: there is no pool, so the page is the flag-off page", async () => {
    const v1 = [flag("discovery_ranking_modifiers_enabled", true)];
    const off = await serve([...v1, flag(RETEST_FLAG, false)]);
    const on = await serve([...v1, flag(RETEST_FLAG, true)]);
    assertServed("v1 on", on);
    assert.deepEqual(on.ids, off.ids);
    assert.ok(on.rows.every((r) => !("rediscoveryRetest" in r.features)));
  });

  it("Q3 FLAG ON with the modifiers OFF (production today): the retest never runs, and its flag is never read", async () => {
    const off = await serve([flag("discovery_trend_normalised_enabled", true)]);
    const on = await serve([flag("discovery_trend_normalised_enabled", true), flag(RETEST_FLAG, true)]);
    assertServed("modifiers off", on);
    assert.deepEqual(on.ids, off.ids);
    assert.ok(on.rows.every((r) => !("rediscoveryRetest" in r.features)));
    assert.ok(on.flagsRead.includes("discovery_ranking_modifiers_enabled"), "precondition: the spy sees flag reads");
    assert.equal(on.flagsRead.includes(RETEST_FLAG), false, "the retest flag is not read with the modifiers off");
  });
});
