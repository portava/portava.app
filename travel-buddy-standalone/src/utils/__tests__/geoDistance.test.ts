/**
 * Unit tests for the shared haversine distance utility.
 *
 * Validates the formula against known city-pair distances and checks all
 * travelTimeLabel branches.
 *
 * Run with:
 *   node --import tsx/esm --test src/utils/__tests__/geoDistance.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, travelTimeLabel } from '../geoDistance.ts';

// ── haversineKm ───────────────────────────────────────────────────────────────

describe('haversineKm', () => {
  it('returns 0 for identical points', () => {
    assert.equal(haversineKm(48.8566, 2.3522, 48.8566, 2.3522), 0);
  });

  it('Paris → London is approximately 341 km', () => {
    // Paris: 48.8566°N, 2.3522°E  |  London: 51.5074°N, 0.1278°W
    const km = haversineKm(48.8566, 2.3522, 51.5074, -0.1278);
    assert.ok(km > 335 && km < 345, `Expected ~341 km, got ${km.toFixed(1)}`);
  });

  it('New York → Los Angeles is approximately 3940 km', () => {
    // New York: 40.7128°N, 74.006°W  |  Los Angeles: 34.0522°N, 118.2437°W
    const km = haversineKm(40.7128, -74.006, 34.0522, -118.2437);
    assert.ok(km > 3930 && km < 3960, `Expected ~3940 km, got ${km.toFixed(1)}`);
  });

  it('Sydney → Melbourne is approximately 713 km', () => {
    // Sydney: 33.8688°S, 151.2093°E  |  Melbourne: 37.8136°S, 144.9631°E
    const km = haversineKm(-33.8688, 151.2093, -37.8136, 144.9631);
    assert.ok(km > 705 && km < 720, `Expected ~713 km, got ${km.toFixed(1)}`);
  });

  it('result is symmetric — A→B equals B→A', () => {
    const a = haversineKm(48.8566, 2.3522, 51.5074, -0.1278);
    const b = haversineKm(51.5074, -0.1278, 48.8566, 2.3522);
    assert.ok(
      Math.abs(a - b) < 1e-6,
      `Expected symmetric result, got A→B=${a} B→A=${b}`,
    );
  });
});

// ── travelTimeLabel ───────────────────────────────────────────────────────────

describe('travelTimeLabel', () => {
  it('very short distance shows walk-only label', () => {
    // 0.5 km * 12 = 6 min walk
    assert.equal(travelTimeLabel(0.5), '6 min walk');
  });

  it('minimum walk label is 1 min', () => {
    // 0.04 km * 12 = 0.48 → rounds to 0, clamped to 1
    assert.equal(travelTimeLabel(0.04), '1 min walk');
  });

  it('distance in the 2–6 km band shows walk + drive', () => {
    const label = travelTimeLabel(3);
    assert.ok(label.includes('min walk'), `Expected walk in label, got: ${label}`);
    assert.ok(label.includes('min drive'), `Expected drive in label, got: ${label}`);
  });

  it('distance > 6 km shows drive-only label', () => {
    const label = travelTimeLabel(10);
    assert.match(label, /^~\d+ min drive$/);
  });

  it('boundary at exactly 2 km uses walk + drive', () => {
    const label = travelTimeLabel(2);
    assert.ok(
      label.includes('min walk') && label.includes('min drive'),
      `Expected walk+drive at 2 km, got: ${label}`,
    );
  });

  it('boundary at exactly 6 km uses drive-only', () => {
    const label = travelTimeLabel(6);
    assert.match(label, /^~\d+ min drive$/);
  });

  it('drive-time calculation is correct for 10 km', () => {
    // 10 * 2 = 20 min drive
    assert.equal(travelTimeLabel(10), '~20 min drive');
  });
});
