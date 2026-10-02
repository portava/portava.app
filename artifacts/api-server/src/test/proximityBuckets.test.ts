/**
 * T25 — approximate proximity / controlled distance buckets BY DEFAULT.
 *
 * The claim under test is not "the number is rounded". It is that the default
 * path CANNOT HOLD a precise coordinate:
 *
 *   • the only constructor of a `CoarsePoint` is `coarsePointFor`, which routes
 *     through the map's grid-snap + per-user jitter;
 *   • `proximityBucketBetween` refuses anything that did not come from it;
 *   • no distance and no km → bucket function is exported, so no caller can
 *     assemble "exact distance, then round" out of this module's parts;
 *   • the narrowest bucket edge is bounded below by twice the finest coarsening
 *     cell, so bucket membership can never resolve a position more finely than
 *     the coordinate it was computed from.
 *
 * Run: node --import tsx/esm --test src/test/proximityBuckets.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as proximity from "../lib/proximityBuckets.js";
import {
  MIN_BUCKET_EDGE_KM,
  PROXIMITY_BUCKETS,
  assertCoarsePoint,
  coarseCellKm,
  coarsePointFor,
  finestCoarseCellKm,
  isKnownProximity,
  overlapBandForMinutes,
  overlapBandRank,
  overlapMinutes,
  proximityBucketBetween,
  proximityBucketRank,
  travelBandForBucket,
  type CoarsePoint,
} from "../lib/proximityBuckets.js";
import { AREA_GRID_DEG } from "../lib/mapTravelers.js";

const A = "aaaaaaaa-0000-4000-a000-000000000001";
const B = "bbbbbbbb-0000-4000-a000-000000000002";

/** Metres → degrees of latitude, for placing a test point a known distance away. */
function latPlus(lat: number, km: number): number {
  return lat + km / 111.32;
}

describe("the module cannot be handed, and cannot hand back, a precise position", () => {
  it("exports no distance function and no km → bucket function", () => {
    const names = Object.keys(proximity);
    const leaky = names.filter((n) => /distance|km$|haversine|metres|meters/i.test(n));
    assert.deepEqual(
      leaky.filter((n) => n !== "MIN_BUCKET_EDGE_KM" && n !== "coarseCellKm" && n !== "finestCoarseCellKm"),
      [],
      `these exports would let a caller compute or pass a distance: ${leaky.join(", ")}`,
    );
    assert.equal(
      names.some((n) => n === "proximityBucketFromKm" || n === "haversineKm"),
      false,
      "km → bucket and the haversine are private on purpose",
    );
  });

  it("coarsePointFor is the only constructor, and it never returns the input", () => {
    const point = coarsePointFor(A, 41.157944, -8.629105, "neighborhood");
    assert.ok(point);
    assert.notEqual(point.lat, 41.157944, "the raw latitude was returned unchanged");
    assert.notEqual(point.lng, -8.629105, "the raw longitude was returned unchanged");
    assert.ok(Math.abs(point.lat - 41.157944) < coarseCellKm("area") / 111.32 + 0.001);
    assert.equal(point.coarsenedBy, "proximityBuckets");
  });

  it("a hand-forged 'coarse' point with a fine cell is REFUSED, not trusted", () => {
    const forged = {
      lat: 41.157944,
      lng: -8.629105,
      cellKm: 0.01,
      precision: "area",
      coarsenedBy: "proximityBuckets",
    } as CoarsePoint;
    assert.throws(() => assertCoarsePoint(forged), /finer than/);
    const real = coarsePointFor(B, 41.16, -8.63, "neighborhood");
    assert.ok(real);
    assert.throws(() => proximityBucketBetween(forged, real), /finer than/);
  });

  it("a point that claims no provenance is refused", () => {
    const untagged = { lat: 1, lng: 1, cellKm: 50, precision: "city", coarsenedBy: "somewhere-else" } as unknown as CoarsePoint;
    assert.throws(() => assertCoarsePoint(untagged), /not produced by coarsePointFor/);
  });

  it("invalid or absent coordinates yield null rather than a point", () => {
    assert.equal(coarsePointFor(A, null, null, "neighborhood"), null);
    assert.equal(coarsePointFor(A, 91, 0, "neighborhood"), null);
    assert.equal(coarsePointFor(A, 0, 181, "neighborhood"), null);
    assert.equal(coarsePointFor(A, Number.NaN, 0, "neighborhood"), null);
  });
});

describe("the bucket ladder cannot outrun the coarsener", () => {
  it("the narrowest edge is at least twice the finest coarsening cell", () => {
    const finest = finestCoarseCellKm();
    assert.ok(
      MIN_BUCKET_EDGE_KM >= 2 * finest,
      `narrowest bucket edge ${MIN_BUCKET_EDGE_KM} km must be >= 2 x the finest cell ${finest.toFixed(2)} km ` +
        "— otherwise which side of the edge someone falls on resolves them more finely than their own coarse point",
    );
  });

  it("the finest cell is the map's own AREA grid, so the two cannot drift apart", () => {
    assert.equal(finestCoarseCellKm(), AREA_GRID_DEG * 111.32);
  });

  it("city precision is coarser than area precision", () => {
    assert.ok(coarseCellKm("city") > coarseCellKm("area"));
  });
});

describe("bucketing", () => {
  const origin = coarsePointFor(A, 0, 0, "neighborhood");

  it("a missing point on either side is unknown, never a guess", () => {
    assert.equal(proximityBucketBetween(null, origin), "unknown");
    assert.equal(proximityBucketBetween(origin, null), "unknown");
    assert.equal(proximityBucketBetween(null, null), "unknown");
    assert.equal(isKnownProximity("unknown"), false);
  });

  it("distance moves the answer up the ladder, monotonically", () => {
    const seen = [1, 10, 30, 120, 900].map((km) => {
      const far = coarsePointFor(B, latPlus(0, km), 0, "neighborhood");
      return proximityBucketBetween(origin, far);
    });
    const ranks = seen.map(proximityBucketRank);
    for (let i = 1; i < ranks.length; i++) {
      assert.ok(ranks[i]! >= ranks[i - 1]!, `bucket went back down the ladder: ${seen.join(" → ")}`);
    }
    assert.equal(seen[0], "same_area");
    assert.equal(seen[seen.length - 1], "far");
  });

  it("the ladder is ordered and unknown ranks last", () => {
    assert.deepEqual([...PROXIMITY_BUCKETS], [
      "same_area",
      "nearby",
      "same_city",
      "same_region",
      "far",
      "unknown",
    ]);
    assert.equal(proximityBucketRank("unknown"), PROXIMITY_BUCKETS.length - 1);
  });
});

describe("travel bands are derived from the bucket and nothing finer", () => {
  it("each bucket maps to one band", () => {
    assert.equal(travelBandForBucket("same_area"), "walkable");
    assert.equal(travelBandForBucket("far"), "out_of_range");
    assert.equal(travelBandForBucket("unknown"), "unknown");
  });

  it("an inherited key does not answer — the lookup is a Map, not an object literal", () => {
    // An object-literal table answers TRUTHY for "constructor" and "toString".
    // A Map does not, which is why one is used: a gate that answers for keys
    // nobody put there cannot be shown to refuse anything.
    assert.equal(travelBandForBucket("constructor" as never), "unknown");
    assert.equal(travelBandForBucket("toString" as never), "unknown");
    assert.equal(travelBandForBucket("__proto__" as never), "unknown");
  });
});

describe("overlap windows are banded, not published to the minute", () => {
  it("bands", () => {
    assert.equal(overlapBandForMinutes(null), "unknown");
    assert.equal(overlapBandForMinutes(0), "none");
    assert.equal(overlapBandForMinutes(59), "brief");
    assert.equal(overlapBandForMinutes(60), "hour_plus");
    assert.equal(overlapBandForMinutes(239), "hour_plus");
    assert.equal(overlapBandForMinutes(240), "evening_plus");
  });

  it("more overlap ranks better; unknown ranks last", () => {
    assert.ok(overlapBandRank("evening_plus") < overlapBandRank("brief"));
    assert.ok(overlapBandRank("brief") < overlapBandRank("none"));
    assert.equal(overlapBandRank("unknown"), 4);
  });

  it("overlapMinutes is pure arithmetic and holds no clock", () => {
    const a = { startMs: 1_000, endMs: 4_000 };
    const b = { startMs: 3_000, endMs: 9_000 };
    assert.equal(overlapMinutes(a, b), Math.round(1_000 / 60_000));
    assert.equal(overlapMinutes(a, { startMs: 5_000, endMs: 6_000 }), 0);
    assert.equal(overlapMinutes(null, b), null);
    assert.equal(overlapMinutes(a, null), null);
    assert.equal(overlapMinutes({ startMs: Number.NaN, endMs: 1 }, b), null);
  });
});
