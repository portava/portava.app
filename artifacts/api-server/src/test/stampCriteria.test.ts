/**
 * Stamp Wave 3 — criteria engine tests.
 *
 * Covers the schema (referenced metrics), metric resolution (DB + context),
 * the evaluator (operators, all/any/not, fail-closed on malformed/unknown),
 * the additive gate, and the evaluate-and-award path (injected awardFn).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { referencedMetrics, CRITERIA_SCHEMA_VERSION } from "../lib/stamps/criteria/schema.js";
import { resolveMetric, isKnownMetric } from "../lib/stamps/criteria/metrics.js";
import { evaluateCriteria } from "../lib/stamps/criteria/evaluator.js";
import { criteriaGate, evaluateAndAwardCriteria } from "../lib/stamps/criteria/index.js";

// ── Fake Supabase: count-head queries + jsonb-not-null + flag ─────────────────

interface FakeOpts {
  counts?: Record<string, number>;      // table → count for head queries
  distinct?: Record<string, string[]>;  // "user_stamps.city" → values
  flagOn?: boolean;
  defs?: any[];                         // stamp_definitions rows
}

function makeSc(opts: FakeOpts = {}) {
  const counts = opts.counts ?? {};
  return {
    from(table: string) {
      const b: any = {
        _filters: [] as Array<[string, any]>,
        _notNull: false,
        select(_f: string, o?: any) { b._head = o?.head === true; b._field = _f; return b; },
        eq(k: string, v: any) { b._filters.push([k, v]); return b; },
        in(_k: string, _v: any[]) { return b; },
        not(_k: string, _op: string, _v: any) { b._notNull = true; return b; },
        maybeSingle: async () => {
          if (table === "feature_flags") return { data: { enabled: opts.flagOn === true }, error: null };
          if (table === "stamp_definitions") {
            const slug = b._filters.find((f: any) => f[0] === "slug")?.[1];
            return { data: (opts.defs ?? []).find((d) => d.slug === slug) ?? null, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve: any) {
          if (b._head) { resolve({ count: counts[table] ?? 0, error: null }); return; }
          if (table === "user_stamps" && b._field && opts.distinct) {
            const vals = (opts.distinct[`user_stamps.${b._field}`] ?? []).map((v) => ({ [b._field]: v }));
            resolve({ data: vals, error: null }); return;
          }
          if (table === "stamp_definitions") {
            resolve({ data: opts.defs ?? [], error: null }); return;
          }
          resolve({ data: [], error: null });
        },
      };
      return b;
    },
  } as any;
}

const U = "user-1";

// ── Schema ────────────────────────────────────────────────────────────────────

describe("criteria schema", () => {
  it("collects referenced metrics from nested rules", () => {
    const rule = { version: 1, all: [{ metric: "a", gte: 1 }, { any: [{ metric: "b", gte: 2 }, { not: { metric: "c", is: true } }] }] };
    assert.deepEqual(referencedMetrics(rule).sort(), ["a", "b", "c"]);
  });
  it("returns [] for junk", () => {
    assert.deepEqual(referencedMetrics(null), []);
    assert.deepEqual(referencedMetrics(42), []);
  });
});

// ── Metric resolution ─────────────────────────────────────────────────────────

describe("metric resolution", () => {
  it("resolves DB count metrics", async () => {
    const sc = makeSc({ counts: { user_follows: 12 } });
    assert.equal(await resolveMetric(sc, U, "following_count", {}), 12);
  });
  it("resolves distinct stamp fields (cities_visited)", async () => {
    const sc = makeSc({ distinct: { "user_stamps.city": ["Cebu", "cebu", "Tokyo", ""] } });
    assert.equal(await resolveMetric(sc, U, "cities_visited", {}), 2); // dedup case-insensitive, drop blank
  });
  it("context wins over DB and coerces booleans", async () => {
    const sc = makeSc({ counts: { user_follows: 99 } });
    assert.equal(await resolveMetric(sc, U, "following_count", { context: { following_count: 3 } }), 3);
    assert.equal(await resolveMetric(sc, U, "is_solo_trip", { context: { is_solo_trip: true } }), 1);
  });
  it("context-only metric absent from context → 0 (fail-closed)", async () => {
    const sc = makeSc();
    assert.equal(await resolveMetric(sc, U, "trip_member_count", {}), 0);
  });
  it("knows registered metrics, rejects unknown", () => {
    assert.equal(isKnownMetric("trips_completed"), true);
    assert.equal(isKnownMetric("event_category_food"), true);
    assert.equal(isKnownMetric("made_up_metric"), false);
  });
});

// ── Evaluator ───────────────────────────────────────────────────────────────

describe("criteria evaluator", () => {
  it("passes a met threshold and fails an unmet one", async () => {
    const sc = makeSc({ counts: { trips: 7 } });
    const met = await evaluateCriteria(sc, U, { version: 1, all: [{ metric: "trips_completed", gte: 5 }] });
    assert.equal(met.met, true);
    assert.equal(met.checks[0].actual, 7);

    const notMet = await evaluateCriteria(sc, U, { version: 1, all: [{ metric: "trips_completed", gte: 10 }] });
    assert.equal(notMet.met, false);
    assert.equal(notMet.reason, "criteria_not_met");
  });

  it("supports single-leaf, any, and not", async () => {
    const sc = makeSc({ counts: { user_follows: 50 } });
    assert.equal((await evaluateCriteria(sc, U, { version: 1, metric: "followers_count", gte: 50 })).met, true);
    assert.equal((await evaluateCriteria(sc, U, { version: 1, any: [{ metric: "followers_count", gte: 999 }, { metric: "followers_count", gte: 10 }] })).met, true);
    assert.equal((await evaluateCriteria(sc, U, { version: 1, not: { metric: "followers_count", gte: 999 } })).met, true);
  });

  it("evaluates boolean `is` conditions from context", async () => {
    const sc = makeSc();
    const r = await evaluateCriteria(sc, U, { version: 1, all: [{ metric: "is_solo_trip", is: true }] }, { context: { is_solo_trip: true } });
    assert.equal(r.met, true);
  });

  it("fails closed on unknown metric, bad version, empty, and bad operator", async () => {
    const sc = makeSc();
    assert.equal((await evaluateCriteria(sc, U, { version: 1, all: [{ metric: "nope", gte: 1 }] })).reason.startsWith("criteria_unknown_metric"), true);
    assert.equal((await evaluateCriteria(sc, U, { version: 2, all: [{ metric: "trips_completed", gte: 1 }] })).malformed, true);
    assert.equal((await evaluateCriteria(sc, U, { version: 1, all: [] })).malformed, true);
    // leaf with two operators is ambiguous → malformed
    const twoOps = await evaluateCriteria(sc, U, { version: 1, all: [{ metric: "trips_completed", gte: 1, lte: 2 }] });
    assert.equal(twoOps.met, false);
  });

  it("memoizes: an all-group with the same metric twice resolves it once", async () => {
    let calls = 0;
    const sc = {
      from() {
        return {
          select() { return this; }, eq() { return this; }, not() { return this; }, in() { return this; },
          maybeSingle: async () => ({ data: null }),
          then(resolve: any) { calls++; resolve({ count: 8, error: null }); },
        } as any;
      },
    } as any;
    const r = await evaluateCriteria(sc, U, { version: 1, all: [{ metric: "trips_completed", gte: 5 }, { metric: "trips_completed", lte: 100 }] });
    assert.equal(r.met, true);
    assert.equal(calls, 1); // resolved once despite two references
  });
});

// ── Gate ──────────────────────────────────────────────────────────────────────

describe("criteria gate (additive)", () => {
  it("is a no-op when the definition has no criteria", async () => {
    const sc = makeSc({ flagOn: true });
    const g = await criteriaGate(sc, U, { criteria: null });
    assert.equal(g.blocked, false);
  });
  it("is a no-op when the flag is off (legacy authority preserved)", async () => {
    const sc = makeSc({ flagOn: false, counts: { trips: 0 } });
    const g = await criteriaGate(sc, U, { criteria: { version: 1, all: [{ metric: "trips_completed", gte: 5 }] } });
    assert.equal(g.blocked, false);
  });
  it("blocks when flag on + criteria not met", async () => {
    const sc = makeSc({ flagOn: true, counts: { trips: 1 } });
    const g = await criteriaGate(sc, U, { criteria: { version: 1, all: [{ metric: "trips_completed", gte: 5 }] } });
    assert.equal(g.blocked, true);
    assert.equal(g.reason, "criteria_not_met");
  });
  it("allows when flag on + criteria met", async () => {
    const sc = makeSc({ flagOn: true, counts: { trips: 9 } });
    const g = await criteriaGate(sc, U, { criteria: { version: 1, all: [{ metric: "trips_completed", gte: 5 }] } });
    assert.equal(g.blocked, false);
  });
});

// ── Evaluate + award ────────────────────────────────────────────────────────

describe("evaluateAndAwardCriteria", () => {
  it("returns [] when the flag is off", async () => {
    const sc = makeSc({ flagOn: false, defs: [{ slug: "x", criteria: { version: 1, all: [{ metric: "trips_completed", gte: 1 }] } }] });
    const out = await evaluateAndAwardCriteria(sc, U, {});
    assert.deepEqual(out, []);
  });

  it("awards met definitions and skips unmet ones (injected awardFn)", async () => {
    const sc = makeSc({
      flagOn: true,
      counts: { trips: 6, user_follows: 3 },
      defs: [
        { slug: "road_warrior", criteria: { version: 1, all: [{ metric: "trips_completed", gte: 5 }] } },
        { slug: "travel_influencer", criteria: { version: 1, all: [{ metric: "followers_count", gte: 500 }] } },
      ],
    });
    const awarded: string[] = [];
    const out = await evaluateAndAwardCriteria(sc, U, {
      awardFn: async ({ definitionSlug }) => { awarded.push(definitionSlug); return { awarded: true, reason: "awarded" }; },
    });
    const rw = out.find((o) => o.slug === "road_warrior")!;
    const ti = out.find((o) => o.slug === "travel_influencer")!;
    assert.equal(rw.met, true);
    assert.equal(rw.awarded, true);
    assert.equal(ti.met, false);
    assert.equal(ti.awarded, false);
    assert.deepEqual(awarded, ["road_warrior"]); // only the met one hit the award fn
  });
});

describe("schema version constant", () => {
  it("is 1", () => assert.equal(CRITERIA_SCHEMA_VERSION, 1));
});
