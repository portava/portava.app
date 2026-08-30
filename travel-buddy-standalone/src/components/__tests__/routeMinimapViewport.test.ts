/**
 * computeViewport — RouteMinimapView viewport math.
 *
 * Imports the SHIPPED computeViewport from ../routeMinimapViewport.ts (the same
 * module RouteMinimapView uses), so these assert the real center/zoom output and
 * the real constants (1.6 padding, 0.02 min-delta). The previous test in
 * artifacts/api-server declared its own `computeRegionFromStops` with different
 * constants (1.4 / 0.005) and a different shape ({latitudeDelta,…}) and tested
 * nothing in the component.
 *
 * Run: node --import tsx/esm --test src/components/__tests__/routeMinimapViewport.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeViewport, type ViewportStop } from '../routeMinimapViewport.ts';

function stop(lat: number | null, lng: number | null): ViewportStop {
  return { structuredLocation: { lat, lng } };
}

const MIN_DELTA = 0.02; // must match routeMinimapViewport.ts
const PAD       = 1.6;  // must match routeMinimapViewport.ts

test('empty stop list → null viewport', () => {
  assert.equal(computeViewport([]), null);
});

test('all-null-coordinate stops → null viewport', () => {
  assert.equal(computeViewport([stop(null, null), stop(10, null), stop(null, 20)]), null);
});

test('single stop → center is [lng, lat] and zoom uses the min-delta floor', () => {
  const vp = computeViewport([stop(10, 20)]);
  assert.ok(vp, 'expected a viewport');
  // center is [lng, lat] — order matters (MapLibre convention)
  assert.deepEqual(vp!.center, [20, 10]);
  // deltas floor at MIN_DELTA; for equal deltas the latitude term is the min
  const expectedZoom = Math.log2(180 / MIN_DELTA) - 0.5;
  assert.ok(Math.abs(vp!.zoom - expectedZoom) < 1e-9, `zoom ${vp!.zoom} != ${expectedZoom}`);
});

test('multi-stop → center at bbox midpoint, zoom derived from padded lat span', () => {
  const vp = computeViewport([stop(10, 20), stop(30, 40)]);
  assert.ok(vp, 'expected a viewport');
  assert.deepEqual(vp!.center, [30, 20]); // [ (20+40)/2 , (10+30)/2 ]
  // latDelta = (30-10)*PAD = 32; lngDelta = (40-20)*PAD = 32; lat term is the min
  const latDelta = (30 - 10) * PAD;
  const expectedZoom = Math.log2(180 / latDelta) - 0.5;
  assert.ok(Math.abs(vp!.zoom - expectedZoom) < 1e-9, `zoom ${vp!.zoom} != ${expectedZoom}`);
});

test('a wider bounding box yields a smaller zoom (more zoomed out)', () => {
  const narrow = computeViewport([stop(10, 20), stop(11, 21)])!;
  const wide   = computeViewport([stop(10, 20), stop(40, 60)])!;
  assert.ok(wide.zoom < narrow.zoom, 'wider span must zoom out further');
});

test('stops with partial coordinates are ignored, not defaulted', () => {
  // Only the fully-located stop contributes; the half-pair is dropped.
  const vp = computeViewport([stop(10, 20), stop(50, null)])!;
  assert.deepEqual(vp.center, [20, 10]);
});
