/**
 * Confirms that buildCityCoords rejects Infinity / -Infinity inputs via the
 * isFinite() guard — not silently accepted as valid coordinates.
 *
 * Run via the standard node:test runner (auto-discovered by run-node-tests.mjs):
 *   node --import tsx/esm --test src/lib/__tests__/cityCoords.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCityCoords, cityCoordSpread } from '../cityCoords.ts';

describe('buildCityCoords — string (non-numeric) rejection', () => {
  it('returns {} when lat is a numeric string like "48.8566"', () => {
    const result = buildCityCoords({ lat: '48.8566' as unknown as number, lng: 2.3522 });
    assert.deepEqual(result, {});
  });

  it('returns {} when lat is the string "Infinity"', () => {
    const result = buildCityCoords({ lat: 'Infinity' as unknown as number, lng: 2.3522 });
    assert.deepEqual(result, {});
  });

  it('returns {} when lng is a numeric string like "2.3522"', () => {
    const result = buildCityCoords({ lat: 48.8566, lng: '2.3522' as unknown as number });
    assert.deepEqual(result, {});
  });
});

describe('cityCoordSpread — missing coords contract', () => {
  it('returns exactly {} (not null or undefined) when called with undefined', () => {
    const result = cityCoordSpread(undefined);
    assert.deepEqual(result, {});
  });

  it('returns exactly {} (not null or undefined) when called with null', () => {
    const result = cityCoordSpread(null);
    assert.deepEqual(result, {});
  });
});

describe('buildCityCoords — Infinity rejection', () => {
  it('returns {} when lat is Infinity and lng is finite', () => {
    const result = buildCityCoords({ lat: Infinity, lng: 1 });
    assert.deepEqual(result, {});
  });

  it('returns {} when lng is -Infinity and lat is finite', () => {
    const result = buildCityCoords({ lat: 1, lng: -Infinity });
    assert.deepEqual(result, {});
  });

  it('returns {} when both lat and lng are Infinity', () => {
    const result = buildCityCoords({ lat: Infinity, lng: Infinity });
    assert.deepEqual(result, {});
  });

  it('returns { lat, lng } when both values are valid finite numbers', () => {
    const result = buildCityCoords({ lat: 48.8566, lng: 2.3522 });
    assert.deepEqual(result, { lat: 48.8566, lng: 2.3522 });
  });
});
