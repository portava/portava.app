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
    const m = computeLocalMomentum(rows, NOW);
    const expected = Math.min(1, ((5 - 0) / (0 + MOMENTUM_SMOOTHING)) / MOMENTUM_SATURATION);
    assert.equal(m.p, Math.round(expected * 1000) / 1000);
    assert.ok(m.p! > 0 && m.p! <= 1);
  });

  it("a STEADY place — the same rate all month — has no momentum at all (absent from the map)", () => {
    // 5 in the last 48 h, and 5 per 48-hour window across every one of the 14 prior windows.
    const recent = repeat(5, (i) => impression("p", at(-i * HOUR)));
    const prior  = repeat(5 * MOMENTUM_BASELINE_WINDOWS, (i) => impression("p", at(-3 * DAY - i * HOUR)));
    const m = computeLocalMomentum([...recent, ...prior], NOW);
    assert.equal(m.p, undefined, "baseline == recent ⇒ velocity 0 ⇒ no entry — popularity is not momentum");
  });

  it("a DECLINING place is 0, never negative — an empty window is not evidence of decline", () => {
    const prior = repeat(100, (i) => impression("p", at(-3 * DAY - i * HOUR)));
    const m = computeLocalMomentum(prior, NOW);
    assert.equal(m.p, undefined);
    for (const v of Object.values(m)) assert.ok(v >= 0);
  });

  it("below the recent floor there is no momentum even with zero baseline; at the floor there is", () => {
    const under = repeat(MOMENTUM_MIN_RECENT_WEIGHT - 1, (i) => impression("p", at(-i * HOUR)));
    assert.equal(computeLocalMomentum(under, NOW).p, undefined);
    const atFloor = repeat(MOMENTUM_MIN_RECENT_WEIGHT, (i) => impression("p", at(-i * HOUR)));
    assert.ok((computeLocalMomentum(atFloor, NOW).p ?? 0) > 0);
  });

  it("analytics rows are ranker bookkeeping and never count as activity", () => {
    const rows = repeat(20, (i) => converted("p", "analytics", at(-i * HOUR), null));
    assert.deepEqual(computeLocalMomentum(rows, NOW), {});
  });

  it("a save weighs more than an impression", () => {
    // A: three bare impressions ⇒ weight 3.
    // S: one impression served 2 h ago and SAVED 1 h ago ⇒ 1 + 3 = 4.
    const a = repeat(3, (i) => impression("a", at(-i * HOUR)));
    const s = [converted("s", "save", at(-2 * HOUR), at(-1 * HOUR))];
    const m = computeLocalMomentum([...a, ...s], NOW);
    assert.ok(m.s! > m.a!, `save-weighted ${m.s} must exceed impression-only ${m.a}`);
    assert.equal(MOMENTUM_EVENT_WEIGHTS.save, 3);
    assert.equal(MOMENTUM_EVENT_WEIGHTS.impression, 1);
  });

  it("an outcome counts at ITS OWN time, not at the impression's", () => {
    // Served 10 days ago, saved an hour ago: the save (weight 3 ≥ floor) is
    // recent activity; the old impression sits in the baseline.
    const fresh = computeLocalMomentum([converted("b", "save", at(-10 * DAY), at(-1 * HOUR))], NOW);
    assert.ok((fresh.b ?? 0) > 0);
    // The identical row whose save was ALSO 10 days ago: nothing recent.
    const stale = computeLocalMomentum([converted("b", "save", at(-10 * DAY), at(-10 * DAY + HOUR))], NOW);
    assert.equal(stale.b, undefined);
    // An unconverted impression never gets a second moment, whatever outcome_at says.
    const unconverted = computeLocalMomentum([converted("c", "impression", at(-10 * DAY), at(-1 * HOUR))], NOW);
    assert.equal(unconverted.c, undefined);
  });

  it("saturates at exactly 1 and never exceeds it", () => {
    const rows = repeat(500, (i) => impression("p", at(-(i % 47) * HOUR)));
    assert.equal(computeLocalMomentum(rows, NOW).p, 1);
  });

  it("ignores rows outside the 30-day window, in the future, or malformed", () => {
    const rows: MomentumRow[] = [
      ...repeat(5, (i) => impression("old",    at(-31 * DAY - i * HOUR))),
      ...repeat(5, (i) => impression("future", at(+HOUR + i * HOUR))),
      { item_id: "bad", outcome: "impression", served_at: "not-a-date", outcome_at: null },
      { item_id: "",    outcome: "impression", served_at: at(0),        outcome_at: null },
    ];
    assert.deepEqual(computeLocalMomentum(rows, NOW), {});
  });

  it("is per place — one place's surge does not leak into another", () => {
    const rows = [...repeat(10, (i) => impression("hot", at(-i * HOUR))), impression("cold", at(-HOUR))];
    const m = computeLocalMomentum(rows, NOW);
    assert.ok(m.hot! > 0);
    assert.equal(m.cold, undefined);
  });
});

// ── Loader ────────────────────────────────────────────────────────────────────

/** rank_events-only client: counts reads, captures the id filter, can fail. */
function fakeClient(rows: MomentumRow[] | Error) {
  let reads = 0;
  let capturedIn: string[] | null = null;
  const client = {
    from(table: string) {
      assert.equal(table, "rank_events");
      const q = {
        select: () => q, eq: () => q, neq: () => q, gte: () => q, limit: () => q,
        in: (_k: string, ids: string[]) => { capturedIn = ids; return q; },
        then: (resolve: (v: { data: MomentumRow[]; error: null }) => unknown, reject?: (e: unknown) => unknown) => {
          reads += 1;
          if (rows instanceof Error) return Promise.reject(rows).then(resolve, reject);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { client, reads: () => reads, capturedIn: () => capturedIn };
}

describe("loadLocalMomentum — bounded per-key cache, never throws", () => {
  beforeEach(() => _resetLocalMomentumCacheForTest());

  it("reads once per candidate key inside the TTL, and once more after it", async () => {
    const f = fakeClient(repeat(5, (i) => impression("p", at(-i * HOUR))));
    const a = await loadLocalMomentum(f.client, ["p", "q"], { cacheKey: "paris:food", nowMs: NOW });
    const b = await loadLocalMomentum(f.client, ["p", "q"], { cacheKey: "paris:food", nowMs: NOW + 1000 });
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
    const m = await loadLocalMomentum(f.client, ["p"], { cacheKey: "k", nowMs: NOW });
    assert.deepEqual(m, {});
  });

  it("no ids or no client ⇒ empty map with no read", async () => {
    const f = fakeClient([]);
    assert.deepEqual(await loadLocalMomentum(f.client, [], { cacheKey: "k", nowMs: NOW }), {});
    assert.deepEqual(await loadLocalMomentum(null, ["p"], { cacheKey: "k", nowMs: NOW }), {});
    assert.equal(f.reads(), 0);
  });
});
