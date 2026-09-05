/**
 * discoveryModifiers tests — ROADMAP step 7/8 modifiers behind ONE flag
 * (discovery_ranking_modifiers_enabled, migration 2289, seeded OFF).
 *
 * The invariant the ranker HOLD requires: with the flag off, exactly one
 * cached flag read happens and the record is inert — no momentum read, no
 * city-confidence read. With the flag on, every input handed to the ranker is
 * bounded, and the world-model city confidence enters only as the two
 * documented monotone inputs (momentum scale, exploration budget).
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryModifiers.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadDiscoveryModifiers, inertModifiers, cityConfidenceInputs,
  invalidateDiscoveryModifiersFlagCache, DISCOVERY_MODIFIERS_FLAG,
  MOMENTUM_SCALE_MIN, MOMENTUM_SCALE_MAX,
} from "../lib/discoveryModifiers.js";
import {
  computeLocalMomentum, _resetLocalMomentumCacheForTest, type MomentumRow,
} from "../lib/discoveryLocalMomentum.js";
import { GOVERNOR_BUDGET_MIN_PCT, GOVERNOR_BUDGET_MAX_PCT } from "../services/ranking/FeedSlotAllocator.js";
import type { CityConfidence } from "../compass/CompassGraphEngine.js";

const NOW = Date.parse("2026-09-04T12:00:00Z");
const HOUR = 3_600_000;
const at = (deltaMs: number): string => new Date(NOW + deltaMs).toISOString();

type Row = Record<string, unknown>;
/** A rank_events row as the loader's filter sees it: the surface column is real and is filtered on. */
type RankEventRow = MomentumRow & { surface: string };
interface Store {
  feature_flags?: Row[];
  compass_city_confidence?: Row[];
  rank_events?: RankEventRow[];
}

/**
 * Three-table client. `eq` filters; `maybeSingle` returns the first match;
 * awaiting returns every match. `throwOn` makes a table's read reject, which
 * is how the individually-non-fatal reads are exercised.
 */
function fakeClient(store: Store, throwOn: ReadonlySet<string> = new Set()) {
  const reads: string[] = [];
  const client = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const rows = () => ((store as Record<string, Row[] | undefined>)[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const fail = () => { reads.push(table); return Promise.reject(new Error(`read of ${table} failed`)); };
      // `order` + `range`: loadLocalMomentum PAGES the rank_events read under a
      // stable total order (a range-less read is silently capped by PostgREST at
      // db-max-rows). A builder without them makes the loader throw and the
      // momentum map come back empty — which reads as "no surge" rather than as
      // a broken fake.
      const orders: Array<{ col: string; asc: boolean }> = [];
      let rangeFrom = 0;
      let rangeTo: number | null = null;
      const paged = (): Row[] => {
        const out = [...rows()];
        for (const o of [...orders].reverse()) {
          out.sort((x, y) => {
            const a = String(x[o.col] ?? "");
            const b = String(y[o.col] ?? "");
            return (a < b ? -1 : a > b ? 1 : 0) * (o.asc ? 1 : -1);
          });
        }
        return rangeTo === null ? out : out.slice(rangeFrom, rangeTo + 1);
      };
      const q = {
        select: () => q, neq: () => q, in: () => q, gte: () => q, limit: () => q,
        order: (col: string, o?: { ascending?: boolean }) => {
          orders.push({ col, asc: o?.ascending !== false }); return q;
        },
        range: (f: number, t: number) => { rangeFrom = f; rangeTo = t; return q; },
        eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
        maybeSingle: () => {
          if (throwOn.has(table)) return fail();
          reads.push(table);
          return Promise.resolve({ data: rows()[0] ?? null, error: null });
        },
        then: (resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) => {
          if (throwOn.has(table)) return fail().then(resolve, reject);
          reads.push(table);
          return Promise.resolve({ data: paged(), error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { client, reads };
}

const flagRow = (enabled: boolean): Row => ({ flag: DISCOVERY_MODIFIERS_FLAG, enabled });
const confidenceRow = (depth: number): Row => ({
  city: "cebu", depth_score: depth, tier: depth >= 70 ? "deep" : depth >= 30 ? "moderate" : "thin",
  signals: {}, computed_at: at(0),
});
const surge = (): RankEventRow[] =>
  Array.from({ length: 12 }, (_, i) => ({
    surface: "discovery", item_id: "p1", outcome: "impression", served_at: at(-i * HOUR), outcome_at: null,
  }));

const PARAMS = { city: "cebu", placeIds: ["p1", "p2"], cacheKey: "cebu:food", nowMs: NOW };

describe("cityConfidenceInputs — the two bounded inputs, documented", () => {
  const conf = (depthScore: number): CityConfidence =>
    ({ city: "cebu", depthScore, tier: "thin", signals: {}, computedAt: at(0) });

  it("absent ⇒ THIN: momentum halved, budget at the top of the band", () => {
    assert.deepEqual(cityConfidenceInputs(null), { momentumScale: MOMENTUM_SCALE_MIN, explorationBudgetPct: GOVERNOR_BUDGET_MAX_PCT });
  });
  it("depth 100 ⇒ DEEP: momentum unscaled, budget at the bottom of the band", () => {
    assert.deepEqual(cityConfidenceInputs(conf(100)), { momentumScale: MOMENTUM_SCALE_MAX, explorationBudgetPct: GOVERNOR_BUDGET_MIN_PCT });
  });
  it("is linear in between", () => {
    assert.deepEqual(cityConfidenceInputs(conf(50)), { momentumScale: 0.75, explorationBudgetPct: 20 });
  });
  it("clamps an out-of-range or non-finite score to the band — the column has no CHECK", () => {
    assert.deepEqual(cityConfidenceInputs(conf(150)), cityConfidenceInputs(conf(100)));
    assert.deepEqual(cityConfidenceInputs(conf(-10)), cityConfidenceInputs(null));
    assert.deepEqual(cityConfidenceInputs(conf(Number.NaN)), cityConfidenceInputs(null));
  });
  it("is monotone: more depth never raises the budget or lowers the momentum scale", () => {
    let prev = cityConfidenceInputs(conf(0));
    for (let d = 5; d <= 100; d += 5) {
      const cur = cityConfidenceInputs(conf(d));
      assert.ok(cur.explorationBudgetPct <= prev.explorationBudgetPct);
      assert.ok(cur.momentumScale >= prev.momentumScale);
      assert.ok(cur.explorationBudgetPct >= GOVERNOR_BUDGET_MIN_PCT && cur.explorationBudgetPct <= GOVERNOR_BUDGET_MAX_PCT);
      assert.ok(cur.momentumScale >= MOMENTUM_SCALE_MIN && cur.momentumScale <= MOMENTUM_SCALE_MAX);
      prev = cur;
    }
  });
});

describe("loadDiscoveryModifiers — flag OFF is the invariant", () => {
  beforeEach(() => { invalidateDiscoveryModifiersFlagCache(); _resetLocalMomentumCacheForTest(); });

  it("no flag row: inert, and the ONLY read is the flag itself", async () => {
    const f = fakeClient({ compass_city_confidence: [confidenceRow(90)], rank_events: surge() });
    const m = await loadDiscoveryModifiers(f.client, PARAMS);
    assert.equal(m.enabled, false);
    assert.equal(m.reason, "flag_off");
    assert.deepEqual(m.localMomentum, {});
    assert.equal(m.cityConfidence, null);
    assert.deepEqual(f.reads, ["feature_flags"], "no momentum read, no confidence read");
  });

  it("flag row false: same", async () => {
    const f = fakeClient({ feature_flags: [flagRow(false)], rank_events: surge() });
    const m = await loadDiscoveryModifiers(f.client, PARAMS);
    assert.equal(m.enabled, false);
    assert.deepEqual(f.reads, ["feature_flags"]);
  });

  it("no client: inert with reason no_client and no read at all", async () => {
    const m = await loadDiscoveryModifiers(null, PARAMS);
    assert.equal(m.enabled, false);
    assert.equal(m.reason, "no_client");
  });

  it("a failing flag read is OFF (fail-closed), never on", async () => {
    const f = fakeClient({ feature_flags: [flagRow(true)] }, new Set(["feature_flags"]));
    const m = await loadDiscoveryModifiers(f.client, PARAMS);
    assert.equal(m.enabled, false);
  });

  it("inertModifiers: the record every OFF caller gets is inside every bound", () => {
    const m = inertModifiers("flag_off");
    assert.equal(m.enabled, false);
    assert.deepEqual(m.localMomentum, {});
    assert.ok(m.explorationBudgetPct >= GOVERNOR_BUDGET_MIN_PCT && m.explorationBudgetPct <= GOVERNOR_BUDGET_MAX_PCT);
  });
});

describe("loadDiscoveryModifiers — flag ON", () => {
  beforeEach(() => { invalidateDiscoveryModifiersFlagCache(); _resetLocalMomentumCacheForTest(); });

  it("thin city (no confidence row): momentum halved, budget 25, and every value inside its bound", async () => {
    const f = fakeClient({ feature_flags: [flagRow(true)], rank_events: surge() });
    const m = await loadDiscoveryModifiers(f.client, PARAMS);
    assert.equal(m.enabled, true);
    assert.equal(m.reason, "flag_on");
    assert.equal(m.cityConfidence, null);
    assert.equal(m.momentumScale, MOMENTUM_SCALE_MIN);
    assert.equal(m.explorationBudgetPct, GOVERNOR_BUDGET_MAX_PCT);
    const raw = computeLocalMomentum(surge(), NOW).p1!;
    assert.equal(m.localMomentum.p1, Math.round(raw * MOMENTUM_SCALE_MIN * 1000) / 1000);
    assert.equal(m.localMomentum.p2, undefined, "no activity ⇒ no entry");
    for (const v of Object.values(m.localMomentum)) assert.ok(v > 0 && v <= 1);
    assert.deepEqual([...new Set(f.reads)].sort(), ["compass_city_confidence", "feature_flags", "rank_events"]);
  });

  it("deep city (depth 100): momentum unscaled, budget 15", async () => {
    const f = fakeClient({ feature_flags: [flagRow(true)], compass_city_confidence: [confidenceRow(100)], rank_events: surge() });
    const m = await loadDiscoveryModifiers(f.client, PARAMS);
    assert.equal(m.cityConfidence?.depthScore, 100);
    assert.equal(m.momentumScale, MOMENTUM_SCALE_MAX);
    assert.equal(m.explorationBudgetPct, GOVERNOR_BUDGET_MIN_PCT);
    assert.equal(m.localMomentum.p1, computeLocalMomentum(surge(), NOW).p1);
  });

  it("a failed confidence read is THIN, and the modifiers stay on", async () => {
    const f = fakeClient({ feature_flags: [flagRow(true)], compass_city_confidence: [confidenceRow(100)], rank_events: surge() }, new Set(["compass_city_confidence"]));
    const m = await loadDiscoveryModifiers(f.client, PARAMS);
    assert.equal(m.enabled, true);
    assert.equal(m.cityConfidence, null);
    assert.equal(m.explorationBudgetPct, GOVERNOR_BUDGET_MAX_PCT);
  });

  it("a failed momentum read is 'no surge anywhere', and the modifiers stay on", async () => {
    const f = fakeClient({ feature_flags: [flagRow(true)], rank_events: surge() }, new Set(["rank_events"]));
    const m = await loadDiscoveryModifiers(f.client, PARAMS);
    assert.equal(m.enabled, true);
    assert.deepEqual(m.localMomentum, {});
  });

  it("the flag value is cached for 30 s, then re-read", async () => {
    const store: Store = { feature_flags: [flagRow(true)] };
    const f = fakeClient(store);
    assert.equal((await loadDiscoveryModifiers(f.client, PARAMS)).enabled, true);
    store.feature_flags = [flagRow(false)];
    assert.equal((await loadDiscoveryModifiers(f.client, { ...PARAMS, nowMs: NOW + 10_000 })).enabled, true, "inside the TTL the cached value stands");
    assert.equal((await loadDiscoveryModifiers(f.client, { ...PARAMS, nowMs: NOW + 31_000 })).enabled, false, "past the TTL the flip is seen");
  });
});
