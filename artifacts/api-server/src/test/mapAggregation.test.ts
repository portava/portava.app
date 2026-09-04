/**
 * mapAggregation — Lane H: server-side viewport aggregation (Map spec §6, §10,
 * §17, §19, §23, §31).
 *
 * These tests pin the three properties the module exists to guarantee:
 *
 *   1. CONSERVATION — every input object is accounted for exactly once as
 *      aggregated, individual or dropped. Nothing is silently truncated.
 *   2. ONE-WAY PRECISION — aggregation only ever coarsens. Confidence takes the
 *      weakest band, freshness the oldest state, privacy the narrowest class,
 *      and the emitted zone geometry always CONTAINS its contributors.
 *   3. SUPPRESSION, NOT SHRINKAGE — a cell below the cohort floor produces
 *      nothing at all. A lone traveler never becomes a small zone.
 *
 * Plus §10's four crowd-flow gates, each proven to block on its own.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVITY_COHORT_MULTIPLES,
  AGGREGATING_BANDS,
  CELL_SIZE_DEGREES_BY_ZOOM,
  CROWD_FLOW_SIGNAL_FAMILIES,
  FLOW_DENSITY_BUCKET_MINUTES,
  FRESHNESS_STALENESS_RANK,
  KM_PER_DEGREE_LAT,
  MERCATOR_MAX_LAT,
  MIN_FLOW_COHORT_PER_BUCKET,
  MIN_SIGNAL_FAMILIES,
  INFERRED_CAUSE_LABEL,
  MIN_ZONE_COHORT,
  NEVER_AGGREGATED_KINDS,
  ZOOM_BANDS,
  ZOOM_BAND_RANGES,
  activityForCohort,
  aggregateForViewport,
  aggregateTrend,
  bandAggregates,
  bboxContains,
  bboxFromCenterRadius,
  cellFor,
  cellPolygon,
  cellSizeDegreesFor,
  cohortSizeOf,
  cohortWeightOf,
  deriveCrowdFlow,
  foldPrivacyClass,
  isNeverAggregated,
  lngLatToTile,
  normalizeLng,
  oldestFreshness,
  resolveCohortFloor,
  summarizeCell,
  tileToLngLat,
  weakestConfidence,
  zoomBandFor,
  type BBox,
  type ZoneTransition,
} from "../lib/mapAggregation.js";
import {
  KIND_DEFAULT_PRIORITY,
  centroidOf,
  isServable,
  point,
  type MapObject,
} from "../lib/mapObjects.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WORLD_BBOX: BBox = { west: -180, south: -90, east: 180, north: 90 };

let seq = 0;
function mk(lat: number, lng: number, over: Partial<MapObject> = {}): MapObject {
  seq += 1;
  return {
    id: `o${String(seq).padStart(4, "0")}`,
    kind: "social_zone",
    geometry: point(lat, lng),
    title: "Signal",
    privacyClass: "aggregate_only",
    renderingPriority: KIND_DEFAULT_PRIORITY.social_zone,
    ...over,
  };
}

/** `n` contributors around one coordinate, close enough to share a cell. */
function cluster(n: number, lat: number, lng: number, over: Partial<MapObject> = {}): MapObject[] {
  return Array.from({ length: n }, (_, i) => mk(lat + i * 0.0001, lng + i * 0.0001, over));
}

function accountedFor(res: ReturnType<typeof aggregateForViewport>, inputCount: number): void {
  assert.equal(
    res.aggregated + res.individual + res.dropped,
    inputCount,
    `conservation broken: ${res.aggregated} + ${res.individual} + ${res.dropped} !== ${inputCount}`,
  );
}

// ── The k floor ───────────────────────────────────────────────────────────────

describe("mapAggregation — the cohort floor is the codebase's own k", () => {
  it("MIN_ZONE_COHORT is PRIVACY_THRESHOLD_V1.minUniqueActors, not a new number", () => {
    assert.equal(MIN_ZONE_COHORT, PRIVACY_THRESHOLD_V1.minUniqueActors);
    assert.equal(MIN_ZONE_COHORT, 15);
  });

  it("an override may only ever TIGHTEN the floor", () => {
    assert.equal(resolveCohortFloor(undefined), MIN_ZONE_COHORT);
    assert.equal(resolveCohortFloor(null), MIN_ZONE_COHORT);
    // Looser is refused — the max() keeps the product floor.
    assert.equal(resolveCohortFloor(2), MIN_ZONE_COHORT);
    // Stricter is honoured.
    assert.equal(resolveCohortFloor(40), 40);
  });

  it("fail-closed on an unusable override (NaN k suppresses via meetsKAnonymity)", () => {
    assert.ok(Number.isNaN(resolveCohortFloor(Number.NaN)));
    assert.ok(Number.isNaN(resolveCohortFloor(0)));
    assert.ok(Number.isNaN(resolveCohortFloor(-5)));
    const zone = summarizeCell(cluster(50, 16.05, 108.2), { zoom: 3, k: 0 });
    assert.equal(zone, null, "an invalid k must suppress, never default to permissive");
  });

  it("cohort weight: absent count is 1; an unusable count is UNKNOWN (null)", () => {
    assert.equal(cohortWeightOf(mk(0, 0)), 1);
    assert.equal(cohortWeightOf(mk(0, 0, { count: 18 })), 18);
    assert.equal(cohortWeightOf(mk(0, 0, { count: Number.NaN })), null);
    assert.equal(cohortWeightOf(mk(0, 0, { count: -3 })), null);
    assert.equal(cohortWeightOf(mk(0, 0, { count: 2.5 })), null);
    assert.equal(cohortWeightOf(mk(0, 0, { count: 0 })), null);
    assert.equal(cohortWeightOf(mk(0, 0, { count: Number.POSITIVE_INFINITY })), null);
  });

  it("one unknown count poisons the whole cohort", () => {
    const good = cluster(20, 16.05, 108.2);
    assert.equal(cohortSizeOf(good), 20);
    assert.equal(cohortSizeOf([...good, mk(16.05, 108.2, { count: Number.NaN })]), null);
  });
});

describe("mapAggregation — summarizeCell suppresses rather than shrinks", () => {
  it("suppresses a sub-threshold cell entirely", () => {
    const under = cluster(MIN_ZONE_COHORT - 1, 16.05, 108.2);
    assert.equal(summarizeCell(under, { zoom: 3 }), null);
  });

  it("publishes at exactly the floor", () => {
    const at = cluster(MIN_ZONE_COHORT, 16.05, 108.2);
    const zone = summarizeCell(at, { zoom: 3 });
    assert.ok(zone, "a cohort at exactly k must publish");
    assert.equal(zone.count, MIN_ZONE_COHORT);
    assert.equal(zone.kind, "activity_zone");
  });

  it("A SINGLE TRAVELER NEVER YIELDS A ZONE (§23, §37 'no public people tracker')", () => {
    const lone = mk(16.0544, 108.2022, { kind: "social_zone", count: 1 });
    assert.equal(summarizeCell([lone], { zoom: 3 }), null);
    assert.equal(summarizeCell([lone], { zoom: 11 }), null);

    // And not through the viewport path either, at any aggregating zoom.
    for (const zoom of [0, 3, 6, 11]) {
      const res = aggregateForViewport([lone], { bbox: WORLD_BBOX, zoom });
      assert.equal(res.zones, 0, `zoom ${zoom} produced a zone for one person`);
      assert.equal(res.objects.length, 0);
      assert.equal(res.suppressedForKAnonymity, 1);
      accountedFor(res, 1);
    }
  });

  it("a lone traveler carrying an inflated count is still counted as declared, not inferred", () => {
    // One object declaring count 20 IS a cohort of 20 — the caller's count is
    // authoritative (privacyGate makes the same choice). But a declared 1 is 1.
    assert.ok(summarizeCell([mk(16.05, 108.2, { count: 20 })], { zoom: 3 }));
    assert.equal(summarizeCell([mk(16.05, 108.2, { count: 1 })], { zoom: 3 }), null);
  });

  it("suppresses when the cohort count is unknown", () => {
    const objs = [...cluster(30, 16.05, 108.2), mk(16.05, 108.2, { count: Number.NaN })];
    assert.equal(summarizeCell(objs, { zoom: 3 }), null);
  });

  it("suppresses when the folded privacy class is `none`", () => {
    // `none` inputs are unservable and filtered out first, so the remaining
    // cohort falls under k — either way, nothing is published.
    const objs = cluster(30, 16.05, 108.2, { privacyClass: "none" });
    assert.equal(summarizeCell(objs, { zoom: 3 }), null);
  });

  it("suppresses an empty cell", () => {
    assert.equal(summarizeCell([], { zoom: 3 }), null);
  });
});

// ── Conservative folds ────────────────────────────────────────────────────────

describe("mapAggregation — an aggregate is never stronger than its evidence", () => {
  it("confidence takes the WEAKEST contributing band", () => {
    const objs = [
      mk(16.05, 108.2, { confidence: "strong" }),
      mk(16.05, 108.2, { confidence: "likely_current" }),
      mk(16.05, 108.2, { confidence: "provisional" }),
    ];
    assert.equal(weakestConfidence(objs), "provisional");
  });

  it("a contributor with NO band drags the aggregate to the weakest band", () => {
    const objs = [mk(16.05, 108.2, { confidence: "strong" }), mk(16.05, 108.2)];
    assert.equal(weakestConfidence(objs), "unverified");
  });

  it("asserts nothing when no contributor carries a band at all", () => {
    assert.equal(weakestConfidence(cluster(20, 16.05, 108.2)), undefined);
  });

  it("freshness takes the OLDEST contributing state", () => {
    const objs = [
      mk(16.05, 108.2, { freshness: "live" }),
      mk(16.05, 108.2, { freshness: "recent" }),
      mk(16.05, 108.2, { freshness: "stale" }),
    ];
    assert.equal(oldestFreshness(objs), "stale");
  });

  it("`unknown` outranks even `historical` — an undatable input is the weakest position", () => {
    assert.equal(FRESHNESS_STALENESS_RANK.unknown > FRESHNESS_STALENESS_RANK.historical, true);
    assert.equal(
      oldestFreshness([mk(0, 0, { freshness: "historical" }), mk(0, 0, { freshness: "live" })]),
      "historical",
    );
    assert.equal(
      oldestFreshness([mk(0, 0, { freshness: "historical" }), mk(0, 0)]),
      "unknown",
      "a contributor with no freshness must not be ignored",
    );
  });

  it("privacy class propagates via narrowestPrivacyClass (only ever tightens)", () => {
    assert.equal(
      foldPrivacyClass([
        mk(0, 0, { privacyClass: "precise_temporary" }),
        mk(0, 0, { privacyClass: "place_level" }),
        mk(0, 0, { privacyClass: "aggregate_only" }),
      ]),
      "aggregate_only",
    );
    assert.equal(
      foldPrivacyClass([
        mk(0, 0, { privacyClass: "approximate" }),
        mk(0, 0, { privacyClass: "precise_temporary" }),
      ]),
      "approximate",
    );
    assert.equal(
      foldPrivacyClass([mk(0, 0, { privacyClass: "approximate" }), mk(0, 0, { privacyClass: "none" })]),
      "none",
      "a `none` contributor must poison the aggregate",
    );
    assert.equal(foldPrivacyClass([]), "none");
  });

  it("the emitted zone carries the weakest/oldest/narrowest of its inputs", () => {
    const objs = [
      ...cluster(10, 16.05, 108.2, {
        confidence: "strong",
        freshness: "live",
        privacyClass: "place_level",
      }),
      ...cluster(10, 16.06, 108.21, {
        confidence: "provisional",
        freshness: "stale",
        privacyClass: "aggregate_only",
      }),
    ];
    const zone = summarizeCell(objs, { zoom: 3 });
    assert.ok(zone);
    assert.equal(zone.confidence, "provisional");
    assert.equal(zone.freshness, "stale");
    assert.equal(zone.privacyClass, "aggregate_only");
    assert.equal(zone.renderingPriority, KIND_DEFAULT_PRIORITY.activity_zone);
    assert.equal(zone.provenance?.confidence, "provisional");
  });

  it("never re-attaches contributor identifiers", () => {
    const zone = summarizeCell(cluster(20, 16.05, 108.2), { zoom: 3 });
    assert.ok(zone);
    assert.equal(zone.sourceRefs, undefined);
    const text = JSON.stringify(zone);
    assert.equal(/"o0\d{3}"/.test(text), false, "a contributor id leaked into the aggregate");
  });

  it("the zone geometry CONTAINS every contributor — aggregation never sharpens", () => {
    const objs = cluster(20, 16.05, 108.2);
    const zone = summarizeCell(objs, { zoom: 6 });
    assert.ok(zone);
    assert.equal(zone.geometry.type, "Polygon");
    const ring = (zone.geometry as { coordinates: number[][][] }).coordinates[0];
    assert.equal(ring.length, 5, "a closed rectangular ring");
    assert.deepEqual(ring[0], ring[4]);
    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    const box: BBox = {
      west: Math.min(...lngs),
      east: Math.max(...lngs),
      south: Math.min(...lats),
      north: Math.max(...lats),
    };
    for (const o of objs) {
      const c = centroidOf(o.geometry);
      assert.ok(c);
      assert.equal(bboxContains(box, c.lat, c.lng), true);
    }
    // The cell is far coarser than the contributors' own spread.
    assert.ok(box.east - box.west >= 5, "the cell must be the grid cell, not a tight hull");
  });
});

// ── Activity + trend ──────────────────────────────────────────────────────────

describe("mapAggregation — activity and trend derivation", () => {
  it("the density ladder is expressed in multiples of the k floor", () => {
    assert.deepEqual(
      ACTIVITY_COHORT_MULTIPLES.map((s) => s.atLeast),
      [16, 8, 4, 2, 1],
    );
    assert.equal(activityForCohort(MIN_ZONE_COHORT), "quiet");
    assert.equal(activityForCohort(MIN_ZONE_COHORT * 2), "moderate");
    assert.equal(activityForCohort(MIN_ZONE_COHORT * 4), "busy");
    assert.equal(activityForCohort(MIN_ZONE_COHORT * 8), "very_busy");
    assert.equal(activityForCohort(MIN_ZONE_COHORT * 16), "peak");
    assert.equal(activityForCohort(MIN_ZONE_COHORT - 1), "very_quiet");
  });

  it("a barely-publishable cohort reads 'quiet', not 'busy'", () => {
    const zone = summarizeCell(cluster(MIN_ZONE_COHORT, 16.05, 108.2), { zoom: 3 });
    assert.equal(zone?.activity, "quiet");
    assert.equal(zone?.subtitle, "Quiet");
  });

  it("trend is undefined when NO input carries one", () => {
    assert.equal(aggregateTrend(cluster(40, 16.05, 108.2)), undefined);
    const zone = summarizeCell(cluster(40, 16.05, 108.2), { zoom: 3 });
    assert.ok(zone);
    assert.equal("trend" in zone, false, "no trend key at all when nothing carried one");
  });

  it("trend is undefined when the trend-carrying contributors are below k", () => {
    const objs = [
      ...cluster(40, 16.05, 108.2),
      ...cluster(3, 16.05, 108.2, { trend: "getting_busier" }),
    ];
    assert.equal(aggregateTrend(objs), undefined);
  });

  it("trend is the modal value once the carriers are themselves a cohort", () => {
    const objs = [
      ...cluster(20, 16.05, 108.2, { trend: "getting_busier" }),
      ...cluster(5, 16.05, 108.2, { trend: "cooling" }),
    ];
    assert.equal(aggregateTrend(objs), "getting_busier");
    assert.equal(summarizeCell(objs, { zoom: 3 })?.trend, "getting_busier");
  });

  it("ties resolve toward `stable` — the least eventful reading", () => {
    const objs = [
      ...cluster(10, 16.05, 108.2, { trend: "increasing_quickly" }),
      ...cluster(10, 16.05, 108.2, { trend: "stable" }),
    ];
    assert.equal(aggregateTrend(objs), "stable");
  });
});

// ── §23 headline ──────────────────────────────────────────────────────────────

describe("mapAggregation — §23 aggregate presence headline", () => {
  it("renders '18 travelers active around this area', not a field of avatars", () => {
    const zone = summarizeCell(cluster(18, 16.05, 108.2, { kind: "social_zone" }), { zoom: 3 });
    assert.equal(zone?.title, "18 travelers active around this area");
  });

  it("uses the dominant contributing kind for the noun", () => {
    const places = summarizeCell(cluster(22, 16.05, 108.2, { kind: "place" }), { zoom: 3 });
    assert.equal(places?.title, "22 places in this area");
    const events = summarizeCell(cluster(16, 16.05, 108.2, { kind: "event" }), { zoom: 3 });
    assert.equal(events?.title, "16 events in this area");
  });
});

// ── The zoom model (§17) ──────────────────────────────────────────────────────

describe("mapAggregation — §17 zoom model", () => {
  it("bands cover zoom 0..22 contiguously with no gap or overlap", () => {
    assert.deepEqual([...ZOOM_BANDS], ["world", "city", "district", "street", "venue"]);
    let expected = 0;
    for (const band of ZOOM_BANDS) {
      assert.equal(ZOOM_BAND_RANGES[band].minZoom, expected, `${band} does not abut the previous band`);
      expected = ZOOM_BAND_RANGES[band].maxZoom + 1;
    }
    assert.equal(expected, 23);
  });

  it("maps every zoom to its band, including the boundaries", () => {
    const cases: [number, string][] = [
      [0, "world"], [5, "world"],
      [6, "city"], [11, "city"],
      [12, "district"], [14, "district"],
      [15, "street"], [17, "street"],
      [18, "venue"], [22, "venue"],
    ];
    for (const [z, band] of cases) assert.equal(zoomBandFor(z), band, `zoom ${z}`);
    assert.equal(zoomBandFor(30), "venue", "beyond the table is the most zoomed-in state");
    assert.equal(zoomBandFor(11.9), "city", "fractional zoom floors into its band");
  });

  it("FAIL-CLOSED: an unusable zoom becomes `world` (maximum aggregation)", () => {
    for (const z of [Number.NaN, undefined, null, -1, Number.POSITIVE_INFINITY]) {
      assert.equal(zoomBandFor(z as number), "world", `zoom ${String(z)}`);
    }
  });

  it("only world and city aggregate (§31: wide zoom collapses into area summaries)", () => {
    assert.deepEqual([...AGGREGATING_BANDS], ["world", "city"]);
    assert.equal(bandAggregates("world"), true);
    assert.equal(bandAggregates("city"), true);
    assert.equal(bandAggregates("district"), false);
    assert.equal(bandAggregates("street"), false);
    assert.equal(bandAggregates("venue"), false);
  });

  it("THE ZOOM → CELL-SIZE TABLE: 360/2^z through zoom 11, then null", () => {
    assert.equal(CELL_SIZE_DEGREES_BY_ZOOM.length, 23);
    const expected = [
      360, 180, 90, 45, 22.5, 11.25, 5.625, 2.8125, 1.40625, 0.703125, 0.3515625, 0.17578125,
    ];
    for (let z = 0; z < expected.length; z += 1) {
      assert.equal(CELL_SIZE_DEGREES_BY_ZOOM[z], expected[z], `zoom ${z}`);
      assert.equal(cellSizeDegreesFor(z), expected[z], `cellSizeDegreesFor(${z})`);
      // Exact binary fractions — no float drift in a cell key.
      assert.equal(360 / 2 ** z, expected[z]);
    }
    for (let z = 12; z <= 22; z += 1) {
      assert.equal(CELL_SIZE_DEGREES_BY_ZOOM[z], null, `zoom ${z} must not aggregate`);
      assert.equal(cellSizeDegreesFor(z), null);
    }
    assert.equal(cellSizeDegreesFor(23), null);
  });

  it("FAIL-CLOSED: an unusable zoom takes the coarsest cell", () => {
    assert.equal(cellSizeDegreesFor(Number.NaN), 360);
    assert.equal(cellSizeDegreesFor(undefined), 360);
    assert.equal(cellSizeDegreesFor(-4), 360);
  });

  it("cells are deterministic, grid-snapped and non-degenerate", () => {
    const a = cellFor(16.0544, 108.2022, 3);
    const b = cellFor(16.0544, 108.2022, 3);
    assert.deepEqual(a, b);
    assert.ok(a);
    assert.equal(a.sizeDegrees, 45);
    assert.equal(a.west, 90);
    assert.equal(a.east, 135);
    assert.equal(a.south, 0);
    assert.equal(a.north, 45);
    assert.equal(a.key, "3/6/2");
    // Two nearby points share a cell; a far one does not.
    assert.equal(cellFor(16.1, 108.3, 3)?.key, a.key);
    assert.notEqual(cellFor(25.77, -80.19, 3)?.key, a.key);
  });

  it("cellFor returns null where the grid does not aggregate", () => {
    assert.equal(cellFor(16.05, 108.2, 12), null);
    assert.equal(cellFor(Number.NaN, 108.2, 3), null);
    assert.equal(cellFor(95, 108.2, 3), null);
  });

  it("cellPolygon is a closed rectangular ring", () => {
    const cell = cellFor(16.05, 108.2, 3);
    assert.ok(cell);
    const poly = cellPolygon(cell);
    assert.equal(poly.type, "Polygon");
    assert.deepEqual(poly.coordinates[0], [
      [90, 0], [135, 0], [135, 45], [90, 45], [90, 0],
    ]);
  });
});

// ── Antimeridian and poles ────────────────────────────────────────────────────

describe("mapAggregation — antimeridian and pole-adjacent behaviour", () => {
  it("normalizeLng folds into [-180, 180) with 180 landing on -180", () => {
    assert.equal(normalizeLng(0), 0);
    assert.equal(normalizeLng(180), -180);
    assert.equal(normalizeLng(-180), -180);
    assert.equal(normalizeLng(190), -170);
    assert.equal(normalizeLng(-190), 170);
    assert.equal(normalizeLng(540), -180);
    assert.ok(Number.isNaN(normalizeLng(Number.NaN)));
  });

  it("a WRAPPING bbox (west > east) is a union, not an empty interval", () => {
    const fiji: BBox = { west: 170, south: -20, east: -170, north: -14 };
    assert.equal(bboxContains(fiji, -18, 175), true);
    assert.equal(bboxContains(fiji, -18, 179.9), true);
    assert.equal(bboxContains(fiji, -18, -179.9), true);
    assert.equal(bboxContains(fiji, -18, -172), true);
    assert.equal(bboxContains(fiji, -18, 0), false, "the far side is outside");
    assert.equal(bboxContains(fiji, -18, 160), false);
    assert.equal(bboxContains(fiji, -25, 175), false, "latitude still bounds it");
  });

  it("a full-turn bbox contains every longitude", () => {
    assert.equal(bboxContains(WORLD_BBOX, 0, 0), true);
    assert.equal(bboxContains(WORLD_BBOX, 0, 180), true);
    assert.equal(bboxContains(WORLD_BBOX, 0, -180), true);
    assert.equal(bboxContains(WORLD_BBOX, 89.99, 179.99), true);
  });

  it("FAIL-CLOSED: a malformed bbox or coordinate contains nothing", () => {
    assert.equal(bboxContains(null, 0, 0), false);
    assert.equal(bboxContains(undefined, 0, 0), false);
    assert.equal(bboxContains({ west: Number.NaN, south: 0, east: 1, north: 1 }, 0.5, 0.5), false);
    assert.equal(bboxContains({ west: 0, south: 10, east: 1, north: 0 }, 5, 0.5), false);
    assert.equal(bboxContains({ west: 0, south: 0, east: 1, north: 1 }, Number.NaN, 0.5), false);
  });

  it("aggregation over a wrapping viewport keeps both sides of the seam", () => {
    const objs = [
      ...cluster(20, -17, 179.5),
      ...cluster(20, -17, -179.5),
      ...cluster(20, -17, 0), // far side, must be dropped
    ];
    const res = aggregateForViewport(objs, {
      bbox: { west: 170, south: -20, east: -170, north: -14 },
      zoom: 6,
    });
    accountedFor(res, 60);
    assert.equal(res.dropped, 20, "only the far-side cluster is outside the viewport");
    assert.equal(res.aggregated, 40);
    // The seam splits into two adjacent grid cells — cells never wrap.
    assert.equal(res.zones, 2);
    for (const z of res.objects) assert.equal(isServable(z), true);
  });

  it("pole-adjacent points land in a real, non-degenerate top/bottom cell", () => {
    const north = cellFor(90, 0, 3);
    assert.ok(north);
    assert.equal(north.south, 45);
    assert.equal(north.north, 90);
    assert.ok(north.north > north.south, "the pole must not produce a zero-height cell");
    const south = cellFor(-90, 0, 3);
    assert.ok(south);
    assert.equal(south.south, -90);
    assert.equal(south.north, -45);
  });

  it("bboxFromCenterRadius widens to the whole parallel near the poles", () => {
    const polar = bboxFromCenterRadius(89.9, 0, 50);
    assert.ok(polar);
    assert.equal(polar.west, -180);
    assert.equal(polar.east, 180);
    assert.ok(polar.north <= 90 && polar.south >= -90, "latitude is clamped, never wrapped over");

    const exactPole = bboxFromCenterRadius(90, 12, 5);
    assert.ok(exactPole);
    assert.equal(exactPole.west, -180);
    assert.equal(exactPole.east, 180);
    assert.equal(exactPole.north, 90);
  });

  it("bboxFromCenterRadius is a plain rectangle at temperate latitudes", () => {
    const b = bboxFromCenterRadius(16.0544, 108.2022, 11.132);
    assert.ok(b);
    assert.ok(Math.abs(b.north - b.south - 0.2) < 1e-9, "0.1 deg of latitude either side");
    assert.ok(b.east > b.west);
    assert.equal(bboxContains(b, 16.0544, 108.2022), true);
    assert.equal(bboxContains(b, 16.0544, 108.6), false);
    assert.equal(11.132 / KM_PER_DEGREE_LAT, 0.1);
  });

  it("bboxFromCenterRadius crossing the antimeridian yields a wrapping bbox", () => {
    const b = bboxFromCenterRadius(0, 179.9, 55.66); // 0.5 deg either side at the equator
    assert.ok(b);
    assert.ok(b.west > b.east, "it must wrap rather than silently clamp");
    assert.equal(bboxContains(b, 0, 179.95), true);
    assert.equal(bboxContains(b, 0, -179.8), true);
    assert.equal(bboxContains(b, 0, 178), false);
  });

  it("FAIL-CLOSED: bboxFromCenterRadius refuses unusable input", () => {
    assert.equal(bboxFromCenterRadius(Number.NaN, 0, 10), null);
    assert.equal(bboxFromCenterRadius(0, Number.NaN, 10), null);
    assert.equal(bboxFromCenterRadius(0, 0, -1), null);
    assert.equal(bboxFromCenterRadius(0, 0, Number.NaN), null);
    assert.equal(bboxFromCenterRadius(91, 0, 10), null);
  });
});

// ── Web Mercator helpers ──────────────────────────────────────────────────────

describe("mapAggregation — Web Mercator lat/lng ↔ tile", () => {
  it("zoom 0 is a single tile; zoom 1 quarters the world at the origin", () => {
    assert.deepEqual(lngLatToTile(0, 0, 0), { x: 0, y: 0, zoom: 0 });
    assert.deepEqual(lngLatToTile(0, 0, 1), { x: 1, y: 1, zoom: 1 });
    assert.deepEqual(lngLatToTile(10, -10, 1), { x: 0, y: 0, zoom: 1 });
    assert.deepEqual(lngLatToTile(-10, 10, 1), { x: 1, y: 1, zoom: 1 });
  });

  it("places Da Nang in its known tile at zoom 8", () => {
    // 108.2022E → x = floor((108.2022+180)/360 * 256) = 204
    // 16.0544N  → y = floor((1 - ln(tan φ + sec φ)/π)/2 * 256) = 116
    assert.deepEqual(lngLatToTile(16.0544, 108.2022, 8), { x: 204, y: 116, zoom: 8 });
  });

  it("round-trips: a tile's NW corner maps back to that tile", () => {
    for (const [x, y, z] of [[204, 114, 8], [0, 0, 3], [7, 7, 3], [1, 2, 2]] as const) {
      const nw = tileToLngLat(x, y, z);
      assert.ok(nw);
      // Step just inside the tile so the corner does not fall to the neighbour.
      const back = lngLatToTile(nw.lat - 1e-6, nw.lng + 1e-6, z);
      assert.deepEqual(back, { x, y, zoom: z });
    }
  });

  it("clamps at the Mercator limit instead of producing Infinity", () => {
    const north = lngLatToTile(89.9, 0, 4);
    assert.deepEqual(north, { x: 8, y: 0, zoom: 4 });
    const south = lngLatToTile(-89.9, 0, 4);
    assert.deepEqual(south, { x: 8, y: 15, zoom: 4 });
    assert.deepEqual(lngLatToTile(MERCATOR_MAX_LAT, 0, 4), { x: 8, y: 0, zoom: 4 });
    for (const t of [north, south]) {
      assert.ok(t);
      assert.equal(Number.isInteger(t.x) && Number.isInteger(t.y), true);
    }
  });

  it("normalizes longitude before tiling", () => {
    assert.deepEqual(lngLatToTile(0, 190, 2), lngLatToTile(0, -170, 2));
  });

  it("FAIL-CLOSED on unusable input", () => {
    assert.equal(lngLatToTile(Number.NaN, 0, 3), null);
    assert.equal(lngLatToTile(0, 0, -1), null);
    assert.equal(lngLatToTile(0, 0, 25), null);
    assert.equal(tileToLngLat(8, 0, 3), null, "x out of range for the zoom");
    assert.equal(tileToLngLat(-1, 0, 3), null);
    assert.equal(tileToLngLat(0, 0, Number.NaN), null);
  });
});

// ── Viewport aggregation ──────────────────────────────────────────────────────

describe("mapAggregation — aggregateForViewport", () => {
  it("collapses many objects into few zones at world zoom (§6: zones, not thousands of pins)", () => {
    const objs = [...cluster(40, 16.05, 108.2), ...cluster(60, 25.77, -80.19)];
    const res = aggregateForViewport(objs, { bbox: WORLD_BBOX, zoom: 3 });
    assert.equal(res.band, "world");
    assert.equal(res.cellSizeDegrees, 45);
    assert.equal(res.zones, 2);
    assert.equal(res.objects.length, 2);
    assert.equal(res.aggregated, 100);
    assert.equal(res.individual, 0);
    assert.equal(res.dropped, 0);
    accountedFor(res, 100);
    assert.deepEqual(res.objects.map((o) => o.count).sort((a, b) => (a ?? 0) - (b ?? 0)), [40, 60]);
  });

  it("returns individual objects at district and below (§17)", () => {
    const objs = cluster(40, 16.05, 108.2);
    for (const zoom of [12, 15, 18, 22]) {
      const res = aggregateForViewport(objs, { bbox: WORLD_BBOX, zoom });
      assert.equal(res.zones, 0, `zoom ${zoom}`);
      assert.equal(res.individual, 40);
      assert.equal(res.aggregated, 0);
      assert.equal(res.cellSizeDegrees, null);
      accountedFor(res, 40);
    }
  });

  it("does not apply the k floor to individual objects below the aggregating bands", () => {
    // Precision at district+ is a Privacy/Eligibility decision that already ran
    // (§19). This stage must not second-guess it, only aggregate.
    const res = aggregateForViewport([mk(16.05, 108.2)], { bbox: WORLD_BBOX, zoom: 14 });
    assert.equal(res.individual, 1);
    assert.equal(res.suppressedForKAnonymity, 0);
  });

  it("CONSERVATION holds across every mix of collapse, passthrough, drop and suppression", () => {
    const objs = [
      ...cluster(40, 16.05, 108.2), // one full cell
      ...cluster(3, 25.77, -80.19), // sub-threshold cell → suppressed
      ...cluster(5, 35.68, 139.69, { kind: "safety_notice", renderingPriority: 120 }), // passthrough
      ...cluster(7, -33.87, 151.2), // outside the viewport below
    ];
    const bbox: BBox = { west: -100, south: 0, east: 150, north: 60 };
    const res = aggregateForViewport(objs, { bbox, zoom: 3 });
    accountedFor(res, 55);
    assert.equal(res.aggregated, 40);
    assert.equal(res.individual, 5);
    assert.equal(res.suppressedForKAnonymity, 3);
    assert.equal(res.dropped, 10, "3 suppressed + 7 out of viewport");
    assert.deepEqual(res.suppressedCells, [
      { key: "3/2/2", contributors: 3, reason: "below_cohort_floor" },
    ]);
  });

  it("never silently truncates — a suppressed cell is REPORTED", () => {
    const res = aggregateForViewport(cluster(4, 16.05, 108.2), { bbox: WORLD_BBOX, zoom: 3 });
    assert.equal(res.objects.length, 0);
    assert.equal(res.suppressedCells.length, 1);
    assert.equal(res.suppressedCells[0]?.contributors, 4);
    assert.equal(res.suppressedCells[0]?.reason, "below_cohort_floor");
    accountedFor(res, 4);
  });

  it("kinds that must never collapse pass through at every aggregating zoom", () => {
    assert.deepEqual(
      [...NEVER_AGGREGATED_KINDS],
      ["safety_notice", "crew_member", "meeting_point", "crowd_flow"],
    );
    for (const kind of NEVER_AGGREGATED_KINDS) {
      assert.equal(isNeverAggregated(kind), true);
      const one = mk(16.05, 108.2, { kind, renderingPriority: KIND_DEFAULT_PRIORITY[kind] });
      const res = aggregateForViewport([one], { bbox: WORLD_BBOX, zoom: 0 });
      assert.equal(res.individual, 1, `${kind} was collapsed or dropped`);
      assert.equal(res.objects[0]?.id, one.id);
      accountedFor(res, 1);
    }
    assert.equal(isNeverAggregated("place"), false);
    assert.equal(isNeverAggregated("social_zone"), false);
  });

  it("a safety notice outranks the zone it sits beside (§5, §31)", () => {
    const objs = [
      ...cluster(40, 16.05, 108.2),
      mk(16.05, 108.2, { kind: "safety_notice", renderingPriority: KIND_DEFAULT_PRIORITY.safety_notice, title: "Flooding" }),
    ];
    const res = aggregateForViewport(objs, { bbox: WORLD_BBOX, zoom: 3 });
    assert.equal(res.objects[0]?.kind, "safety_notice");
    assert.equal(res.objects[1]?.kind, "activity_zone");
  });

  it("drops unservable objects rather than serializing them", () => {
    const objs = [
      ...cluster(20, 16.05, 108.2),
      mk(16.05, 108.2, { privacyClass: "none" }),
      mk(16.05, 108.2, { title: "   " }),
    ];
    const res = aggregateForViewport(objs, { bbox: WORLD_BBOX, zoom: 3 });
    assert.equal(res.dropped, 2);
    assert.equal(res.aggregated, 20);
    accountedFor(res, 22);
    for (const o of res.objects) assert.equal(isServable(o), true);
  });

  it("is deterministic: shuffling the input changes nothing", () => {
    const base = [
      ...cluster(40, 16.05, 108.2),
      ...cluster(30, 25.77, -80.19),
      ...cluster(20, -33.87, 151.2),
    ];
    const a = aggregateForViewport(base, { bbox: WORLD_BBOX, zoom: 6 });
    const shuffled = [...base].reverse();
    const b = aggregateForViewport(shuffled, { bbox: WORLD_BBOX, zoom: 6 });
    assert.deepEqual(
      a.objects.map((o) => [o.id, o.count, o.title]),
      b.objects.map((o) => [o.id, o.count, o.title]),
    );
    assert.deepEqual(a.suppressedCells, b.suppressedCells);
    assert.equal(a.aggregated, b.aggregated);
  });

  it("FAIL-CLOSED: an unusable zoom aggregates at the coarsest grid", () => {
    const objs = [...cluster(40, 16.05, 108.2), ...cluster(40, 25.77, -80.19)];
    const res = aggregateForViewport(objs, { bbox: WORLD_BBOX, zoom: Number.NaN });
    assert.equal(res.band, "world");
    assert.equal(res.cellSizeDegrees, 360);
    assert.equal(res.zones, 1, "one cell covers the planet at the coarsest grid");
    assert.equal(res.objects[0]?.count, 80);
    accountedFor(res, 80);
  });

  it("FAIL-CLOSED: a malformed bbox shows nothing", () => {
    const objs = cluster(40, 16.05, 108.2);
    const res = aggregateForViewport(objs, {
      bbox: { west: Number.NaN, south: -90, east: 180, north: 90 },
      zoom: 3,
    });
    assert.equal(res.objects.length, 0);
    assert.equal(res.dropped, 40);
    accountedFor(res, 40);
  });

  it("handles an empty input", () => {
    const res = aggregateForViewport([], { bbox: WORLD_BBOX, zoom: 3 });
    assert.deepEqual(res.objects, []);
    assert.equal(res.aggregated, 0);
    assert.equal(res.dropped, 0);
    accountedFor(res, 0);
  });

  it("a stricter k passed in tightens suppression", () => {
    const objs = cluster(20, 16.05, 108.2);
    assert.equal(aggregateForViewport(objs, { bbox: WORLD_BBOX, zoom: 3 }).zones, 1);
    const tight = aggregateForViewport(objs, { bbox: WORLD_BBOX, zoom: 3, k: 25 });
    assert.equal(tight.zones, 0);
    assert.equal(tight.suppressedForKAnonymity, 20);
    accountedFor(tight, 20);
  });
});

// ── Crowd flow (§10) ──────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const MIN = 60_000;

function transition(over: Partial<ZoneTransition> = {}): ZoneTransition {
  return {
    fromZoneId: "zone-a",
    toZoneId: "zone-b",
    from: { lat: 16.05, lng: 108.2 },
    to: { lat: 16.08, lng: 108.24 },
    distinctActors: 40,
    distinctGroups: 9,
    maxGroupShare: 0.15,
    signalFamilies: ["arrival", "navigation_start"],
    windowMinutes: 30,
    observedAt: new Date(NOW - 15 * MIN).toISOString(),
    ...over,
  };
}

describe("mapAggregation — deriveCrowdFlow (§10)", () => {
  it("emits a flow when all four gates pass", () => {
    const { flows, rejected } = deriveCrowdFlow([transition()], { now: NOW });
    assert.deepEqual(rejected, []);
    assert.equal(flows.length, 1);
    const f = flows[0];
    assert.ok(f);
    assert.equal(f.kind, "crowd_flow");
    assert.equal(f.geometry.type, "LineString");
    assert.deepEqual((f.geometry as { coordinates: number[][] }).coordinates, [
      [108.2, 16.05],
      [108.24, 16.08],
    ]);
    assert.equal(f.privacyClass, "aggregate_only");
    assert.equal(f.freshness, "recent");
    assert.equal(f.renderingPriority, KIND_DEFAULT_PRIORITY.crowd_flow);
    assert.equal(f.count, 40);
    assert.equal(isServable(f), true);
  });

  it("separates OBSERVED movement from INFERRED cause", () => {
    const { flows } = deriveCrowdFlow(
      [
        transition({
          inferredCause: {
            text: "A stadium event is ending",
            confidence: "provisional",
            basis: ["event_context"],
          },
        }),
      ],
      { now: NOW },
    );
    const p = flows[0]?.payload;
    assert.ok(p);
    // The observation carries no cause…
    assert.deepEqual(Object.keys(p.observed).sort(), [
      "cohortSize", "flowState", "fromZoneId", "observedAt", "signalFamilies", "toZoneId", "windowMinutes",
    ]);
    assert.equal("cause" in p.observed, false);
    // …and the inference is a separate, separately-confidenced field.
    assert.deepEqual(p.inferred, {
      label: INFERRED_CAUSE_LABEL,
      cause: "A stadium event is ending",
      confidence: "provisional",
      basis: ["event_context"],
    });
    // §37: the inference is labelled as one, by this module, every time.
    assert.equal(typeof p.inferred?.label, "string");
    assert.match(p.inferred!.label, /inferred/i);
  });

  it("inferred is null when no cause was supplied — never invented", () => {
    const { flows } = deriveCrowdFlow([transition()], { now: NOW });
    assert.equal(flows[0]?.payload?.inferred, null);
  });

  it("an inferred cause with no stated confidence falls to the weakest band", () => {
    const { flows } = deriveCrowdFlow(
      [transition({ inferredCause: { text: "Concert let out" } })],
      { now: NOW },
    );
    assert.equal(flows[0]?.payload?.inferred?.confidence, "unverified");
  });

  // ── Gate 1: privacy ─────────────────────────────────────────────────────────

  it("GATE 1 privacy — a cohort below k blocks the flow on its own", () => {
    const { flows, rejected } = deriveCrowdFlow(
      [transition({ distinctActors: PRIVACY_THRESHOLD_V1.minUniqueActors - 1 })],
      { now: NOW },
    );
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "below_actor_threshold");
  });

  it("GATE 1 privacy — too few independent groups blocks it", () => {
    const { flows, rejected } = deriveCrowdFlow([transition({ distinctGroups: 2 })], { now: NOW });
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "below_group_threshold");
  });

  it("GATE 1 privacy — one dominant group blocks it (a crowd is not a cohort)", () => {
    const { flows, rejected } = deriveCrowdFlow([transition({ maxGroupShare: 0.9 })], { now: NOW });
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "single_group_dominates");
  });

  it("GATE 1 privacy — an undelayed flow is a live tracker, and is refused", () => {
    const { flows, rejected } = deriveCrowdFlow(
      [transition({ observedAt: new Date(NOW - 2 * MIN).toISOString() })],
      { now: NOW },
    );
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "publication_delay_not_elapsed");
  });

  it("GATE 1 privacy — a sensitive subject is refused before any arithmetic", () => {
    const { flows, rejected } = deriveCrowdFlow([transition({ sensitiveSubject: true })], { now: NOW });
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "sensitive_subject");
  });

  it("GATE 1 privacy — missing group counts are a refusal, not an exemption", () => {
    const t = transition();
    delete (t as Partial<ZoneTransition>).distinctGroups;
    const { flows, rejected } = deriveCrowdFlow([t], { now: NOW });
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "invalid_input");
  });

  // ── Gate 2: freshness ───────────────────────────────────────────────────────

  it("GATE 2 freshness — an aged observation blocks the flow on its own", () => {
    // Every other gate passes; only the age changes.
    const { flows, rejected } = deriveCrowdFlow(
      [transition({ observedAt: new Date(NOW - 90 * MIN).toISOString() })],
      { now: NOW },
    );
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "not_fresh");
  });

  it("GATE 2 freshness — an expired flow is refused however large the cohort", () => {
    const { flows, rejected } = deriveCrowdFlow(
      [
        transition({
          distinctActors: 5000,
          expiresAt: new Date(NOW - 1 * MIN).toISOString(),
        }),
      ],
      { now: NOW },
    );
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "not_fresh");
  });

  it("GATE 2 freshness — the publishable window is 10..30 minutes old, by construction", () => {
    // < 10 min: held by the publication delay. > 30 min: no longer `recent`.
    for (const ageMin of [0, 5, 9]) {
      const r = deriveCrowdFlow([transition({ observedAt: new Date(NOW - ageMin * MIN).toISOString() })], { now: NOW });
      assert.equal(r.flows.length, 0, `age ${ageMin}m should be held by the delay`);
      assert.equal(r.rejected[0]?.reason, "publication_delay_not_elapsed");
    }
    for (const ageMin of [10, 20, 29]) {
      const r = deriveCrowdFlow([transition({ observedAt: new Date(NOW - ageMin * MIN).toISOString() })], { now: NOW });
      assert.equal(r.flows.length, 1, `age ${ageMin}m should publish`);
    }
    for (const ageMin of [31, 120]) {
      const r = deriveCrowdFlow([transition({ observedAt: new Date(NOW - ageMin * MIN).toISOString() })], { now: NOW });
      assert.equal(r.flows.length, 0, `age ${ageMin}m should be stale`);
      assert.equal(r.rejected[0]?.reason, "not_fresh");
    }
  });

  // ── Gate 3: signal families ─────────────────────────────────────────────────

  it("GATE 3 signal families — a single family blocks the flow on its own", () => {
    const { flows, rejected } = deriveCrowdFlow([transition({ signalFamilies: ["arrival"] })], { now: NOW });
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "insufficient_signal_families");
    assert.equal(MIN_SIGNAL_FAMILIES, 2);
  });

  it("GATE 3 signal families — duplicates do not count twice", () => {
    const { flows, rejected } = deriveCrowdFlow(
      [transition({ signalFamilies: ["arrival", "arrival", "arrival"] })],
      { now: NOW },
    );
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "insufficient_signal_families");
  });

  it("GATE 3 signal families — unrecognized families count for nothing", () => {
    const { flows, rejected } = deriveCrowdFlow(
      [transition({ signalFamilies: ["arrival", "psychic_hunch", "made_up"] })],
      { now: NOW },
    );
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "insufficient_signal_families");
    // …and the recognized vocabulary is §10's own input list.
    assert.deepEqual(
      [...CROWD_FLOW_SIGNAL_FAMILIES],
      [
        "coarse_transition", "arrival", "accepted_plan", "navigation_start",
        "event_context", "aggregate_presence", "next_stop_contribution",
      ],
    );
  });

  it("GATE 3 signal families — the emitted flow reports only recognized, sorted families", () => {
    const { flows } = deriveCrowdFlow(
      [transition({ signalFamilies: ["navigation_start", "bogus", "arrival", "arrival"] })],
      { now: NOW },
    );
    assert.deepEqual(flows[0]?.payload?.observed.signalFamilies, ["arrival", "navigation_start"]);
  });

  // ── Gate 4: cohort density ──────────────────────────────────────────────────

  it("GATE 4 cohort density — a cohort spread too thin over time blocks it on its own", () => {
    // 40 actors is well past k, but over 24 hours that is not a flow.
    const { flows, rejected } = deriveCrowdFlow(
      [transition({ windowMinutes: 24 * 60 })],
      { now: NOW },
    );
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "below_cohort_density");
    assert.equal(FLOW_DENSITY_BUCKET_MINUTES, PRIVACY_THRESHOLD_V1.timeBucketMinutes);
    assert.equal(MIN_FLOW_COHORT_PER_BUCKET, PRIVACY_THRESHOLD_V1.minUniqueActors);
  });

  it("GATE 4 cohort density — density is independent of the k floor", () => {
    // Passes privacy (40 ≥ 15) but fails density; and the reverse cannot happen,
    // because density normalizes to the same floor over a shorter window.
    const thin = deriveCrowdFlow([transition({ distinctActors: 20, windowMinutes: 120 })], { now: NOW });
    assert.equal(thin.rejected[0]?.reason, "below_cohort_density");
    const dense = deriveCrowdFlow([transition({ distinctActors: 20, windowMinutes: 15 })], { now: NOW });
    assert.equal(dense.flows.length, 1);
  });

  it("a stricter density requirement passed in tightens the gate", () => {
    const strict = deriveCrowdFlow([transition()], { now: NOW, minCohortPerBucket: 100 });
    assert.equal(strict.flows.length, 0);
    assert.equal(strict.rejected[0]?.reason, "below_cohort_density");
    // …and a looser one cannot relax it below the product floor.
    const loose = deriveCrowdFlow([transition({ distinctActors: 16, windowMinutes: 24 * 60 })], {
      now: NOW,
      minCohortPerBucket: 1,
    });
    assert.equal(loose.flows.length, 0);
  });

  // ── Flow state + shape ──────────────────────────────────────────────────────

  it("derives §10 flow states from cohort size, and honours explicit flags", () => {
    const strong = deriveCrowdFlow([transition({ distinctActors: 80 })], { now: NOW });
    assert.equal(strong.flows[0]?.payload?.observed.flowState, "strong_movement");
    assert.equal(strong.flows[0]?.title, "Strong movement");

    const moderate = deriveCrowdFlow([transition({ distinctActors: 32, windowMinutes: 15 })], { now: NOW });
    assert.equal(moderate.flows[0]?.payload?.observed.flowState, "moderate_movement");

    const emerging = deriveCrowdFlow([transition({ distinctActors: 20, windowMinutes: 15 })], { now: NOW });
    assert.equal(emerging.flows[0]?.payload?.observed.flowState, "emerging_movement");

    const dispersing = deriveCrowdFlow([transition({ dispersing: true })], { now: NOW });
    assert.equal(dispersing.flows[0]?.payload?.observed.flowState, "dispersing");

    const unusual = deriveCrowdFlow([transition({ unusual: true, dispersing: true })], { now: NOW });
    assert.equal(unusual.flows[0]?.payload?.observed.flowState, "unusual_movement");
  });

  it("never emits more precise than aggregate_only, whatever the caller asks", () => {
    const { flows } = deriveCrowdFlow([transition({ privacyClass: "precise_temporary" })], { now: NOW });
    assert.equal(flows[0]?.privacyClass, "aggregate_only");
    const placeLevel = deriveCrowdFlow([transition({ privacyClass: "place_level" })], { now: NOW });
    assert.equal(placeLevel.flows[0]?.privacyClass, "aggregate_only");
  });

  it("refuses a flow whose privacy class is `none`", () => {
    const { flows, rejected } = deriveCrowdFlow([transition({ privacyClass: "none" })], { now: NOW });
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "privacy_class_none");
  });

  it("refuses unusable geometry rather than emitting a broken line", () => {
    const { flows, rejected } = deriveCrowdFlow(
      [transition({ to: { lat: 200, lng: 108.24 } })],
      { now: NOW },
    );
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "invalid_geometry");
  });

  it("refuses a transition with no zone identity", () => {
    const { flows, rejected } = deriveCrowdFlow([transition({ toZoneId: "" })], { now: NOW });
    assert.deepEqual(flows, []);
    assert.equal(rejected[0]?.reason, "invalid_input");
  });

  it("is deterministic and reports every refusal — never a silent drop", () => {
    const ts = [
      transition({ fromZoneId: "z3", toZoneId: "z4", distinctActors: 2 }),
      transition({ fromZoneId: "z1", toZoneId: "z2" }),
      transition({ fromZoneId: "z5", toZoneId: "z6", signalFamilies: ["arrival"] }),
    ];
    const a = deriveCrowdFlow(ts, { now: NOW });
    const b = deriveCrowdFlow([...ts].reverse(), { now: NOW });
    assert.deepEqual(a.flows.map((f) => f.id), b.flows.map((f) => f.id));
    assert.deepEqual(a.rejected, b.rejected);
    assert.equal(a.flows.length + a.rejected.length, ts.length, "everything is accounted for");
    assert.deepEqual(a.rejected.map((r) => r.reason), [
      "below_actor_threshold",
      "insufficient_signal_families",
    ]);
  });

  it("handles an empty transition list", () => {
    assert.deepEqual(deriveCrowdFlow([], { now: NOW }), { flows: [], rejected: [] });
  });
});
