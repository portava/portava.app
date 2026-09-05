/**
 * mapCorridor — §36 Phase 6 "Along My Way", the corridor filter.
 *
 * The properties these tests exist to pin:
 *
 *   1. ON-ROUTE IN, OFF-ROUTE OUT. An object beside the polyline survives; one
 *      the same distance away in the perpendicular direction does not. This is
 *      the whole feature, and it is asserted against a real polyline with a
 *      corner, not a straight line where "near the line" and "near an endpoint"
 *      are the same thing.
 *   2. SUBSET, NEVER SUPERSET. The filter can only remove. The output is
 *      asserted to be drawn from the input, in the input's order, with the
 *      objects unmodified — because §31 rank order is what the gateway applies
 *      after this runs, and a re-sort here would silently outrank it.
 *   3. THE DETOUR COST IS LABELLED AN ESTIMATE (§37). Every cost carries
 *      basis: 'straight_line_estimate' and every rendered line says so.
 *   4. THE PARSER REFUSES RATHER THAN REPAIRS. A one-point "corridor" is a
 *      location, and treating it as a route would turn Along My Way into a
 *      radius search around wherever the caller said they were.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CORRIDOR_DEFAULT_METERS,
  CORRIDOR_MAX_METERS,
  CORRIDOR_MAX_POINTS,
  CORRIDOR_MIN_METERS,
  buildCorridor,
  corridorBBox,
  detourCost,
  detourLine,
  distanceToPolylineMeters,
  filterToCorridor,
  parseCorridorMeters,
  parseCorridorPath,
  type Corridor,
} from "../lib/mapCorridor.js";
import { point, type MapObject } from "../lib/mapObjects.js";

// A short L-shaped route through central Da Nang: east along a street, then
// north. The corner is what makes "distance to the LINE" different from
// "distance to the nearest endpoint".
const ROUTE = [
  { lat: 16.0600, lng: 108.2200 },
  { lat: 16.0600, lng: 108.2300 },
  { lat: 16.0700, lng: 108.2300 },
];

function obj(id: string, lat: number, lng: number, priority = 40): MapObject {
  return {
    id,
    kind: "place",
    geometry: point(lat, lng),
    title: id,
    privacyClass: "place_level",
    renderingPriority: priority,
  };
}

describe("mapCorridor — parsing", () => {
  it("parses a polyline of lat,lng pairs", () => {
    const path = parseCorridorPath("16.06,108.22;16.06,108.23;16.07,108.23");
    assert.ok(path);
    assert.equal(path.length, 3);
    assert.equal(path[0]!.lat, 16.06);
    assert.equal(path[0]!.lng, 108.22);
  });

  it("refuses a single point — a location is not a route", () => {
    assert.equal(parseCorridorPath("16.06,108.22"), null);
  });

  it("refuses two IDENTICAL points — one place written twice defines no direction", () => {
    assert.equal(parseCorridorPath("16.06,108.22;16.06,108.22"), null);
  });

  it("refuses out-of-range and malformed coordinates rather than clamping them", () => {
    assert.equal(parseCorridorPath("91,0;10,10"), null);
    assert.equal(parseCorridorPath("0,181;10,10"), null);
    assert.equal(parseCorridorPath("0,0,0;10,10"), null);
    assert.equal(parseCorridorPath("abc;10,10"), null);
    assert.equal(parseCorridorPath(""), null);
    assert.equal(parseCorridorPath(undefined), null);
    assert.equal(parseCorridorPath(42), null);
  });

  it("refuses a polyline longer than the vertex cap", () => {
    const tooMany = Array.from({ length: CORRIDOR_MAX_POINTS + 1 }, (_, i) => `10,${i / 1000}`).join(";");
    assert.equal(parseCorridorPath(tooMany), null);
  });

  it("clamps corridorMeters into [MIN, MAX] and defaults when unusable", () => {
    assert.equal(parseCorridorMeters("400"), 400);
    assert.equal(parseCorridorMeters(1), CORRIDOR_MIN_METERS);
    assert.equal(parseCorridorMeters(999_999), CORRIDOR_MAX_METERS);
    assert.equal(parseCorridorMeters("not-a-number"), CORRIDOR_DEFAULT_METERS);
    assert.equal(parseCorridorMeters(undefined), CORRIDOR_DEFAULT_METERS);
  });

  it("buildCorridor refuses a path it cannot travel along", () => {
    assert.equal(buildCorridor(null, 400), null);
    assert.equal(buildCorridor([{ lat: 1, lng: 1 }], 400), null);
    assert.ok(buildCorridor(ROUTE, 400));
  });
});

describe("mapCorridor — geometry", () => {
  it("measures distance to the LINE, not to the nearest vertex", () => {
    // A point sitting just north of the MIDDLE of the first (east-west) leg.
    // Its nearest vertex is ~500 m away along the street; its distance to the
    // line is only the ~110 m perpendicular offset.
    const midLeg = { lat: 16.0610, lng: 108.2250 };
    const d = distanceToPolylineMeters(midLeg, ROUTE);
    assert.ok(d);
    assert.ok(d.offsetMeters > 100 && d.offsetMeters < 125, `offset=${d.offsetMeters}`);
    // ~half a leg along: the first leg is ~0.01° of longitude at this latitude.
    assert.ok(d.alongMeters > 400 && d.alongMeters < 700, `along=${d.alongMeters}`);
  });

  it("clamps past the ends: a point beyond the last vertex attaches to that vertex", () => {
    // Far north of the route's northern end.
    const beyond = { lat: 16.0900, lng: 108.2300 };
    const d = distanceToPolylineMeters(beyond, ROUTE);
    assert.ok(d);
    // ~0.02° of latitude past the end ⇒ ~2.2 km, not 0.
    assert.ok(d.offsetMeters > 2_000 && d.offsetMeters < 2_500, `offset=${d.offsetMeters}`);
  });

  it("refuses a degenerate path or a non-finite point rather than answering 0", () => {
    assert.equal(distanceToPolylineMeters({ lat: 1, lng: 1 }, [{ lat: 0, lng: 0 }]), null);
    assert.equal(distanceToPolylineMeters({ lat: Number.NaN, lng: 1 }, ROUTE), null);
  });

  it("corridorBBox contains the whole polyline plus the corridor width", () => {
    const corridor: Corridor = { path: ROUTE, meters: 500 };
    const bbox = corridorBBox(corridor);
    assert.ok(bbox);
    for (const p of ROUTE) {
      assert.ok(p.lat > bbox.south && p.lat < bbox.north, "lat inside");
      assert.ok(p.lng > bbox.west && p.lng < bbox.east, "lng inside");
    }
    // The pad is at least the corridor width in latitude (~111 km/deg).
    assert.ok(bbox.north - Math.max(...ROUTE.map((p) => p.lat)) >= 500 / 111_320);
  });
});

describe("mapCorridor — the filter", () => {
  const corridor: Corridor = { path: ROUTE, meters: 300 };

  it("includes on-route objects and excludes off-route ones", () => {
    const onRoute = obj("on-route", 16.0601, 108.2250); // ~11 m off the first leg
    const nearCorner = obj("near-corner", 16.0650, 108.2302); // ~21 m off the second leg
    const offRoute = obj("off-route", 16.0500, 108.2250); // ~1.1 km south of the line
    const farEast = obj("far-east", 16.0600, 108.2500); // ~2.1 km past the corner, east

    const result = filterToCorridor([onRoute, nearCorner, offRoute, farEast], corridor);

    assert.deepEqual(result.objects.map((o) => o.id), ["on-route", "near-corner"]);
    assert.equal(result.droppedOffRoute, 2);
    assert.equal(result.droppedNoGeometry, 0);
  });

  it("is a SUBSET of its input, unmodified and in input order", () => {
    const input = [
      obj("a", 16.0601, 108.2210, 120),
      obj("b", 16.0500, 108.2210), // dropped
      obj("c", 16.0601, 108.2290, 10),
      obj("d", 16.0602, 108.2240, 90),
    ];
    const result = filterToCorridor(input, corridor);

    assert.deepEqual(result.objects.map((o) => o.id), ["a", "c", "d"]);
    // Same object references: nothing is rewritten, re-ranked or re-shaped.
    for (const kept of result.objects) {
      assert.ok(input.includes(kept), `${kept.id} is an input object`);
    }
    // Order preserved even though renderingPriority is out of order — the
    // gateway's §31 rank runs AFTER this and must be the one that decides.
    assert.deepEqual(result.objects.map((o) => o.renderingPriority), [120, 10, 90]);
  });

  it("drops an object with no resolvable centroid instead of placing it on the line", () => {
    const broken: MapObject = {
      id: "broken",
      kind: "place",
      geometry: { type: "Point", coordinates: [Number.NaN, Number.NaN] },
      title: "broken",
      privacyClass: "place_level",
      renderingPriority: 40,
    };
    const result = filterToCorridor([broken, obj("ok", 16.0601, 108.2250)], corridor);
    assert.deepEqual(result.objects.map((o) => o.id), ["ok"]);
    assert.equal(result.droppedNoGeometry, 1);
    assert.equal(result.droppedOffRoute, 0);
  });

  it("emits one match per kept object, keyed to that object", () => {
    const result = filterToCorridor(
      [obj("a", 16.0601, 108.2250), obj("b", 16.0500, 108.2250), obj("c", 16.0603, 108.2260)],
      corridor,
    );
    assert.equal(result.matches.length, result.objects.length);
    assert.deepEqual(result.matches.map((m) => m.objectId), result.objects.map((o) => o.id));
  });

  it("a wider corridor is a superset of a narrower one over the same input", () => {
    const input = [
      obj("a", 16.0601, 108.2250),
      obj("b", 16.0620, 108.2250), // ~220 m off
      obj("c", 16.0500, 108.2250), // ~1.1 km off
    ];
    const narrow = filterToCorridor(input, { path: ROUTE, meters: 100 }).objects.map((o) => o.id);
    const wide = filterToCorridor(input, { path: ROUTE, meters: 400 }).objects.map((o) => o.id);
    for (const id of narrow) assert.ok(wide.includes(id), `${id} survives the wider corridor too`);
    assert.ok(wide.length > narrow.length);
  });
});

describe("mapCorridor — detour cost is an estimate, and says so (§37)", () => {
  it("is out-and-back at walking pace", () => {
    // 250 m off the line ⇒ 500 m extra ⇒ 6 min at 5 km/h (83.3 m/min).
    const cost = detourCost({ offsetMeters: 250, alongMeters: 1_000 });
    assert.equal(cost.offsetMeters, 250);
    assert.equal(cost.extraMeters, 500);
    assert.equal(cost.extraMinutes, 6);
    assert.equal(cost.alongMeters, 1_000);
  });

  it("rounds the minutes UP, on a fixture where up and down differ", () => {
    // The 250 m fixture above divides exactly (500 / 83.3̇ = 6.0), so it pins
    // the arithmetic but NOT the rounding: Math.ceil → Math.floor survives it.
    // 100 m off ⇒ 200 m extra ⇒ 2.4 min, where ceil and floor disagree.
    const cost = detourCost({ offsetMeters: 100, alongMeters: 0 });
    assert.equal(cost.extraMeters, 200);
    assert.equal(cost.extraMinutes, 3, "2.4 min is 3 minutes, not 2 — an under-promise costs the traveller");
    // And once more where the fraction is small: 10 m off is 0.24 min, which
    // must still round to a whole minute rather than collapsing to "On your route".
    const tiny = detourCost({ offsetMeters: 10, alongMeters: 0 });
    assert.equal(tiny.extraMinutes, 1);
    assert.match(detourLine(tiny), /^Est\. \+1 min detour/);
  });

  it("never claims to be a measurement", () => {
    const cost = detourCost({ offsetMeters: 250, alongMeters: 0 });
    assert.equal(cost.basis, "straight_line_estimate");
    assert.match(detourLine(cost), /^Est\. \+6 min detour · 250 m off route$/);
  });

  it("says 'On your route' rather than an estimate of zero", () => {
    const line = detourLine(detourCost({ offsetMeters: 0, alongMeters: 10 }));
    assert.match(line, /^On your route/);
    assert.doesNotMatch(line, /Est\./);
  });

  it("switches to km past 1000 m", () => {
    assert.match(detourLine(detourCost({ offsetMeters: 1_500, alongMeters: 0 })), /1\.5 km off route/);
    assert.match(detourLine(detourCost({ offsetMeters: 999, alongMeters: 0 })), /999 m off route/);
  });

  it("every match produced by the filter carries the estimate label", () => {
    const result = filterToCorridor(
      [obj("a", 16.0601, 108.2250), obj("b", 16.0605, 108.2260)],
      { path: ROUTE, meters: 300 },
    );
    assert.ok(result.matches.length > 0);
    for (const m of result.matches) {
      assert.equal(m.detour.basis, "straight_line_estimate");
      assert.ok(/^(Est\. \+\d+ min detour|On your route) · /.test(m.line), m.line);
    }
  });
});
