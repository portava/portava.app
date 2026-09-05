/**
 * Along My Way — the client half (§36 Phase 6, §19, §37).
 *
 * The properties these tests exist for:
 *
 *   - THE CORRIDOR IS THE ROUTE ON SCREEN. `corridorPathFromRoutePlan` applies
 *     the same filter, sort and tie-break `composeRoutes` uses to DRAW the
 *     route line, so the corridor can never be measured against a different
 *     line than the one the user is looking at.
 *   - A REFUSAL IS NOT AN EMPTY CORRIDOR. With the flag off the server returns
 *     the WHOLE bbox and reports `flag_off`; folding that into an "along your
 *     way" list would be a lie, so it yields no items.
 *   - §31 ORDER SURVIVES. The fold preserves the gateway's order and never
 *     re-sorts by detour.
 *   - §37. The detour line is passed through verbatim; nothing here computes a
 *     distance or a duration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRIDOR_PRESETS,
  corridorMetersFor,
  corridorPathFromNextStop,
  corridorPathFromRoutePlan,
  corridorSummaryLine,
  foldAlongMyWay,
} from '../alongMyWay.ts';
import type { MapObject } from '../../../../types/mapObjects.ts';
import type {
  MapCorridorMatch,
  MapCorridorReport,
} from '../../../../services/mapProjection.ts';
import type { FullRoutePlan } from '../../../../services/routePlan.ts';

// ── fixtures ──────────────────────────────────────────────────────────────────

function obj(id: string, priority = 40): MapObject {
  return {
    id,
    kind: 'place',
    geometry: { type: 'Point', coordinates: [108.22, 16.06] },
    title: id,
    privacyClass: 'place_level',
    renderingPriority: priority,
  } as MapObject;
}

function report(over: Partial<MapCorridorReport> = {}): MapCorridorReport {
  return {
    refusal: null,
    meters: 400,
    points: 3,
    considered: 10,
    kept: 3,
    droppedOffRoute: 7,
    droppedNoGeometry: 0,
    ...over,
  };
}

function match(objectId: string, minutes: number, offset: number): MapCorridorMatch {
  return {
    objectId,
    detour: {
      offsetMeters: offset,
      extraMeters: offset * 2,
      extraMinutes: minutes,
      alongMeters: 500,
      basis: 'straight_line_estimate',
    },
    line: `Est. +${minutes} min detour · ${offset} m off route`,
  };
}

function routePlan(stops: Array<{ id: string; orderIndex: number; lat?: number; lng?: number }>): FullRoutePlan {
  return {
    plan: { id: 'plan-1', title: 'Today', status: 'active', isApproximated: false },
    stops: stops.map((s) => ({
      id: s.id,
      orderIndex: s.orderIndex,
      structuredLocation:
        s.lat == null || s.lng == null ? null : { label: s.id, lat: s.lat, lng: s.lng },
    })),
    legs: [],
  } as unknown as FullRoutePlan;
}

// ── the polyline we ask with ──────────────────────────────────────────────────

test('corridorPathFromRoutePlan follows orderIndex, not array order', () => {
  const path = corridorPathFromRoutePlan(
    routePlan([
      { id: 'c', orderIndex: 2, lat: 16.07, lng: 108.23 },
      { id: 'a', orderIndex: 0, lat: 16.06, lng: 108.22 },
      { id: 'b', orderIndex: 1, lat: 16.06, lng: 108.23 },
    ]),
  );
  assert.ok(path);
  assert.deepEqual(path.map((p) => p.lng), [108.22, 108.23, 108.23]);
});

test('corridorPathFromRoutePlan drops stops with no usable coordinate', () => {
  const path = corridorPathFromRoutePlan(
    routePlan([
      { id: 'a', orderIndex: 0, lat: 16.06, lng: 108.22 },
      { id: 'no-coords', orderIndex: 1 },
      { id: 'b', orderIndex: 2, lat: 16.07, lng: 108.23 },
    ]),
  );
  assert.equal(path?.length, 2);
});

test('corridorPathFromRoutePlan refuses a route that is one place, however many stops', () => {
  assert.equal(
    corridorPathFromRoutePlan(
      routePlan([
        { id: 'a', orderIndex: 0, lat: 16.06, lng: 108.22 },
        { id: 'b', orderIndex: 1, lat: 16.06, lng: 108.22 },
      ]),
    ),
    null,
    'two entries at one position define no direction to travel',
  );
});

test('corridorPathFromRoutePlan refuses a missing or single-stop plan', () => {
  assert.equal(corridorPathFromRoutePlan(null), null);
  assert.equal(corridorPathFromRoutePlan(undefined), null);
  assert.equal(
    corridorPathFromRoutePlan(routePlan([{ id: 'a', orderIndex: 0, lat: 16.06, lng: 108.22 }])),
    null,
  );
});

test('corridorPathFromNextStop needs two distinct ends', () => {
  const here = { lat: 16.06, lng: 108.22 };
  assert.equal(corridorPathFromNextStop(here, null), null);
  assert.equal(corridorPathFromNextStop(null, here), null);
  assert.equal(corridorPathFromNextStop(here, { ...here }), null, 'here to here is not a journey');
  assert.equal(corridorPathFromNextStop(here, { lat: 16.07, lng: 108.23 })?.length, 2);
});

test('the corridor width presets are a closed set inside the server clamp', () => {
  for (const p of CORRIDOR_PRESETS) {
    assert.ok(p.meters >= 50 && p.meters <= 5000, `${p.key} is inside [50, 5000]`);
  }
  assert.equal(corridorMetersFor('tight'), 200);
  assert.equal(corridorMetersFor('wide'), 1000);
});

// ── folding the answer ────────────────────────────────────────────────────────

test('flag_off yields NO items — the whole bbox is not "along your way"', () => {
  const state = foldAlongMyWay(
    [obj('a'), obj('b'), obj('c')],
    report({ refusal: 'flag_off', kept: 0 }),
    null,
  );
  assert.equal(state.status, 'off');
  assert.deepEqual(state.items, []);
  assert.equal(corridorSummaryLine(state), 'Along My Way is off');
});

test('an unparseable corridor yields no items either', () => {
  const state = foldAlongMyWay([obj('a')], report({ refusal: 'invalid_corridor' }), null);
  assert.equal(state.status, 'invalid');
  assert.deepEqual(state.items, []);
});

test('no corridor requested is its own state, not an empty result', () => {
  const state = foldAlongMyWay([obj('a')], null, null);
  assert.equal(state.status, 'no_route');
  assert.deepEqual(state.items, []);
});

test('the fold preserves the gateway order and never re-sorts by detour', () => {
  const objects = [obj('safety', 120), obj('cafe', 40), obj('poi', 10)];
  const matches = [match('safety', 9, 380), match('cafe', 1, 40), match('poi', 4, 170)];
  const state = foldAlongMyWay(objects, report({ kept: 3 }), matches);
  assert.equal(state.status, 'ready');
  assert.deepEqual(
    state.items.map((i) => i.object.id),
    ['safety', 'cafe', 'poi'],
    'a nearer cafe must not outrank a safety notice',
  );
});

test('the detour line is passed through verbatim (§37)', () => {
  const state = foldAlongMyWay([obj('a')], report({ kept: 1 }), [match('a', 6, 250)]);
  assert.equal(state.status, 'ready');
  assert.equal(state.items[0]!.detourLine, 'Est. +6 min detour · 250 m off route');
  assert.equal(state.items[0]!.detour?.basis, 'straight_line_estimate');
});

test('an object with no match carries no invented detour', () => {
  const state = foldAlongMyWay([obj('cell')], report({ kept: 1 }), []);
  assert.equal(state.status, 'ready');
  assert.equal(state.items[0]!.detour, null);
  assert.equal(state.items[0]!.detourLine, null);
});

test('the summary names what was dropped rather than shrinking silently', () => {
  const state = foldAlongMyWay([obj('a')], report({ kept: 1, droppedOffRoute: 7 }), [match('a', 2, 80)]);
  assert.equal(corridorSummaryLine(state), '1 on your way · 7 off it');
  const clean = foldAlongMyWay([obj('a')], report({ kept: 1, droppedOffRoute: 0 }), [match('a', 2, 80)]);
  assert.equal(corridorSummaryLine(clean), '1 on your way');
});
