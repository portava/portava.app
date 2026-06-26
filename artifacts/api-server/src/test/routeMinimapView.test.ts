/**
 * RouteMinimapView — region computation snapshot tests.
 *
 * The region logic is the only non-trivial pure computation in the component.
 * It is validated here without a React Native renderer, covering:
 *  - empty / null-coord stops → null region
 *  - single stop → min-delta region centred on that stop
 *  - multi-stop → bounding box correctly padded, centred on midpoint
 *
 * These act as snapshot tests: any change to the bounding-box algorithm must
 * justify a corresponding update here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// ── Region helper (mirrors RouteMinimapView useMemo) ──────────────────────────

const MIN_DELTA = 0.005; // degrees — ensures 1-stop routes have a visible box

function computeRegionFromStops(
  stops: Array<{ lat: number | null; lng: number | null }>,
  padFactor = 1.4,
): { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number } | null {
  const valid = stops.filter(
    (s): s is { lat: number; lng: number } => s.lat != null && s.lng != null,
  );
  if (valid.length === 0) return null;

  const lats   = valid.map((s) => s.lat);
  const lngs   = valid.map((s) => s.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  return {
    latitude:       (minLat + maxLat) / 2,
    longitude:      (minLng + maxLng) / 2,
    latitudeDelta:  Math.max((maxLat - minLat) * padFactor, MIN_DELTA),
    longitudeDelta: Math.max((maxLng - minLng) * padFactor, MIN_DELTA),
  };
}

// ── Snapshot tests ────────────────────────────────────────────────────────────

test("RouteMinimapView: empty stops list → null region", () => {
  assert.equal(computeRegionFromStops([]), null);
});

test("RouteMinimapView: all null-coord stops → null region", () => {
  assert.equal(computeRegionFromStops([{ lat: null, lng: null }]), null);
});

test("RouteMinimapView: mixed null + valid coords — ignores null stops", () => {
  const region = computeRegionFromStops([{ lat: null, lng: null }, { lat: 48.85, lng: 2.35 }]);
  assert.ok(region !== null);
  assert.ok(Math.abs(region.latitude  - 48.85) < 0.001);
  assert.ok(Math.abs(region.longitude - 2.35)  < 0.001);
});

test("RouteMinimapView: single valid stop → minimum-delta region centred on stop", () => {
  const region = computeRegionFromStops([{ lat: 48.8566, lng: 2.3522 }]);
  assert.ok(region !== null, "region should not be null");
  assert.ok(Math.abs(region.latitude  - 48.8566) < 0.0001, "latitude centred");
  assert.ok(Math.abs(region.longitude - 2.3522)  < 0.0001, "longitude centred");
  assert.equal(region.latitudeDelta,  MIN_DELTA, "min-delta applied for latitude");
  assert.equal(region.longitudeDelta, MIN_DELTA, "min-delta applied for longitude");
});

test("RouteMinimapView: two stops — centred on midpoint, delta covers span × padFactor", () => {
  const stops = [
    { lat: 48.85, lng: 2.30 },
    { lat: 48.87, lng: 2.40 },
  ];
  // padFactor=1.0 so we get exact span maths
  const region = computeRegionFromStops(stops, 1.0);
  assert.ok(region !== null);
  assert.ok(Math.abs(region.latitude  - 48.86) < 0.001, "latitude midpoint");
  assert.ok(Math.abs(region.longitude - 2.35)  < 0.001, "longitude midpoint");
  // latDelta = (48.87-48.85)*1 = 0.02; lngDelta = (2.40-2.30)*1 = 0.10
  assert.ok(Math.abs(region.latitudeDelta  - 0.02) < 0.001, "lat delta");
  assert.ok(Math.abs(region.longitudeDelta - 0.10) < 0.001, "lng delta");
});

test("RouteMinimapView: many stops — bounding box covers all, centre is midpoint", () => {
  const stops = [
    { lat: 48.83, lng: 2.33 },
    { lat: 48.85, lng: 2.35 },
    { lat: 48.87, lng: 2.37 },
  ];
  const region = computeRegionFromStops(stops, 1.0);
  assert.ok(region !== null);
  // Centre: lat=(48.83+48.87)/2=48.85, lng=(2.33+2.37)/2=2.35
  assert.ok(Math.abs(region.latitude  - 48.85) < 0.001);
  assert.ok(Math.abs(region.longitude - 2.35)  < 0.001);
  // Span: lat=0.04, lng=0.04
  assert.ok(Math.abs(region.latitudeDelta  - 0.04) < 0.001);
  assert.ok(Math.abs(region.longitudeDelta - 0.04) < 0.001);
});

test("RouteMinimapView: default padFactor (1.4) expands region beyond raw span", () => {
  const stops = [
    { lat: 48.85, lng: 2.35 },
    { lat: 48.87, lng: 2.37 },
  ];
  const tightRegion = computeRegionFromStops(stops, 1.0);
  const paddedRegion = computeRegionFromStops(stops, 1.4);
  assert.ok(tightRegion !== null && paddedRegion !== null);
  assert.ok(paddedRegion.latitudeDelta  > tightRegion.latitudeDelta,  "padded lat larger");
  assert.ok(paddedRegion.longitudeDelta > tightRegion.longitudeDelta, "padded lng larger");
});
