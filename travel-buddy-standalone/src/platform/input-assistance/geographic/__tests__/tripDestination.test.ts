/**
 * Phase 2 (Geographic Core) — trip destination canonical-resolution fix.
 *
 * The audited bug: trip/edit hydrated its destination as `{…} as Place` with
 * null id/lat/lng and no canonicalId, so saving without re-picking persisted a
 * non-canonical destination. These tests pin the PURE halves of the fix (the RN
 * screen just wires them to `resolveCanonical`).
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hydrateTripDestination, prepareTripDestinationForSave } from '../tripDestination.ts';
import type { Place } from '../../../../lib/location/placeTypes.ts';

test('hydrateTripDestination builds a well-formed Place (real id, no canonicalId)', () => {
  const p = hydrateTripDestination('Da Nang', 'Vietnam');
  assert.ok(p, 'expected a Place');
  // The whole point of the fix: a stable id (so resolveCanonical can cache it),
  // NOT the old undefined-id placeholder.
  assert.ok(p!.id && p!.id.length > 0);
  assert.equal(p!.city, 'Da Nang');
  assert.equal(p!.country, 'Vietnam');
  assert.equal(p!.displayName, 'Da Nang, Vietnam');
  // No canonicalId yet — that is what marks it as still needing resolution.
  assert.ok(!p!.canonicalId);
});

test('hydrateTripDestination trims and treats an empty/blank city as no destination', () => {
  assert.equal(hydrateTripDestination('', 'Vietnam'), null);
  assert.equal(hydrateTripDestination('   ', undefined), null);
  assert.equal(hydrateTripDestination(null, null), null);
  assert.equal(hydrateTripDestination(undefined), null);
});

test('hydrateTripDestination handles a city with no country', () => {
  const p = hydrateTripDestination('Singapore');
  assert.ok(p);
  assert.equal(p!.city, 'Singapore');
  assert.equal(p!.country, null);
  assert.equal(p!.displayName, 'Singapore');
});

test('prepareTripDestinationForSave: a hydrated placeholder needs resolution', () => {
  const p = hydrateTripDestination('Da Nang', 'Vietnam')!;
  const prep = prepareTripDestinationForSave(p);
  assert.equal(prep.needsResolution, true);
  assert.equal(prep.place, p); // resolution itself is the caller's async step
});

test('prepareTripDestinationForSave: an already-canonical place is ready to save', () => {
  const resolved = { ...hydrateTripDestination('Da Nang', 'Vietnam')!, canonicalId: 'city_da_nang' } as Place;
  assert.equal(prepareTripDestinationForSave(resolved).needsResolution, false);
});
