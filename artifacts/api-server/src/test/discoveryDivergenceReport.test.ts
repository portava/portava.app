/**
 * Stage-3 divergence aggregation (lib/discoveryDivergenceReport.ts).
 *
 * The load-bearing property is the SEGREGATION: cache-A serves (legacy ran no
 * ranker) must never be pooled with cold-fetch serves (legacy did rank), and
 * different sort_by / cohort_reason must not be summed — pooling them
 * misrepresents divergence. The rates and cost percentiles are checked too.
 *
 * Run: node --import tsx/esm --test src/test/discoveryDivergenceReport.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateDivergence,
  classifyServePoint,
  percentile,
  type ShadowServeRow,
} from "../lib/discoveryDivergenceReport.js";

function row(over: Partial<ShadowServeRow>): ShadowServeRow {
  return {
    serve_point: 1, sort_by: null, cohort_reason: "percent",
    page_size: 20, legacy_total: 40, pde_total: 40,
    overlap_count: 20, displaced_count: 0, top_changed: false,
    legacy_ms: 10, pde_ms: 30, pde_suppressed_writes: 6,
    ...over,
  };
}

describe("classifyServePoint", () => {
  it("splits cache-A (1/2/3), cold-rank (6), and other", () => {
    assert.equal(classifyServePoint(1), "cache_a");
    assert.equal(classifyServePoint(2), "cache_a");
    assert.equal(classifyServePoint(3), "cache_a");
    assert.equal(classifyServePoint(6), "cold_rank");
    assert.equal(classifyServePoint(5), "other");
    assert.equal(classifyServePoint(9), "other");
  });
});

describe("percentile", () => {
  it("nearest-rank; null for empty", () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([10], 0.95), 10);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  });
});

describe("aggregateDivergence — segregation", () => {
  it("never pools cache-A with cold-rank, nor across sort_by / cohort_reason", () => {
    const rows: ShadowServeRow[] = [
      row({ serve_point: 1, sort_by: null,      cohort_reason: "percent" }),
      row({ serve_point: 2, sort_by: null,      cohort_reason: "percent" }), // same group as above
      row({ serve_point: 6, sort_by: null,      cohort_reason: "percent" }), // cold-rank → own group
      row({ serve_point: 1, sort_by: "popular", cohort_reason: "percent" }), // different sort → own group
      row({ serve_point: 1, sort_by: null,      cohort_reason: "internal" }),// different cohort → own group
    ];
    const groups = aggregateDivergence(rows);
    assert.equal(groups.length, 4, "cache_a/default/percent, cold_rank, cache_a/popular, cache_a/default/internal");
    // cache_a is ordered before cold_rank.
    assert.equal(groups[0].servePointClass, "cache_a");
    const cold = groups.find((g) => g.servePointClass === "cold_rank");
    assert.ok(cold, "cold-rank must be its own group");
    assert.equal(cold!.n, 1);
    // The two serve-point-1/2 default/percent rows are one group of 2.
    const cacheDefaultPercent = groups.find(
      (g) => g.servePointClass === "cache_a" && g.sortBy === "default" && g.cohortReason === "percent",
    );
    assert.equal(cacheDefaultPercent!.n, 2, "serve points 1 and 2 share the cache_a/default/percent group");
  });
});

describe("aggregateDivergence — rates and cost", () => {
  it("computes top-changed rate, displacement, membership change, overlap, and ms percentiles", () => {
    const rows: ShadowServeRow[] = [
      row({ top_changed: true,  displaced_count: 4, overlap_count: 16, page_size: 20, pde_ms: 20, legacy_ms: 5 }),
      row({ top_changed: false, displaced_count: 2, overlap_count: 18, page_size: 20, pde_ms: 60, legacy_ms: 15 }),
    ];
    const [g] = aggregateDivergence(rows);
    assert.equal(g.n, 2);
    assert.equal(g.topChangedRate, 0.5, "one of two changed the top");
    assert.equal(g.meanDisplaced, 3, "(4+2)/2");
    assert.equal(g.meanMembershipChange, 3, "((20-16)+(20-18))/2 = (4+2)/2");
    assert.equal(g.meanOverlapRate, (16 / 20 + 18 / 20) / 2);
    assert.equal(g.pdeMsP50, 20);   // nearest-rank p50 of [20,60]
    assert.equal(g.pdeMsP95, 60);
    assert.equal(g.legacyMsP95, 15);
    assert.equal(g.meanSuppressedWrites, 6);
  });

  it("tolerates null timings without crashing", () => {
    const [g] = aggregateDivergence([row({ legacy_ms: null, pde_ms: null })]);
    assert.equal(g.pdeMsP50, null);
    assert.equal(g.legacyMsP50, null);
  });
});
