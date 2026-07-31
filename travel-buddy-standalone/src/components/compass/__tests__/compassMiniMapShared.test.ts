/**
 * compassMiniMapShared — formatDistanceKm precise rounding
 *
 * No prior test asserted exact output values for the Compass mini-map's
 * distance formatter (existing CompassChatBlocks tests only check the label
 * ends in "km"/"m"). This locks down the three rounding tiers so a future
 * refactor of the shared utility can't silently introduce a unit mismatch
 * (e.g. displaying raw km as "m", or dropping the km/m boundary).
 *
 * Pure-logic test — runs under node:test (see scripts/run-node-tests.mjs).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatDistanceKm } from '../compassMiniMapShared.ts';

describe('formatDistanceKm', () => {
  test('formats sub-kilometre distances as rounded meters', () => {
    assert.equal(formatDistanceKm(0.85), '850 m');
    assert.equal(formatDistanceKm(0.001), '1 m');
    assert.equal(formatDistanceKm(0), '0 m');
  });

  test('formats distances under 10km with one decimal place', () => {
    assert.equal(formatDistanceKm(1.5), '1.5 km');
    assert.equal(formatDistanceKm(9.96), '10.0 km');
    assert.equal(formatDistanceKm(1), '1.0 km');
  });

  test('formats distances 10km and above as whole kilometers', () => {
    assert.equal(formatDistanceKm(10), '10 km');
    assert.equal(formatDistanceKm(42.4), '42 km');
    assert.equal(formatDistanceKm(1234.6), '1235 km');
  });

  test('rounds at the 1km boundary consistently (no double count / gap)', () => {
    // Just under 1km rounds to meters; at/just over 1km switches to the km tier.
    assert.equal(formatDistanceKm(0.9996), '1000 m');
    assert.equal(formatDistanceKm(1.0001), '1.0 km');
  });
});
