/**
 * P1 Stage 2 shadow observation (lib/discoveryShadow.ts).
 *
 * WHAT MUST HOLD
 * ==============
 * Shadow mode's promise is that it observes and changes nothing. Two halves:
 *
 *   1. The comparison must mean what a reader will assume it means. It compares
 *      the SERVED PAGES, not the full ranked lists — a reordering below the
 *      fold changed nothing anybody saw, and counting it would inflate every
 *      figure the table produces.
 *
 *   2. The write must never be able to damage a request. It is issued after the
 *      response has left, so its only possible failure mode is being lost; that
 *      is acceptable and is logged. Throwing is not acceptable.
 *
 * The row shape is asserted too. A column silently dropped from the insert is
 * how a table ends up "instrumented" and holding nulls in the column the whole
 * analysis turns on.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryShadow.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareServedOrders, logDiscoveryShadowServe } from "../lib/discoveryShadow.js";

function captureClient(result: { error?: unknown } = {}) {
  const rows: any[] = [];
  const client: any = {
    from(table: string) {
      return {
        insert: async (row: any) => { rows.push({ table, row }); return { error: result.error ?? null }; },
      };
    },
  };
  return { client, rows };
}

const BASE = {
  userId: "u-1",
  destination: "Paris, France",
  category: "food",
  radiusKm: 10,
  page: 1,
  pageSize: 20,
  sortBy: null,
  servePoint: 1,
  cacheLevel: "L1",
  legacyIds: ["a", "b", "c"],
  legacyTotal: 3,
  legacyMs: 12,
  pdeIds: ["c", "a", "b"],
  pdeTotal: 3,
  pdeMs: 40,
  pdeStages: { portavaRank: true, drs: true, analytics: false, suppressedWrites: 6 },
  pdeSuppressedWrites: 6,
  engineMode: "shadow",
  modeReason: "resolved",
};

describe("shadow comparison", () => {
  it("A. identical pages diverge in nothing", () => {
    const c = compareServedOrders(["a", "b", "c"], ["a", "b", "c"]);
    assert.deepEqual(c, { overlapCount: 3, displacedCount: 0, topChanged: false });
  });

  it("B. a reordering is displacement, not a change of membership", () => {
    const c = compareServedOrders(["a", "b", "c"], ["c", "b", "a"]);
    assert.equal(c.overlapCount, 3, "the same three items are on both pages");
    assert.equal(c.displacedCount, 2, "b kept position 1; a and c moved");
    assert.equal(c.topChanged, true);
  });

  it("C. items PDE would have promoted onto the page are not counted as overlap", () => {
    const c = compareServedOrders(["a", "b"], ["z", "a"]);
    assert.equal(c.overlapCount, 1);
    assert.equal(c.displacedCount, 1, "a moved from 0 to 1");
    assert.equal(c.topChanged, true);
  });

  it("D. two empty pages agree; an empty page against a populated one does not", () => {
    assert.deepEqual(
      compareServedOrders([], []),
      { overlapCount: 0, displacedCount: 0, topChanged: false },
    );
    const c = compareServedOrders([], ["a"]);
    assert.equal(c.topChanged, true, "empty vs populated must never read as agreement");
    assert.equal(c.overlapCount, 0);
  });

  it("E. total disagreement overlaps in nothing", () => {
    const c = compareServedOrders(["a", "b"], ["x", "y"]);
    assert.deepEqual(c, { overlapCount: 0, displacedCount: 0, topChanged: true });
  });

  it("F. a duplicated id resolves to its first position, not its last", () => {
    // Defensive: ids should be unique per page, but if a merge bug ever produced
    // a duplicate, the comparison must stay deterministic rather than depending
    // on iteration order.
    const c = compareServedOrders(["a"], ["a", "a"]);
    assert.equal(c.overlapCount, 1);
    assert.equal(c.displacedCount, 0);
  });
});

describe("shadow write", () => {
  it("G. writes exactly one row, to discovery_shadow_serves", async () => {
    const { client, rows } = captureClient();
    await logDiscoveryShadowServe(client, BASE);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].table, "discovery_shadow_serves");
  });

  it("H. the row carries every column the analysis depends on", async () => {
    const { client, rows } = captureClient();
    await logDiscoveryShadowServe(client, BASE);
    const row = rows[0].row;

    // Both orders and the serve point — the packet's stated deliverable.
    assert.deepEqual(row.legacy_ids, ["a", "b", "c"]);
    assert.deepEqual(row.pde_ids,    ["c", "a", "b"]);
    assert.equal(row.serve_point, 1);
    // Both timings.
    assert.equal(row.legacy_ms, 12);
    assert.equal(row.pde_ms,    40);
    // Provenance — "shadow by configuration" must stay distinguishable from a
    // fallback that happens to look the same.
    assert.equal(row.engine_mode, "shadow");
    assert.equal(row.mode_reason, "resolved");
    // The precomputed comparison.
    assert.equal(row.overlap_count, 3);
    // a 0→1, b 1→2, c 2→0 — a rotation displaces every item.
    assert.equal(row.displaced_count, 3);
    assert.equal(row.top_changed, true);
    // The suppression counter, which is how the write guard stays observable.
    assert.equal(row.pde_suppressed_writes, 6);
    // Request shape.
    assert.equal(row.destination, "Paris, France");
    assert.equal(row.category, "food");
    assert.equal(row.radius_km, 10);
    assert.equal(row.page, 1);
    assert.equal(row.page_size, 20);
  });

  it("I. it writes to no other table", async () => {
    const { client, rows } = captureClient();
    await logDiscoveryShadowServe(client, BASE);
    assert.deepEqual([...new Set(rows.map((r) => r.table))], ["discovery_shadow_serves"]);
  });

  it("J. a rejected insert is survived, not thrown", async () => {
    const { client } = captureClient({ error: { message: "column does not exist" } });
    await logDiscoveryShadowServe(client, BASE); // must not reject
  });

  it("K. a client that throws is survived", async () => {
    const detonator: any = { from() { throw new Error("db down"); } };
    await logDiscoveryShadowServe(detonator, BASE);
  });

  it("L. a null client writes nothing and does not throw", async () => {
    await logDiscoveryShadowServe(null, BASE);
  });

  it("M. optional fields default rather than writing undefined", async () => {
    const { client, rows } = captureClient();
    await logDiscoveryShadowServe(client, {
      ...BASE,
      sessionId: undefined, cacheLevel: undefined, sortBy: undefined,
      legacyMs: undefined, pdeMs: undefined,
      pdeStages: undefined, pdeSuppressedWrites: undefined,
    });
    const row = rows[0].row;
    assert.equal(row.session_id, null);
    assert.equal(row.cache_level, null);
    assert.equal(row.sort_by, null);
    assert.equal(row.legacy_ms, null);
    assert.equal(row.pde_ms, null);
    assert.deepEqual(row.pde_stages, {});
    assert.equal(row.pde_suppressed_writes, 0, "NOT NULL in the schema — a default, never undefined");
  });
});

// ── Phase 9 comparison dimensions (census DV-79) ──────────────────────────────
//
// REQUIREMENT
// ===========
// docs/specs/discovery-v1/12_Claude_Code_Implementation.md Phase 9 (`:125`):
// "Compute PDE ranking without serving it. Compare: overlap, save rate
// potential, diversity, creator concentration, place diversity, estimated
// travel intent."
//
// Before this, `compareServedOrders` computed overlap, displacement and top-1
// change — one of the six axes, richer than asked on that one and silent on the
// other five. The page rows needed for four of them were already in the caller's
// hand at the shadow call site and were thrown away before the write.
//
// WHAT IS DELIBERATELY NOT COMPUTED, AND WHY THE TEST SAYS SO
// ===========================================================
// creator concentration — a served Discovery row (DiscoveryPlace) carries NO
//   author: there is no `submitted_by`, `authorId` or `creatorId` field on it,
//   so concentration over creators cannot be computed from a served page at all.
// estimated travel intent — no trip-add / itinerary-add signal is attached to a
//   served item; inventing one from distance would be a proxy dressed as a
//   measurement.
// Both are reported as UNKNOWN (null), never as zero. A zero would read as
// "measured, and it was none".
import {
  pageDimensions,
  compareShadowPages,
  type ShadowPageItem,
} from "../lib/discoveryShadow.js";

function pi(over: Partial<ShadowPageItem> & { id: string }): ShadowPageItem {
  return { category: "food", neighborhood: "A", lat: 0, lng: 0, savedCount: 0, ...over };
}

describe("Phase 9 — pageDimensions", () => {
  it("an empty page measures nothing and claims nothing", () => {
    const d = pageDimensions([]);
    assert.equal(d.n, 0);
    assert.equal(d.categoryDistinct, 0);
    assert.equal(d.meanSavedCount, null, "no items means no mean — 0 would read as 'measured, and it was zero'");
    assert.equal(d.savedCountCoverage, 0);
  });

  it("diversity: distinct content categories, and entropy that separates even from lopsided", () => {
    const even     = [pi({ id: "1", category: "food" }), pi({ id: "2", category: "bars" }),
                      pi({ id: "3", category: "art" }),  pi({ id: "4", category: "parks" })];
    const lopsided = [pi({ id: "1", category: "food" }), pi({ id: "2", category: "food" }),
                      pi({ id: "3", category: "food" }), pi({ id: "4", category: "parks" })];
    assert.equal(pageDimensions(even).categoryDistinct, 4);
    assert.equal(pageDimensions(lopsided).categoryDistinct, 2);
    assert.ok(
      pageDimensions(even).categoryEntropy > pageDimensions(lopsided).categoryEntropy,
      "a page of four categories must read as more diverse than one dominated by a single category — a distinct COUNT alone cannot see that",
    );
    assert.equal(pageDimensions(even).categoryEntropy, 1, "an even spread is maximum normalized entropy");
  });

  it("place diversity: distinct places, neighborhoods and geo cells are three different questions", () => {
    const items = [
      pi({ id: "a", neighborhood: "Wynwood", lat: 25.805, lng: -80.195 }),
      pi({ id: "b", neighborhood: "Wynwood", lat: 25.806, lng: -80.196 }),
      pi({ id: "c", neighborhood: "Brickell", lat: 25.765, lng: -80.195 }),
    ];
    // NOTE: cells are a fixed grid, so two points 150 m apart that straddle a
    // boundary land in different cells. That is a property of grid bucketing,
    // not a defect — the measure is "how spread out is this page", and a page
    // whose items sit on one boundary is measured as slightly more spread than
    // it is. Stated so the number is read as what it is.
    const d = pageDimensions(items);
    assert.equal(d.placeDistinct, 3);
    assert.equal(d.neighborhoodDistinct, 2);
    assert.equal(
      d.geoCellDistinct, 2,
      "two places 150 m apart share a cell; one 4 km away does not — geography is not the same axis as neighborhood labelling",
    );
  });

  it("save-rate potential is a mean over KNOWN counts, and reports its own coverage", () => {
    const d = pageDimensions([
      pi({ id: "a", savedCount: 10 }),
      pi({ id: "b", savedCount: 20 }),
      pi({ id: "c", savedCount: undefined }),
    ]);
    assert.equal(d.meanSavedCount, 15, "the mean must be over the items that HAVE a count, not over all items with the unknowns as 0");
    assert.equal(
      Math.round(d.savedCountCoverage * 100) / 100, 0.67,
      "coverage must travel with the mean — a mean over one of twenty items is not the same fact as a mean over twenty",
    );
  });
});

describe("Phase 9 — compareShadowPages", () => {
  const legacy = [pi({ id: "a", category: "food", savedCount: 2 }), pi({ id: "b", category: "food", savedCount: 2 })];
  const pde    = [pi({ id: "a", category: "food", savedCount: 2 }), pi({ id: "c", category: "art", neighborhood: "B", lat: 1, lng: 1, savedCount: 30 })];

  it("carries the existing order comparison unchanged", () => {
    const cmp = compareShadowPages(legacy, pde);
    assert.equal(cmp.overlapCount, 1, "one shared id");
    assert.equal(cmp.topChanged, false, "position 0 is `a` on both pages");
  });

  it("reports all four computable Phase 9 axes for BOTH pages, never one blended number", () => {
    const cmp = compareShadowPages(legacy, pde);
    assert.equal(cmp.dimensions.legacy.categoryDistinct, 1);
    assert.equal(cmp.dimensions.pde.categoryDistinct, 2);
    assert.equal(cmp.dimensions.legacy.neighborhoodDistinct, 1);
    assert.equal(cmp.dimensions.pde.neighborhoodDistinct, 2);
    assert.equal(cmp.dimensions.legacy.meanSavedCount, 2);
    assert.equal(cmp.dimensions.pde.meanSavedCount, 16);
  });

  it("the two axes this surface cannot measure are UNKNOWN, not zero", () => {
    const cmp = compareShadowPages(legacy, pde);
    assert.equal(
      cmp.dimensions.creatorConcentration, null,
      "a served DiscoveryPlace carries no author; reporting 0 concentration would assert a measurement that was never made",
    );
    assert.equal(
      cmp.dimensions.estimatedTravelIntent, null,
      "no trip-add / itinerary-add signal is attached to a served item; a distance proxy is not travel intent",
    );
    assert.deepEqual(
      cmp.dimensions.unmeasured, ["creator_concentration", "estimated_travel_intent"],
      "the unmeasured axes must be NAMED on every row, so a reader of the report cannot mistake silence for a zero",
    );
  });
});

describe("Phase 9 — the WRITER actually stores the dimensions", () => {
  // Mutation M3 found this gap: with the pure functions fully covered, deleting
  // the writer's call to them left every test green. A dimension nobody stores
  // is a dimension the report can never read.
  const items = (specs: Array<[string, string, number]>) =>
    specs.map(([id, category, savedCount]) => ({
      id, category, neighborhood: category, lat: 48.85, lng: 2.35, savedCount,
    }));

  it("stores phase9 inside the existing pde_stages jsonb when both pages are supplied", async () => {
    const { client, rows } = captureClient();
    await logDiscoveryShadowServe(client, {
      ...BASE,
      cohortReason: "percent_in",
      legacyItems: items([["a", "food", 1], ["b", "food", 1], ["c", "food", 1]]),
      pdeItems:    items([["c", "art", 40], ["a", "food", 1], ["b", "bars", 2]]),
    });
    const stages = rows[0].row.pde_stages;
    assert.equal(stages.portavaRank, true, "the existing pde_stages content must survive, not be replaced");
    assert.ok(stages.phase9, "12 Phase 9's dimensions must be stored, or the report has nothing to read");
    assert.equal(stages.phase9.legacy.categoryDistinct, 1);
    assert.equal(stages.phase9.pde.categoryDistinct, 3);
    assert.deepEqual(stages.phase9.unmeasured, ["creator_concentration", "estimated_travel_intent"]);
  });

  it("omits phase9 entirely when a caller passes ids only — absent, never a row of zeros", async () => {
    const { client, rows } = captureClient();
    await logDiscoveryShadowServe(client, { ...BASE, cohortReason: "percent_in" });
    assert.equal(
      rows[0].row.pde_stages.phase9, undefined,
      "a caller with no page rows must write NO dimensions; zeros would be indistinguishable from a measured collapse",
    );
    assert.equal(rows[0].row.pde_stages.portavaRank, true, "and the row is otherwise unchanged");
  });
});
