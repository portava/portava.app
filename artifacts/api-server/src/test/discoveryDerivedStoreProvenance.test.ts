/**
 * discoveryDerivedStoreProvenance — census-discovery DC-17.
 *
 * THE ROW, AND ITS FAILING HALF
 * =============================
 * DC-17 grades whether a DERIVED STORE carries provenance about its own
 * computation. The two stores that actually compute over an EVENT WINDOW scored
 * 0 of 4:
 *
 *   lib/discoveryLocalMomentum  — a bare `number` per place id
 *   lib/discoveryTrendState     — a state plus three rates
 *
 * Both are read back and acted on — the momentum scalar becomes a capped
 * ranking contribution in portavaRank, the stage becomes an `03` §11 sentence —
 * and neither said which rows produced it, which shape computed it, or when. A
 * consumer holding either one could not tell a reading taken over a full 30-day
 * corpus from one taken over a truncated window, nor a fresh reading from a
 * ten-minute-old cached one, because both are the same shape.
 *
 * The four facts this file pins, per store:
 *
 *   window.startMs / window.endMs   the SOURCE EVENT WINDOW, in epoch ms
 *   featureVersion                  which feature shape computed it
 *   modelVersion                    which model shape computed it
 *   computedAt                      when the computation ran
 *
 * NO NEW VERSION VOCABULARY
 * =========================
 * The two version strings are `lib/discoveryRankProvenance`'s existing
 * `DISCOVERY_MODEL_VERSION` / `DISCOVERY_FEATURE_VERSION` — the constants `06`
 * §5's cache-metadata record already uses. A second pair minted here would let
 * a momentum reading and a ranked page claim different versions of the same
 * pipeline, which is worse than neither claiming one.
 *
 * AND NO NUMBER MOVES
 * ===================
 * The last describe is the guard that matters most: this row adds provenance
 * ABOUT a computation, so the computation's output must be byte-identical. The
 * golden maps below were captured from the tree before the change.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryDerivedStoreProvenance.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  computeLocalMomentum, loadLocalMomentum, readLocalTrendStates,
  _resetLocalMomentumCacheForTest,
  MOMENTUM_BASELINE_WINDOW_MS, MOMENTUM_CACHE_TTL_MS,
  type MomentumRow,
} from "../lib/discoveryLocalMomentum.js";
import { computeTrendStates, TREND_PRIOR_MS } from "../lib/discoveryTrendState.js";
import {
  DISCOVERY_MODEL_VERSION, DISCOVERY_FEATURE_VERSION,
  type DerivedStoreProvenance,
} from "../lib/discoveryRankProvenance.js";

const NOW  = Date.parse("2026-09-04T12:00:00Z");
const HOUR = 3_600_000;
const DAY  = 24 * HOUR;
const at = (deltaMs: number): string => new Date(NOW + deltaMs).toISOString();

const imp = (id: string, servedAt: string): MomentumRow =>
  ({ item_id: id, outcome: "impression", served_at: servedAt, outcome_at: null });
const conv = (id: string, outcome: string, servedAt: string, outcomeAt: string | null): MomentumRow =>
  ({ item_id: id, outcome, served_at: servedAt, outcome_at: outcomeAt });
const rep = (n: number, make: (i: number) => MomentumRow): MomentumRow[] =>
  Array.from({ length: n }, (_, i) => make(i));

/**
 * One corpus that exercises every one of `03` §9's six stages plus the momentum
 * floor, the saturation clamp and the analytics exclusion, so the golden below
 * is a real regression net and not a single happy path.
 */
const CORPUS: MomentumRow[] = [
  ...rep(5,  (i) => imp("p_surge", at(-i * HOUR))),
  ...rep(3,  (i) => conv("p_saved", "save", at(-i * HOUR), at(-i * HOUR))),
  ...rep(8,  (i) => imp("p_steady", at(-i * HOUR))),
  ...rep(20, (i) => imp("p_steady", at(-4 * DAY - i * HOUR))),
  ...rep(92, (i) => imp("p_steady", at(-20 * DAY - i * HOUR))),
  ...rep(8,  (i) => imp("p_back", at(-i * HOUR))),
  ...rep(40, (i) => imp("p_back", at(-20 * DAY - i * HOUR))),
  ...rep(8,  (i) => imp("p_old", at(-20 * DAY - i * HOUR))),
  ...rep(30, (i) => imp("p_trend", at(-i * HOUR))),
  ...rep(20, (i) => imp("p_trend", at(-4 * DAY - i * HOUR))),
  ...rep(92, (i) => imp("p_trend", at(-20 * DAY - i * HOUR))),
  ...rep(4,  (i) => imp("p_cool", at(-i * HOUR))),
  ...rep(60, (i) => imp("p_cool", at(-4 * DAY - i * HOUR))),
  ...rep(92, (i) => imp("p_cool", at(-20 * DAY - i * HOUR))),
  // Ranker bookkeeping, one row per CANDIDATE. Excluded by both modules;
  // present here so the golden would move if either stopped excluding it.
  ...rep(4,  (i) => ({ item_id: "p_noise", outcome: "analytics", served_at: at(-i * HOUR), outcome_at: null })),
];

/** Captured from the tree BEFORE provenance was added. Must never move. */
const GOLDEN_MOMENTUM: Record<string, number> = {
  p_surge: 0.833,
  p_saved: 1,
  p_back:  0.353,
  p_trend: 0.733,
};

/** Likewise: state + the three window rates, unchanged by this row. */
const GOLDEN_TRENDS: Record<string, { state: string; evidence: Record<string, number> }> = {
  p_surge:  { state: "emerging",     evidence: { recentRate: 5,  midRate: 0,  priorRate: 0,                  totalWeight: 5   } },
  p_saved:  { state: "emerging",     evidence: { recentRate: 12, midRate: 0,  priorRate: 0,                  totalWeight: 12  } },
  p_steady: { state: "established",  evidence: { recentRate: 8,  midRate: 8,  priorRate: 8,                  totalWeight: 120 } },
  p_back:   { state: "rediscovered", evidence: { recentRate: 8,  midRate: 0,  priorRate: 3.4782608695652173, totalWeight: 48  } },
  p_old:    { state: "unknown",      evidence: { recentRate: 0,  midRate: 0,  priorRate: 0.6956521739130435, totalWeight: 8   } },
  p_trend:  { state: "trending",     evidence: { recentRate: 30, midRate: 8,  priorRate: 8,                  totalWeight: 142 } },
  p_cool:   { state: "cooling",      evidence: { recentRate: 4,  midRate: 24, priorRate: 8,                  totalWeight: 156 } },
};

/** The four DC-17 facts, asserted in one place so no store can satisfy three. */
function assertFourFacts(
  p: DerivedStoreProvenance,
  expected: { startMs: number; endMs: number; computedAt: number },
  what: string,
): void {
  assert.equal(p.window.startMs, expected.startMs, `${what}: window start`);
  assert.equal(p.window.endMs,   expected.endMs,   `${what}: window end`);
  assert.equal(p.featureVersion, DISCOVERY_FEATURE_VERSION, `${what}: feature version`);
  assert.equal(p.modelVersion,   DISCOVERY_MODEL_VERSION,   `${what}: model version`);
  assert.equal(p.computedAt,     expected.computedAt, `${what}: computed-at`);
}

// ── Store 1 of 2: the momentum scalar ────────────────────────────────────────

describe("DC-17 — the momentum map says what computed it, over which window, when", () => {
  beforeEach(() => _resetLocalMomentumCacheForTest());

  it("carries all four facts beside the values, over the 30-day baseline window", () => {
    const m = computeLocalMomentum(CORPUS, NOW);
    assertFourFacts(
      m.provenance,
      { startMs: NOW - MOMENTUM_BASELINE_WINDOW_MS, endMs: NOW, computedAt: NOW },
      "computeLocalMomentum",
    );
  });

  it("the window is the one the arithmetic actually reads — a row outside it is not counted", () => {
    // The bounds are a CLAIM about which rows could have contributed. Pin it
    // against the module's own cutoff rather than trusting the label: a place
    // whose only activity sits one hour before window.startMs must be absent.
    const m = computeLocalMomentum([
      ...rep(9, (i) => imp("p_inside",  at(-i * HOUR))),
      ...rep(9, (i) => imp("p_outside", new Date(NOW - MOMENTUM_BASELINE_WINDOW_MS - HOUR - i * HOUR).toISOString())),
    ], NOW);
    assert.ok((m.values.p_inside ?? 0) > 0);
    assert.equal(m.values.p_outside, undefined, "a row before window.startMs is outside the declared window");
  });

  it("an empty result still says which window was considered — 'no surge' is a measurement", () => {
    // The whole DC-17 complaint: before this, "nothing found" and "nothing read"
    // were the same value. Now the empty map still carries its window.
    const m = computeLocalMomentum([], NOW);
    assert.deepEqual({ ...m.values }, {});
    assertFourFacts(
      m.provenance,
      { startMs: NOW - MOMENTUM_BASELINE_WINDOW_MS, endMs: NOW, computedAt: NOW },
      "empty momentum map",
    );
  });

  it("the loader stamps the same provenance the pure function does", async () => {
    const f = fakeClient(CORPUS);
    const loaded = await loadLocalMomentum(f.client, ["p_surge"], { cacheKey: "k", nowMs: NOW });
    assertFourFacts(
      loaded.provenance,
      { startMs: NOW - MOMENTUM_BASELINE_WINDOW_MS, endMs: NOW, computedAt: NOW },
      "loadLocalMomentum",
    );
    assert.deepEqual(loaded.provenance, computeLocalMomentum(CORPUS, NOW).provenance);
  });

  it("a cache replay reports when the COMPUTATION ran, not when the cache was read", async () => {
    // The same rule discoveryRankProvenance states for `rankedAt`: re-stamping
    // on a replay would describe a computation that never took place.
    const f = fakeClient(CORPUS);
    const first  = await loadLocalMomentum(f.client, ["p_surge"], { cacheKey: "k", nowMs: NOW });
    const replay = await loadLocalMomentum(f.client, ["p_surge"], { cacheKey: "k", nowMs: NOW + 60_000 });
    assert.equal(f.reads(), 1, "the second call must be a cache hit or this asserts nothing");
    assert.equal(replay.provenance.computedAt, NOW);
    assert.equal(replay.provenance.computedAt, first.provenance.computedAt);
  });

  it("a failed read is still provenanced — an empty map is not an absent computation", async () => {
    const f = fakeClient(new Error("boom"));
    const m = await loadLocalMomentum(f.client, ["p_surge"], { cacheKey: "k", nowMs: NOW });
    assert.deepEqual({ ...m.values }, {});
    assertFourFacts(
      m.provenance,
      { startMs: NOW - MOMENTUM_BASELINE_WINDOW_MS, endMs: NOW, computedAt: NOW },
      "failed momentum read",
    );
  });
});

// ── Store 2 of 2: the `03` §9 trend stages ───────────────────────────────────

describe("DC-17 — every trend reading says what computed it, over which window, when", () => {
  it("carries all four facts, over its own 30-day window", () => {
    const out = computeTrendStates(CORPUS, NOW);
    const ids = Object.keys(out);
    assert.ok(ids.length > 0, "fixture must produce readings or this asserts nothing");
    for (const id of ids) {
      assertFourFacts(
        out[id]!.provenance,
        { startMs: NOW - TREND_PRIOR_MS, endMs: NOW, computedAt: NOW },
        `trend reading ${id}`,
      );
    }
  });

  it("the window bounds the rows that could have contributed to any reading", () => {
    const out = computeTrendStates(
      rep(9, (i) => imp("p_outside", new Date(NOW - TREND_PRIOR_MS - HOUR - i * HOUR).toISOString())),
      NOW,
    );
    assert.equal(out.p_outside, undefined, "a row before window.startMs cannot produce a reading");
  });

  it("readLocalTrendStates hands back readings that are still provenanced", async () => {
    _resetLocalMomentumCacheForTest();
    const f = fakeClient(CORPUS);
    await loadLocalMomentum(f.client, ["p_surge"], { cacheKey: "k", nowMs: NOW });
    const states = readLocalTrendStates("k", NOW + 1_000);
    assert.ok(Object.keys(states).length > 0, "the cache entry must hold stages or this asserts nothing");
    for (const [id, r] of Object.entries(states)) {
      assertFourFacts(
        r.provenance,
        { startMs: NOW - TREND_PRIOR_MS, endMs: NOW, computedAt: NOW },
        `cached trend reading ${id}`,
      );
    }
    assert.deepEqual(readLocalTrendStates("k", NOW + MOMENTUM_CACHE_TTL_MS + 1), {}, "an expired entry is 'not computed'");
  });
});

// ── One vocabulary, not two ──────────────────────────────────────────────────

describe("DC-17 — both stores version themselves with the ranker's own constants", () => {
  it("momentum and trend quote the SAME model and feature versions as discoveryRankProvenance", () => {
    const mom = computeLocalMomentum(CORPUS, NOW).provenance;
    const trd = computeTrendStates(CORPUS, NOW).p_surge!.provenance;
    assert.equal(mom.modelVersion,   trd.modelVersion);
    assert.equal(mom.featureVersion, trd.featureVersion);
    assert.equal(mom.modelVersion,   DISCOVERY_MODEL_VERSION);
    assert.equal(mom.featureVersion, DISCOVERY_FEATURE_VERSION);
    assert.ok(mom.modelVersion.length > 0 && mom.featureVersion.length > 0);
  });

  it("the two stores describe the same corpus over the same bounds", () => {
    // They are handed the same rows by loadLocalMomentum, so a divergence in
    // the declared window would mean one of the two labels is false.
    const mom = computeLocalMomentum(CORPUS, NOW).provenance;
    const trd = computeTrendStates(CORPUS, NOW).p_surge!.provenance;
    assert.deepEqual(mom.window, trd.window);
    assert.equal(mom.computedAt, trd.computedAt);
  });
});

// ── The guard that matters most: no number moved ─────────────────────────────

describe("DC-17 — provenance is ABOUT the computation and must not change it", () => {
  it("the momentum values are byte-identical to the pre-provenance tree's", () => {
    assert.deepEqual({ ...computeLocalMomentum(CORPUS, NOW).values }, GOLDEN_MOMENTUM);
  });

  it("every trend state and window rate is byte-identical to the pre-provenance tree's", () => {
    const out = computeTrendStates(CORPUS, NOW);
    assert.deepEqual(
      Object.fromEntries(Object.entries(out).map(([id, r]) => [id, { state: r.state, evidence: { ...r.evidence } }])),
      GOLDEN_TRENDS,
    );
  });

  it("stamping provenance is idempotent — two runs over one corpus agree exactly", () => {
    assert.deepEqual(computeLocalMomentum(CORPUS, NOW), computeLocalMomentum(CORPUS, NOW));
    assert.deepEqual(computeTrendStates(CORPUS, NOW), computeTrendStates(CORPUS, NOW));
  });
});

// ── A Supabase-ish stub, matching the loader's paged read ────────────────────

function fakeClient(rowsOrError: MomentumRow[] | Error) {
  let reads = 0;
  const client = {
    from() {
      const q: any = {
        select: () => q, eq: () => q, neq: () => q, in: () => q, gte: () => q, order: () => q,
        range: (from: number, to: number) => {
          reads += 1;
          if (rowsOrError instanceof Error) return Promise.resolve({ data: null, error: rowsOrError });
          return Promise.resolve({ data: rowsOrError.slice(from, to + 1), error: null });
        },
        then: (resolve: any, reject: any) => {
          reads += 1;
          const r = rowsOrError instanceof Error
            ? { data: null, error: rowsOrError }
            : { data: rowsOrError, error: null };
          return Promise.resolve(r).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { client, reads: () => reads };
}
