/**
 * discoveryLocalMomentum tests — the place-level velocity signal (ROADMAP step 7).
 *
 * The signal is admissible while the ranker is on HOLD only because it is a
 * MODIFIER: bounded to [0,1], strictly non-negative, floored so a handful of
 * impressions is not a surge, and capped again in portavaRank. These tests pin
 * each of those properties on the pure arithmetic, then the loader's cache and
 * its never-throws degradation.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryLocalMomentum.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  computeLocalMomentum, loadLocalMomentum, _resetLocalMomentumCacheForTest,
  MOMENTUM_MIN_RECENT_WEIGHT, MOMENTUM_BASELINE_WINDOWS, MOMENTUM_SMOOTHING, MOMENTUM_SATURATION,
  MOMENTUM_EVENT_WEIGHTS, MOMENTUM_CACHE_TTL_MS,
  MOMENTUM_ROW_LIMIT, MOMENTUM_PAGE_SIZE,
  type MomentumRow,
} from "../lib/discoveryLocalMomentum.js";

const NOW = Date.parse("2026-09-04T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (deltaMs: number): string => new Date(NOW + deltaMs).toISOString();

function impression(id: string, servedAt: string): MomentumRow {
  return { item_id: id, outcome: "impression", served_at: servedAt, outcome_at: null };
}
function converted(id: string, outcome: string, servedAt: string, outcomeAt: string | null): MomentumRow {
  return { item_id: id, outcome, served_at: servedAt, outcome_at: outcomeAt };
}
function repeat(n: number, make: (i: number) => MomentumRow): MomentumRow[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

describe("computeLocalMomentum — the arithmetic", () => {
  it("a place with recent activity and no baseline surges, and the value matches the formula", () => {
    const rows = repeat(5, (i) => impression("p", at(-i * HOUR)));
    const m = computeLocalMomentum(rows, NOW).values;
    const expected = Math.min(1, ((5 - 0) / (0 + MOMENTUM_SMOOTHING)) / MOMENTUM_SATURATION);
    assert.equal(m.p, Math.round(expected * 1000) / 1000);
    assert.ok(m.p! > 0 && m.p! <= 1);
  });

  it("a STEADY place — the same rate all month — has no momentum at all (absent from the map)", () => {
    // 5 in the last 48 h, and 5 per 48-hour window across every one of the 14 prior windows.
    const recent = repeat(5, (i) => impression("p", at(-i * HOUR)));
    const prior  = repeat(5 * MOMENTUM_BASELINE_WINDOWS, (i) => impression("p", at(-3 * DAY - i * HOUR)));
    const m = computeLocalMomentum([...recent, ...prior], NOW).values;
    assert.equal(m.p, undefined, "baseline == recent ⇒ velocity 0 ⇒ no entry — popularity is not momentum");
  });

  it("a DECLINING place is 0, never negative — an empty window is not evidence of decline", () => {
    const prior = repeat(100, (i) => impression("p", at(-3 * DAY - i * HOUR)));
    const m = computeLocalMomentum(prior, NOW).values;
    assert.equal(m.p, undefined);
    for (const v of Object.values(m)) assert.ok(v >= 0);
  });

  it("below the recent floor there is no momentum even with zero baseline; at the floor there is", () => {
    const under = repeat(MOMENTUM_MIN_RECENT_WEIGHT - 1, (i) => impression("p", at(-i * HOUR)));
    assert.equal(computeLocalMomentum(under, NOW).values.p, undefined);
    const atFloor = repeat(MOMENTUM_MIN_RECENT_WEIGHT, (i) => impression("p", at(-i * HOUR)));
    assert.ok((computeLocalMomentum(atFloor, NOW).values.p ?? 0) > 0);
  });

  it("analytics rows are ranker bookkeeping and never count as activity", () => {
    const rows = repeat(20, (i) => converted("p", "analytics", at(-i * HOUR), null));
    assert.deepEqual(computeLocalMomentum(rows, NOW).values, {});
  });

  it("a save weighs more than an impression", () => {
    // A: three bare impressions ⇒ weight 3.
    // S: one impression served 2 h ago and SAVED 1 h ago ⇒ 1 + 3 = 4.
    const a = repeat(3, (i) => impression("a", at(-i * HOUR)));
    const s = [converted("s", "save", at(-2 * HOUR), at(-1 * HOUR))];
    const m = computeLocalMomentum([...a, ...s], NOW).values;
    assert.ok(m.s! > m.a!, `save-weighted ${m.s} must exceed impression-only ${m.a}`);
    assert.equal(MOMENTUM_EVENT_WEIGHTS.save, 3);
    assert.equal(MOMENTUM_EVENT_WEIGHTS.impression, 1);
  });

  it("an outcome counts at ITS OWN time, not at the impression's", () => {
    // Served 10 days ago, saved an hour ago: the save (weight 3 ≥ floor) is
    // recent activity; the old impression sits in the baseline.
    const fresh = computeLocalMomentum([converted("b", "save", at(-10 * DAY), at(-1 * HOUR))], NOW).values;
    assert.ok((fresh.b ?? 0) > 0);
    // The identical row whose save was ALSO 10 days ago: nothing recent.
    const stale = computeLocalMomentum([converted("b", "save", at(-10 * DAY), at(-10 * DAY + HOUR))], NOW).values;
    assert.equal(stale.b, undefined);
    // An unconverted impression never gets a second moment, whatever outcome_at says.
    const unconverted = computeLocalMomentum([converted("c", "impression", at(-10 * DAY), at(-1 * HOUR))], NOW).values;
    assert.equal(unconverted.c, undefined);
  });

  it("saturates at exactly 1 and never exceeds it", () => {
    const rows = repeat(500, (i) => impression("p", at(-(i % 47) * HOUR)));
    assert.equal(computeLocalMomentum(rows, NOW).values.p, 1);
  });

  it("ignores rows outside the 30-day window, in the future, or malformed", () => {
    const rows: MomentumRow[] = [
      ...repeat(5, (i) => impression("old",    at(-31 * DAY - i * HOUR))),
      ...repeat(5, (i) => impression("future", at(+HOUR + i * HOUR))),
      { item_id: "bad", outcome: "impression", served_at: "not-a-date", outcome_at: null },
      { item_id: "",    outcome: "impression", served_at: at(0),        outcome_at: null },
    ];
    assert.deepEqual(computeLocalMomentum(rows, NOW).values, {});
  });

  it("is per place — one place's surge does not leak into another", () => {
    const rows = [...repeat(10, (i) => impression("hot", at(-i * HOUR))), impression("cold", at(-HOUR))];
    const m = computeLocalMomentum(rows, NOW).values;
    assert.ok(m.hot! > 0);
    assert.equal(m.cold, undefined);
  });
});

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * rank_events-only client: counts reads, captures the id filter, can fail.
 *
 * A FRESH builder per `from()` call, because the loader PAGES — one shared
 * builder would carry page 1's `.range()` into page 2 and every page would
 * return the same rows.
 *
 * `dbMaxRows` emulates PostgREST's `db-max-rows` cap: the server silently
 * truncating a response to 1000 rows with no error and no signal. That cap is
 * what made `.limit(5000)` a lie. `orders` records the ORDER BY the loader asks
 * for, and the fake refuses to invent one — with no `.order()` the rows come
 * back in fixture order, standing in for Postgres's arbitrary physical order.
 */
function fakeClient(
  rows: MomentumRow[] | Error,
  opts: { dbMaxRows?: number } = {},
) {
  let reads = 0;
  let capturedIn: string[] | null = null;
  let capturedRanges: Array<[number, number]> = [];
  let capturedOrders: Array<{ col: string; asc: boolean }> = [];
  let sawLimit = false;
  const dbMaxRows = opts.dbMaxRows ?? Infinity;

  const client = {
    from(table: string) {
      assert.equal(table, "rank_events");
      const orders: Array<{ col: string; asc: boolean }> = [];
      let from = 0;
      let to = Infinity;
      const q: any = {
        select: () => q, eq: () => q, neq: () => q, gte: () => q,
        limit: (_n: number) => { sawLimit = true; return q; },
        order: (col: string, o?: { ascending?: boolean }) => {
          const rec = { col, asc: o?.ascending !== false };
          orders.push(rec); capturedOrders.push(rec);
          return q;
        },
        range: (f: number, t: number) => {
          from = f; to = t; capturedRanges.push([f, t]);
          return q;
        },
        in: (_k: string, ids: string[]) => { capturedIn = ids; return q; },
        then: (resolve: (v: { data: MomentumRow[]; error: null }) => unknown, reject?: (e: unknown) => unknown) => {
          reads += 1;
          if (rows instanceof Error) return Promise.reject(rows).then(resolve, reject);
          const sorted = [...rows];
          for (const o of [...orders].reverse()) {
            sorted.sort((x, y) => {
              const a = String((x as any)[o.col] ?? "");
              const b = String((y as any)[o.col] ?? "");
              return (a < b ? -1 : a > b ? 1 : 0) * (o.asc ? 1 : -1);
            });
          }
          // The requested range first, then the server's silent cap. Both.
          const windowed = sorted.slice(from, to === Infinity ? undefined : to + 1);
          const data = windowed.slice(0, dbMaxRows);
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return {
    client,
    reads: () => reads,
    capturedIn: () => capturedIn,
    ranges: () => capturedRanges,
    orders: () => capturedOrders,
    sawLimit: () => sawLimit,
  };
}

describe("loadLocalMomentum — bounded per-key cache, never throws", () => {
  beforeEach(() => _resetLocalMomentumCacheForTest());

  it("reads once per candidate key inside the TTL, and once more after it", async () => {
    const f = fakeClient(repeat(5, (i) => impression("p", at(-i * HOUR))));
    const a = (await loadLocalMomentum(f.client, ["p", "q"], { cacheKey: "paris:food", nowMs: NOW })).values;
    const b = (await loadLocalMomentum(f.client, ["p", "q"], { cacheKey: "paris:food", nowMs: NOW + 1000 })).values;
    assert.equal(f.reads(), 1);
    assert.deepEqual(a, b);
    assert.ok(a.p! > 0);
    await loadLocalMomentum(f.client, ["p", "q"], { cacheKey: "paris:bars", nowMs: NOW });
    assert.equal(f.reads(), 2, "a different candidate set is a different read");
    await loadLocalMomentum(f.client, ["p", "q"], { cacheKey: "paris:food", nowMs: NOW + MOMENTUM_CACHE_TTL_MS + 1 });
    assert.equal(f.reads(), 3, "past the TTL the key is re-read");
  });

  it("scopes the read to the deduplicated candidate ids", async () => {
    const f = fakeClient([]);
    await loadLocalMomentum(f.client, ["a", "b", "a"], { cacheKey: "k", nowMs: NOW });
    assert.deepEqual(f.capturedIn(), ["a", "b"]);
  });

  it("a failed read is an empty map — 'no surge anywhere' — and nothing throws", async () => {
    const f = fakeClient(new Error("boom"));
    const m = (await loadLocalMomentum(f.client, ["p"], { cacheKey: "k", nowMs: NOW })).values;
    assert.deepEqual(m, {});
  });

  it("no ids or no client ⇒ empty map with no read", async () => {
    const f = fakeClient([]);
    assert.deepEqual((await loadLocalMomentum(f.client, [], { cacheKey: "k", nowMs: NOW })).values, {});
    assert.deepEqual((await loadLocalMomentum(null, ["p"], { cacheKey: "k", nowMs: NOW })).values, {});
    assert.equal(f.reads(), 0);
  });
});

// ── The momentum window is DEFINED, not whatever 1000 rows Postgres felt like ──
//
// DEFECT: the loader asked for `.limit(MOMENTUM_ROW_LIMIT)` with MOMENTUM_ROW_LIMIT
// = 5000 and NO ORDER BY. Two failures in one line:
//
//   * PostgREST caps a response at db-max-rows (1000), silently. Asking for 5000
//     got 1000, with no error and nothing on the result to say so — so the
//     "30-day baseline window" was in fact whatever fraction of it fitted.
//   * With no ORDER BY, WHICH 1000 is Postgres's physical scan order — arbitrary,
//     and free to differ between two runs of the identical query. A place's
//     momentum could move without a single new event.
//
// Momentum feeds the ranker. A signal that is silently computed over an
// arbitrary sample is worse than no signal, because it looks like a measurement.
describe("loadLocalMomentum — the window is bounded deliberately, never silently", () => {
  beforeEach(() => _resetLocalMomentumCacheForTest());

  /** n impressions on `id`, each one minute apart, newest first, with ids. */
  function paged(id: string, n: number, baseDeltaMs = 0): MomentumRow[] {
    return Array.from({ length: n }, (_, i) => ({
      ...impression(id, at(baseDeltaMs - i * 60_000)),
      id: String(n - i).padStart(8, "0"),
    })) as unknown as MomentumRow[];
  }

  it("pages past PostgREST's silent 1000-row cap instead of stopping at it", async () => {
    // 2500 recent impressions on one place. Pre-fix this read returns 1000.
    const f = fakeClient(paged("p", 2_500), { dbMaxRows: MOMENTUM_PAGE_SIZE });
    await loadLocalMomentum(f.client, ["p"], { cacheKey: "k", nowMs: NOW });

    assert.equal(
      f.reads(), 3,
      "2500 rows over 1000-row pages is 3 reads. One read means the loader accepted " +
      "the server's silent cap and called a 1000-row sample the 30-day window.",
    );
    assert.deepEqual(
      f.ranges(), [[0, 999], [1000, 1999], [2000, 2999]],
      "each page must ask for an EXPLICIT range — that is the only thing that " +
      "distinguishes 'the corpus ended' from 'the server truncated me'",
    );
  });

  it("asks for a stable TOTAL order, so which rows survive is defined", async () => {
    const f = fakeClient(paged("p", 5), { dbMaxRows: MOMENTUM_PAGE_SIZE });
    await loadLocalMomentum(f.client, ["p"], { cacheKey: "k", nowMs: NOW });

    const cols = f.orders().map((o) => o.col);
    assert.ok(
      cols.includes("served_at"),
      "no ORDER BY means the rows kept under any bound are arbitrary — Postgres's " +
      "physical scan order, free to change between two runs of the same query",
    );
    assert.ok(
      cols.includes("id"),
      "served_at alone is not a TOTAL order (timestamps collide), and paging over " +
      "a non-total order can return one row on two pages and skip another",
    );
    // Newest-first: when the ceiling truncates, what survives is the recent
    // window — the half the recent/baseline split actually turns on.
    assert.equal(f.orders().find((o) => o.col === "served_at")?.asc, false);
  });

  it("the page size cannot exceed the cap it exists to defeat", () => {
    // If MOMENTUM_PAGE_SIZE > db-max-rows, a full page and a capped page are
    // indistinguishable and the loop terminates one page early, forever.
    assert.ok(
      MOMENTUM_PAGE_SIZE <= 1_000,
      "a page larger than PostgREST's db-max-rows is silently truncated, which is " +
      "the exact defect this pagination replaced",
    );
    assert.ok(MOMENTUM_ROW_LIMIT >= MOMENTUM_PAGE_SIZE);
  });

  it("an exhausted corpus ends on a short page — no wasted read, no false ceiling", async () => {
    const f = fakeClient(paged("p", 5), { dbMaxRows: MOMENTUM_PAGE_SIZE });
    const m = (await loadLocalMomentum(f.client, ["p"], { cacheKey: "k", nowMs: NOW })).values;
    assert.equal(f.reads(), 1);
    assert.ok(m.p! > 0, "the five recent impressions still produce momentum");
  });

  it("the paged corpus produces the SAME momentum as computing over all of it directly", async () => {
    // The pagination must not change the arithmetic — only how much of the
    // corpus reaches it.
    const rows = [
      ...paged("p", 1_400),                       // recent surge, spans 2 pages
      ...paged("q", 60, -5 * DAY),                // baseline-only, no surge
    ];
    const f = fakeClient(rows, { dbMaxRows: MOMENTUM_PAGE_SIZE });
    const viaLoader = (await loadLocalMomentum(f.client, ["p", "q"], { cacheKey: "k", nowMs: NOW })).values;
    const direct = computeLocalMomentum(rows, NOW).values;
    assert.deepEqual(viaLoader, direct, "paging dropped or duplicated rows");
  });

  it("still degrades to 'no surge' when a page fails — never a partial fabricated signal", async () => {
    const f = fakeClient(new Error("boom"), { dbMaxRows: MOMENTUM_PAGE_SIZE });
    assert.deepEqual((await loadLocalMomentum(f.client, ["p"], { cacheKey: "k", nowMs: NOW })).values, {});
  });
});

// ── `03` §9 place-momentum stages (census DV-28, DV-33) ───────────────────────
//
// REQUIREMENT
// ===========
// docs/specs/discovery-v1/03_Trending.md §9 (`:122`) — "Conceptual stages:
// unknown, emerging, trending, established, cooling, rediscovered." §14's
// acceptance criteria include "it can distinguish emerging vs established" and
// "it can explain major trend reasons"; §11 gives the shape of an explanation
// ("Rising quickly in Sukhumvit tonight", "Emerging across several independent
// traveler groups").
//
// THE GAP
// =======
// census DV-28: "No trend state machine (`03` §4's seven states) under any name.
// `lib/discoveryLocalMomentum.ts` computes one 48h-vs-baseline scalar; a scalar
// is not a lifecycle." DV-33: "no reason vocabulary exists."
//
// A scalar genuinely cannot answer the question. `emerging` and `cooling` can
// produce the SAME momentum number — one has no history and a little activity,
// the other has a long history and less of it than before — and the whole point
// of §9 is that those are different things to say about a place. What separates
// them is a THIRD window, which the same rows already contain.
//
// WHAT IS NOT BUILT, AND WHY THE ROW STAYS W
// ==========================================
// `03` §4's seven-state CONTENT lifecycle (emerging/growing/peak/cooling/
// evergreen/rediscovered/inactive) is a different object: §4 says "Trend
// lifecycle must depend on content type — a nightclub event decays in hours, a
// temple guide may remain valuable for years", and a place-scoped signal has no
// content-type dimension to decay differently by.
import {
  computeTrendStates,
  classifyTrendState,
  explainTrendState,
  TREND_STATES,
  TREND_MIN_RATE,
  type TrendEvidence,
} from "../lib/discoveryTrendState.js";

const TREND_DAY = 24 * 60 * 60 * 1_000;
const TNOW = 1_800_000_000_000;

/** n impression rows for `id`, all `agoMs` before TNOW. */
function impressions(id: string, n: number, agoMs: number) {
  return Array.from({ length: n }, () => ({
    item_id: id, outcome: "impression",
    served_at: new Date(TNOW - agoMs).toISOString(), outcome_at: null,
  }));
}

const ev = (recent: number, mid: number, prior: number): TrendEvidence =>
  ({ recentRate: recent, midRate: mid, priorRate: prior, totalWeight: recent + mid + prior });

describe("03 §9 — the six place-momentum stages", () => {
  it("names the six stages in the specification's own order", () => {
    assert.deepEqual([...TREND_STATES], [
      "unknown", "emerging", "trending", "established", "cooling", "rediscovered",
    ]);
  });

  it("DEFECT: emerging and cooling are distinguishable — a scalar cannot tell them apart", () => {
    // Same recent rate. Opposite stories. This is the case DV-28 is about.
    const emerging = ev(TREND_MIN_RATE * 2, 0, 0);
    const cooling  = ev(TREND_MIN_RATE * 2, TREND_MIN_RATE * 20, TREND_MIN_RATE * 20);
    assert.equal(classifyTrendState(emerging), "emerging");
    assert.equal(classifyTrendState(cooling),  "cooling");
    assert.notEqual(
      classifyTrendState(emerging), classifyTrendState(cooling),
      "a place with no history and a little activity is not the same as one with a long history and less of it",
    );
  });

  it("distinguishes emerging from established — 03 §14's own acceptance criterion", () => {
    const established = ev(TREND_MIN_RATE * 10, TREND_MIN_RATE * 10, TREND_MIN_RATE * 10);
    assert.equal(classifyTrendState(established), "established");
    assert.equal(classifyTrendState(ev(TREND_MIN_RATE * 2, 0, 0)), "emerging");
  });

  it("trending is acceleration against the recent past, not absolute volume", () => {
    assert.equal(classifyTrendState(ev(TREND_MIN_RATE * 10, TREND_MIN_RATE * 2, TREND_MIN_RATE * 2)), "trending");
    assert.equal(
      classifyTrendState(ev(TREND_MIN_RATE * 100, TREND_MIN_RATE * 100, TREND_MIN_RATE * 100)), "established",
      "a permanently busy place is established, not trending — 03 §1: 'Trending is not equivalent to most liked'",
    );
  });

  it("rediscovered needs the QUIET MIDDLE — activity, then silence, then activity", () => {
    assert.equal(classifyTrendState(ev(TREND_MIN_RATE * 5, 0, TREND_MIN_RATE * 5)), "rediscovered");
    assert.notEqual(
      classifyTrendState(ev(TREND_MIN_RATE * 5, TREND_MIN_RATE * 5, TREND_MIN_RATE * 5)), "rediscovered",
      "uninterrupted activity is not a rediscovery; without the middle window this state cannot exist at all",
    );
  });

  it("no evidence is `unknown`, and unknown is never a claim about the place", () => {
    assert.equal(classifyTrendState(ev(0, 0, 0)), "unknown");
    assert.equal(explainTrendState("unknown"), null, "a place nobody has been served has no trend to explain");
  });

  it("a below-floor recent window cannot trend, however empty the past", () => {
    assert.equal(
      classifyTrendState(ev(TREND_MIN_RATE * 0.5, 0, 0)), "unknown",
      "one or two impressions is not a surge; acting on it manufactures a signal",
    );
  });

  it("03 §11 — every state that IS a claim has a plain-language explanation, and none names a person or place", () => {
    for (const s of TREND_STATES) {
      const text = explainTrendState(s);
      if (s === "unknown") { assert.equal(text, null); continue; }
      assert.equal(typeof text, "string", `${s} must be explainable (03 §14 'it can explain major trend reasons')`);
      assert.ok(/^[A-Z].*[.!]$/.test(text!), `${s}'s explanation must read as a sentence: ${JSON.stringify(text)}`);
      assert.ok(!/@|\buser\b|\bid\b/i.test(text!), `${s}'s explanation must not name anyone`);
    }
  });
});

describe("03 §9 — computeTrendStates over real rank_events rows", () => {
  it("reads THREE windows out of the same rows the scalar already reads", () => {
    const rows = [
      ...impressions("p_new", 8, 6 * 60 * 60 * 1_000),      // recent only
      ...impressions("p_old", 8, 20 * TREND_DAY),                  // prior only
      // 40, not 8: the prior window is 23 days long and is normalised to a
      // 48-hour RATE before the floor is applied, so a handful of impressions
      // three weeks ago is not "history" — it is the same trickle the floor
      // exists to ignore. The three windows are compared as rates or they are
      // not comparable at all.
      ...impressions("p_back", 8, 6 * 60 * 60 * 1_000),      // recent …
      ...impressions("p_back", 40, 20 * TREND_DAY),          // … and long ago, nothing between
      ...impressions("p_steady", 8, 6 * 60 * 60 * 1_000),
      ...impressions("p_steady", 20, 4 * TREND_DAY),
      ...impressions("p_steady", 92, 20 * TREND_DAY),
    ];
    const out = computeTrendStates(rows, TNOW);
    assert.equal(out["p_new"].state, "emerging");
    assert.equal(out["p_back"].state, "rediscovered");
    assert.equal(out["p_steady"].state, "established");
    assert.equal(
      out["p_old"]?.state, "unknown",
      "a place with only old activity has no current trend — and `unknown` says so rather than inventing `cooling` from nothing recent",
    );
  });

  it("carries the evidence, so an explanation can be checked against the numbers behind it", () => {
    const out = computeTrendStates(impressions("p", 8, 6 * 60 * 60 * 1_000), TNOW);
    assert.ok(out["p"].evidence.recentRate > 0);
    assert.equal(out["p"].evidence.midRate, 0);
    assert.equal(out["p"].evidence.priorRate, 0);
  });

  it("does not change the existing momentum scalar — the two are computed side by side", () => {
    const rows = impressions("p", 8, 6 * 60 * 60 * 1_000);
    const before = computeLocalMomentum(rows, TNOW).values;
    computeTrendStates(rows, TNOW);
    assert.deepEqual(computeLocalMomentum(rows, TNOW).values, before, "adding a state machine must not move a number the ranker already uses");
  });
});

describe("03 §9 — the two modules must weigh the same rows the same way", () => {
  it("DEFECT GUARD: the trend floor and event weights equal the momentum module's", async () => {
    // They are declared twice rather than imported, because a VALUE import from
    // discoveryTrendState back into discoveryLocalMomentum would be an ES-module
    // cycle through a `const` — which fails at IMPORT time ("cannot access
    // before initialization"), i.e. as a startup crash rather than a test
    // failure. This test is what keeps the duplication honest.
    const mom = await import("../lib/discoveryLocalMomentum.js");
    const trd = await import("../lib/discoveryTrendState.js");
    assert.equal(
      trd.TREND_MIN_RATE, mom.MOMENTUM_MIN_RECENT_WEIGHT,
      "a place the scalar calls noise and the stage calls a surge is worse than either being wrong alone",
    );
    assert.deepEqual(
      { ...trd.TREND_EVENT_WEIGHTS }, { ...mom.MOMENTUM_EVENT_WEIGHTS },
      "two modules weighing the same rank_events rows differently produce a stage and a scalar that disagree about the same place",
    );
  });
});
