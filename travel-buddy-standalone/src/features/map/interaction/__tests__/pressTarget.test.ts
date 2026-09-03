/**
 * pressTarget tests — turning a press into a §25 target.
 *
 * The defect this covers is an absence: `app/map/index.tsx` held `longPress`
 * state and rendered `MapLongPressMenu`, and NOTHING ever set a target. Seven
 * correctly-resolved rows behind a gesture that did not exist.
 *
 * Written against the rules rather than the arithmetic:
 *
 *   §25  a press ALWAYS has a target — empty map is the common case, not an
 *        error, so the coordinate variant is returned rather than null;
 *   §5   markers (Level 4+) sit above zones (Levels 2-3), so a press that is on
 *        both is on the marker;
 *   §31  only what survived collision can be pressed — an object the map
 *        decided not to draw must not be reachable through the glass;
 *   §23  a `none`-rung object is not visible to this viewer, so it is not a
 *        target either: the coordinate under it is the honest answer;
 *   §6   a zone is a soft area, so containment is the outer ring and the
 *        SMALLEST containing zone is the specific answer.
 *
 * The touch radius is asserted through `metresPerPixel` rather than against
 * hardcoded metres, so the tests state the RELATIONSHIP (one touch target at
 * this zoom) and stay true if either constant is retuned.
 *
 * Run: node --import tsx/esm --test src/features/map/interaction/__tests__/pressTarget.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  point,
  type MapObject,
  type MapObjectKind,
  type PrivacyClass,
} from '../../../../types/mapObjects.ts';
import { metresPerPixel } from '../../render/collision.ts';
import { isUsableTarget } from '../longPress.ts';
import {
  PRESS_RADIUS_PT,
  longPressTargetAt,
  pressedObject,
  type PressPoint,
} from '../pressTarget.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DA_NANG_LAT = 16.047079;
const DA_NANG_LNG = 108.220518;
const ZOOM = 16;

/** Metres per degree of latitude — good to ~0.5% anywhere, which is plenty. */
const M_PER_DEG_LAT = 111_320;

/** The touch radius, in metres, at a given latitude and zoom. */
function radiusMetres(lat = DA_NANG_LAT, zoom = ZOOM): number {
  return PRESS_RADIUS_PT * metresPerPixel(lat, zoom);
}

/** A point `metres` due north of another — the simplest offset to reason about. */
function northOf(lat: number, metres: number): number {
  return lat + metres / M_PER_DEG_LAT;
}

function marker(over: Partial<MapObject> = {}): MapObject {
  return {
    id: over.id ?? 'm1',
    kind: (over.kind ?? 'place') as MapObjectKind,
    geometry: over.geometry ?? point(DA_NANG_LAT, DA_NANG_LNG),
    title: over.title ?? 'Bến Xuân Café',
    privacyClass: (over.privacyClass ?? 'place_level') as PrivacyClass,
    renderingPriority: over.renderingPriority ?? 40,
    ...over,
  } as MapObject;
}

/** An axis-aligned square zone, `halfDeg` degrees to a side from its centre. */
function zone(
  halfDeg: number,
  over: Partial<MapObject> = {},
  centre = { lat: DA_NANG_LAT, lng: DA_NANG_LNG },
): MapObject {
  const { lat, lng } = centre;
  return {
    id: over.id ?? 'z1',
    kind: (over.kind ?? 'social_zone') as MapObjectKind,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lng - halfDeg, lat - halfDeg],
        [lng + halfDeg, lat - halfDeg],
        [lng + halfDeg, lat + halfDeg],
        [lng - halfDeg, lat + halfDeg],
        [lng - halfDeg, lat - halfDeg],
      ]],
    },
    title: over.title ?? 'Around Bạch Đằng',
    privacyClass: (over.privacyClass ?? 'aggregate_only') as PrivacyClass,
    renderingPriority: over.renderingPriority ?? 20,
    ...over,
  } as MapObject;
}

function press(lat: number, lng = DA_NANG_LNG, zoom = ZOOM): PressPoint {
  return { lat, lng, zoom };
}

const ON_THE_SPOT = press(DA_NANG_LAT);

// ── §25 · a press always resolves to something ────────────────────────────────

describe('§25 · every press has a target', () => {
  test('bare map yields the pressed coordinate, unrounded', () => {
    const target = longPressTargetAt({}, ON_THE_SPOT);
    assert.equal(target.kind, 'coordinate');
    if (target.kind !== 'coordinate') return;
    // Exactly the point the finger was on. The menu's own title line coarsens
    // it for display (§19); the ACTION must still operate on the real spot.
    assert.equal(target.lat, DA_NANG_LAT);
    assert.equal(target.lng, DA_NANG_LNG);
  });

  test('an empty map is not an error state — the coordinate is usable', () => {
    assert.equal(isUsableTarget(longPressTargetAt({ markers: [], areas: [] }, ON_THE_SPOT)), true);
  });

  test('a press the SDK could not place yields an unusable target, not a throw', () => {
    for (const bad of [press(Number.NaN), press(91), press(0, 181), press(0, Number.NaN)]) {
      const target = longPressTargetAt({ markers: [marker()] }, bad);
      assert.equal(target.kind, 'coordinate');
      assert.equal(isUsableTarget(target), false);
    }
  });

  test('a press with an unusable zoom still resolves rather than throwing', () => {
    const target = longPressTargetAt(
      { markers: [marker()] },
      { lat: DA_NANG_LAT, lng: DA_NANG_LNG, zoom: Number.NaN },
    );
    // Zoom NaN falls back to 0 — the whole world in one tile, so the radius is
    // enormous and the marker under the finger is still found.
    assert.equal(target.kind, 'object');
  });
});

// ── The touch target ──────────────────────────────────────────────────────────

describe('a marker is pressed when the finger is on it', () => {
  test('dead centre hits', () => {
    const m = marker();
    const target = longPressTargetAt({ markers: [m] }, ON_THE_SPOT);
    assert.equal(target.kind, 'object');
    if (target.kind !== 'object') return;
    assert.equal(target.object.id, m.id);
  });

  test('just inside the touch radius hits, just outside falls through', () => {
    const r = radiusMetres();
    const m = marker();
    assert.ok(pressedObject({ markers: [m] }, press(northOf(DA_NANG_LAT, r * 0.9))));
    assert.equal(pressedObject({ markers: [m] }, press(northOf(DA_NANG_LAT, r * 1.1))), null);
  });

  test('the radius is a TOUCH TARGET, so it shrinks as the map zooms in', () => {
    // The same 60 m offset: a hit at z14 where 60 m is well under one touch
    // target, a miss at z18 where 60 m is most of a screen.
    const away = press(northOf(DA_NANG_LAT, 60));
    const m = marker();
    assert.ok(radiusMetres(DA_NANG_LAT, 14) > 60, 'fixture assumes z14 radius exceeds 60 m');
    assert.ok(radiusMetres(DA_NANG_LAT, 18) < 60, 'fixture assumes z18 radius is under 60 m');
    assert.ok(pressedObject({ markers: [m] }, { ...away, zoom: 14 }));
    assert.equal(pressedObject({ markers: [m] }, { ...away, zoom: 18 }), null);
  });

  test('the nearest marker in range wins', () => {
    const r = radiusMetres();
    const near = marker({ id: 'near', geometry: point(northOf(DA_NANG_LAT, r * 0.2), DA_NANG_LNG) });
    const far = marker({ id: 'far', geometry: point(northOf(DA_NANG_LAT, r * 0.8), DA_NANG_LNG) });
    for (const markers of [[near, far], [far, near]]) {
      const hit = pressedObject({ markers }, ON_THE_SPOT);
      assert.equal(hit?.id, 'near');
    }
  });

  test('two markers on the same spot resolve to the one drawn first', () => {
    // The caller passes `CollisionResult.kept`, which is already in §31's
    // priority order, so "first" is "on top" without re-deriving the rules.
    const a = marker({ id: 'on-top' });
    const b = marker({ id: 'underneath' });
    assert.equal(pressedObject({ markers: [a, b] }, ON_THE_SPOT)?.id, 'on-top');
    assert.equal(pressedObject({ markers: [b, a] }, ON_THE_SPOT)?.id, 'underneath');
  });
});

// ── §5 · levels ───────────────────────────────────────────────────────────────

describe('§5 · a marker outranks the zone it sits in', () => {
  const big = zone(0.01);

  test('a press on both is a press on the marker', () => {
    const m = marker();
    const hit = pressedObject({ markers: [m], areas: [big] }, ON_THE_SPOT);
    assert.equal(hit?.id, m.id);
  });

  test('the same press with no marker there is a press on the zone', () => {
    const hit = pressedObject({ markers: [], areas: [big] }, ON_THE_SPOT);
    assert.equal(hit?.id, big.id);
  });

  test('a zone answers a press far from every marker but still inside it', () => {
    // 0.005° north ≈ 550 m — far outside any touch radius, well inside the zone.
    const away = press(DA_NANG_LAT + 0.005);
    const m = marker();
    assert.equal(pressedObject({ markers: [m], areas: [big] }, away)?.id, big.id);
  });
});

// ── §6 · zone containment ─────────────────────────────────────────────────────

describe('§6 · zones answer for the area they cover', () => {
  test('inside is a hit, outside is not', () => {
    const z = zone(0.01);
    assert.equal(pressedObject({ areas: [z] }, press(DA_NANG_LAT + 0.005))?.id, z.id);
    assert.equal(pressedObject({ areas: [z] }, press(DA_NANG_LAT + 0.05)), null);
  });

  test('the smallest containing zone is the specific answer', () => {
    const outer = zone(0.02, { id: 'outer' });
    const inner = zone(0.002, { id: 'inner' });
    for (const areas of [[outer, inner], [inner, outer]]) {
      assert.equal(pressedObject({ areas }, ON_THE_SPOT)?.id, 'inner');
    }
  });

  test('a press inside the outer zone only takes the outer one', () => {
    const outer = zone(0.02, { id: 'outer' });
    const inner = zone(0.002, { id: 'inner' });
    // 0.01° north: outside the inner square, inside the outer one.
    const between = press(DA_NANG_LAT + 0.01);
    assert.equal(pressedObject({ areas: [outer, inner] }, between)?.id, 'outer');
  });

  test('§10 crowd flow is never a press target — a line is not aimable', () => {
    const flow: MapObject = {
      id: 'flow:1',
      kind: 'crowd_flow',
      geometry: {
        type: 'LineString',
        coordinates: [
          [DA_NANG_LNG - 0.01, DA_NANG_LAT],
          [DA_NANG_LNG + 0.01, DA_NANG_LAT],
        ],
      },
      title: 'Movement toward the riverfront',
      privacyClass: 'aggregate_only',
      renderingPriority: 15,
    } as MapObject;
    assert.equal(pressedObject({ areas: [flow] }, ON_THE_SPOT), null);
    assert.equal(longPressTargetAt({ areas: [flow] }, ON_THE_SPOT).kind, 'coordinate');
  });

  test('a degenerate ring is skipped rather than trusted', () => {
    for (const coordinates of [[], [[[0, 0]]], [[[0, 0], [1, 1]]]]) {
      const bad = { ...zone(0.01), geometry: { type: 'Polygon', coordinates } } as MapObject;
      assert.equal(pressedObject({ areas: [bad] }, ON_THE_SPOT), null);
    }
  });
});

// ── §23 / §31 · only what is drawn can be pressed ─────────────────────────────

describe('§23 · a rung the viewer cannot see is not a target', () => {
  test('a `none` object is passed over, and the coordinate answers instead', () => {
    const hidden = marker({ privacyClass: 'none' });
    assert.equal(pressedObject({ markers: [hidden] }, ON_THE_SPOT), null);
    // Not "nothing here to act on" — the spot under it is still a real spot.
    assert.equal(isUsableTarget(longPressTargetAt({ markers: [hidden] }, ON_THE_SPOT)), true);
  });

  test('a nameless or ungeometried object is passed over the same way', () => {
    const untitled = marker({ id: 'untitled', title: '  ' });
    const broken = marker({
      id: 'broken',
      geometry: { type: 'Point', coordinates: [Number.NaN, 0] },
    });
    assert.equal(pressedObject({ markers: [untitled, broken] }, ON_THE_SPOT), null);
  });

  test('a visible marker behind a hidden one still answers', () => {
    const hidden = marker({ id: 'hidden', privacyClass: 'none' });
    const shown = marker({ id: 'shown' });
    assert.equal(pressedObject({ markers: [hidden, shown] }, ON_THE_SPOT)?.id, 'shown');
  });
});

describe('§31 · what the map dropped cannot be reached through the glass', () => {
  test('only the objects handed in are pressable', () => {
    // The caller passes `CollisionResult.kept`; an object §31 dropped is simply
    // not in the list, and the press falls through to the coordinate under it.
    const dropped = marker({ id: 'dropped' });
    assert.equal(pressedObject({ markers: [] }, ON_THE_SPOT), null);
    assert.equal(pressedObject({ markers: [dropped] }, ON_THE_SPOT)?.id, 'dropped');
  });
});

// ── Robustness ────────────────────────────────────────────────────────────────

describe('extremes do not break the maths', () => {
  test('near the poles the radius stays finite and positive', () => {
    for (const lat of [-89.9, -85, 0, 85, 89.9]) {
      const r = radiusMetres(lat, 16);
      assert.ok(Number.isFinite(r) && r >= 0, `radius at ${lat}`);
    }
  });

  test('a marker at the antimeridian is found by a press on the same spot', () => {
    const m = marker({ geometry: point(0, 179.999999) });
    const hit = pressedObject({ markers: [m] }, { lat: 0, lng: 179.999999, zoom: 16 });
    assert.equal(hit?.id, m.id);
  });

  test('an empty input is the same as no input', () => {
    assert.equal(pressedObject({}, ON_THE_SPOT), null);
    assert.equal(pressedObject({ markers: [], areas: [] }, ON_THE_SPOT), null);
  });
});
