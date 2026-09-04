/**
 * §38 arrival prompt — the pure decision.
 *
 * "arrives, and later answers a one-tap prompt about the crowd." This file pins
 * the decision that fires that prompt: only at a Compass Pick, only once, only
 * when the user is genuinely within reach, nearest-first and deterministic.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARRIVAL_RADIUS_M,
  detectArrivalPick,
  distanceMeters,
  isCompassPick,
} from '../arrivalPromptModel.ts';
import { point, type MapObject } from '../../../../types/mapObjects.ts';

const HERE = { lat: 16.06, lng: 108.22 };

/** A Compass-pick MapObject at (lat,lng). `pick:false` makes an ordinary object. */
function pickAt(id: string, lat: number, lng: number, pick = true): MapObject {
  return {
    id,
    kind: 'place',
    geometry: point(lat, lng),
    title: id,
    privacyClass: 'place_level',
    renderingPriority: 50,
    ...(pick ? { payload: { compassPick: true } } : {}),
  } as MapObject;
}

/** ~metres north of HERE, so a case can sit just inside/outside the radius. */
function north(meters: number): { lat: number; lng: number } {
  return { lat: HERE.lat + meters / 111_320, lng: HERE.lng };
}

describe('distanceMeters', () => {
  test('is ~0 for the same point and grows with separation', () => {
    assert.ok(distanceMeters(HERE, HERE) < 1);
    const d = distanceMeters(HERE, north(100));
    assert.ok(Math.abs(d - 100) < 2, `expected ~100 m, got ${d}`);
  });
});

describe('isCompassPick', () => {
  test('is true only for the §6 star payload', () => {
    assert.equal(isCompassPick(pickAt('a', 16.06, 108.22)), true);
    assert.equal(isCompassPick(pickAt('b', 16.06, 108.22, false)), false);
    assert.equal(isCompassPick(null), false);
    assert.equal(isCompassPick(undefined), false);
  });
});

describe('detectArrivalPick', () => {
  const empty = new Set<string>();

  test('returns a pick the user is within radius of', () => {
    const picks = [pickAt('p1', HERE.lat, HERE.lng)];
    assert.equal(detectArrivalPick(HERE, picks, empty)?.id, 'p1');
  });

  test('returns null when the nearest pick is outside the radius', () => {
    const picks = [pickAt('far', north(ARRIVAL_RADIUS_M + 60).lat, HERE.lng)];
    assert.equal(detectArrivalPick(HERE, picks, empty), null);
  });

  test('never fires without a usable user position', () => {
    const picks = [pickAt('p1', HERE.lat, HERE.lng)];
    assert.equal(detectArrivalPick(null, picks, empty), null);
    assert.equal(detectArrivalPick({ lat: Number.NaN, lng: 108.22 }, picks, empty), null);
  });

  test('ignores objects that are not Compass Picks', () => {
    const picks = [pickAt('plain', HERE.lat, HERE.lng, false)];
    assert.equal(detectArrivalPick(HERE, picks, empty), null);
  });

  test('does not re-fire for a pick already prompted (one-tap, §38)', () => {
    const picks = [pickAt('p1', HERE.lat, HERE.lng)];
    assert.equal(detectArrivalPick(HERE, picks, new Set(['p1'])), null);
  });

  test('chooses the NEAREST eligible pick, deterministically', () => {
    const picks = [
      pickAt('far', north(90).lat, HERE.lng), // ~90 m
      pickAt('near', north(20).lat, HERE.lng), // ~20 m
    ];
    assert.equal(detectArrivalPick(HERE, picks, empty)?.id, 'near');
  });

  test('skips a prompted nearer pick and returns the next eligible one', () => {
    const picks = [
      pickAt('near', north(20).lat, HERE.lng),
      pickAt('mid', north(80).lat, HERE.lng),
    ];
    assert.equal(detectArrivalPick(HERE, picks, new Set(['near']))?.id, 'mid');
  });

  test('empty / null pick lists yield null', () => {
    assert.equal(detectArrivalPick(HERE, [], empty), null);
    assert.equal(detectArrivalPick(HERE, null, empty), null);
  });
});
