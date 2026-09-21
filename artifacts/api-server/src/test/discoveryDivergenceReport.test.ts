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

// ── `12` Phase 9 dimensions in the report (census DV-79) ──────────────────────
//
// Phase 9 asks the comparison to cover six axes. The reader could answer one.
// The other five needed facts the shadow row did not carry, so the writer now
// computes four of them at write time (lib/discoveryShadow.ts) and stores them
// inside the existing `pde_stages` jsonb. Two axes remain unmeasurable on this
// surface and are NAMED on every row rather than defaulted to zero.
//
// The property that matters most here is the one a naive aggregation gets
// wrong: a group holding a mix of dimensioned and un-dimensioned rows must
// report the mean over the DIMENSIONED ones and say how many those were. Taking
// the mean over all rows with the missing ones as zero would report a
// diversity collapse that never happened.
import { aggregatePhase9, formatPhase9, type ShadowPhase9Blob } from "../lib/discoveryDivergenceReport.js";

function dims(over: Partial<ShadowPhase9Blob["legacy"]> = {}): ShadowPhase9Blob["legacy"] {
  return {
    n: 20, categoryDistinct: 4, categoryEntropy: 0.8, placeDistinct: 20,
    neighborhoodDistinct: 3, geoCellDistinct: 6, meanSavedCount: 10, savedCountCoverage: 1,
    ...over,
  };
}
function phase9(legacy = dims(), pde = dims()): ShadowPhase9Blob {
  return {
    legacy, pde,
    creatorConcentration: null, estimatedTravelIntent: null,
    unmeasured: ["creator_concentration", "estimated_travel_intent"],
  };
}

describe("Phase 9 dimensions — aggregation", () => {
  it("a group with no dimensioned row reports null, not a diversity of zero", () => {
    assert.equal(
      aggregatePhase9([row({}), row({})]), null,
      "rows written before the dimensions existed must read as UNKNOWN; zero would be a measurement nobody made",
    );
  });

  it("DEFECT: un-dimensioned rows are EXCLUDED from the mean, and the count says how many were used", () => {
    const agg = aggregatePhase9([
      row({ pde_stages: { phase9: phase9(dims({ categoryDistinct: 4 }), dims({ categoryDistinct: 8 })) } }),
      row({}),                       // no phase9 blob
      row({ pde_stages: null }),     // explicitly none
    ]);
    assert.ok(agg);
    assert.equal(agg!.n, 1, "exactly one row carried dimensions, and the report must say so");
    assert.equal(
      agg!.meanCategoryDistinctLegacy, 4,
      "the mean must be over the ONE dimensioned row — averaging in two zeroes would report 1.33 and invent a collapse",
    );
    assert.equal(agg!.meanCategoryDistinctPde, 8);
  });

  it("keeps legacy and PDE on separate axes — never one blended delta", () => {
    const agg = aggregatePhase9([
      row({ pde_stages: { phase9: phase9(
        dims({ neighborhoodDistinct: 2, geoCellDistinct: 3, meanSavedCount: 5,  categoryEntropy: 0.4 }),
        dims({ neighborhoodDistinct: 6, geoCellDistinct: 9, meanSavedCount: 25, categoryEntropy: 0.9 }),
      ) } }),
    ]);
    assert.equal(agg!.meanNeighborhoodDistinctLegacy, 2);
    assert.equal(agg!.meanNeighborhoodDistinctPde, 6);
    assert.equal(agg!.meanGeoCellDistinctLegacy, 3);
    assert.equal(agg!.meanGeoCellDistinctPde, 9);
    assert.equal(agg!.meanSavedCountLegacy, 5);
    assert.equal(agg!.meanSavedCountPde, 25);
    assert.equal(agg!.meanCategoryEntropyLegacy, 0.4);
    assert.equal(agg!.meanCategoryEntropyPde, 0.9);
  });

  it("a page with NO known save counts contributes no save mean, rather than a zero", () => {
    const agg = aggregatePhase9([
      row({ pde_stages: { phase9: phase9(
        dims({ meanSavedCount: null, savedCountCoverage: 0 }),
        dims({ meanSavedCount: 12,   savedCountCoverage: 0.5 }),
      ) } }),
    ]);
    assert.equal(agg!.meanSavedCountLegacy, null, "no known count on any item means no mean, not a mean of zero");
    assert.equal(agg!.meanSavedCountPde, 12);
    assert.equal(agg!.meanSavedCoverageLegacy, 0);
    assert.equal(agg!.meanSavedCoveragePde, 0.5);
  });

  it("carries the unmeasured axes through from the rows, and never invents its own list", () => {
    const agg = aggregatePhase9([row({ pde_stages: { phase9: phase9() } })]);
    assert.deepEqual(agg!.unmeasured, ["creator_concentration", "estimated_travel_intent"]);
  });

  it("the printed report says 'not recorded' rather than printing zeros", () => {
    const lines = formatPhase9(null);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /not recorded/);
    assert.doesNotMatch(lines[0], /0\.00/, "an unmeasured group must not print a number a reader could quote");
  });

  it("the printed report names the axes it did NOT measure", () => {
    const lines = formatPhase9(aggregatePhase9([row({ pde_stages: { phase9: phase9() } })])).join("\n");
    assert.match(lines, /NOT measured\s+creator_concentration, estimated_travel_intent/);
  });
});

describe("Phase 9 dimensions — reaching aggregateDivergence", () => {
  it("each divergence group carries its own phase9 block, segregated like everything else", () => {
    const groups = aggregateDivergence([
      row({ serve_point: 1, pde_stages: { phase9: phase9(dims({ categoryDistinct: 2 }), dims({ categoryDistinct: 2 })) } }),
      row({ serve_point: 6, pde_stages: { phase9: phase9(dims({ categoryDistinct: 9 }), dims({ categoryDistinct: 9 })) } }),
    ]);
    const cacheA   = groups.find((g) => g.servePointClass === "cache_a")!;
    const coldRank = groups.find((g) => g.servePointClass === "cold_rank")!;
    assert.equal(cacheA.phase9!.meanCategoryDistinctLegacy, 2);
    assert.equal(
      coldRank.phase9!.meanCategoryDistinctLegacy, 9,
      "the dimensions must be segregated by serve-point class exactly as the rates are — pooling them is the error the module header forbids",
    );
  });
});
