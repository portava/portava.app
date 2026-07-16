/**
 * cityCoords — guards the both-or-null coordinate contract.
 *
 * `cityCoordSpread` must return `{ lat, lng }` only when BOTH values are
 * finite numbers and must return an empty object (equivalent to null coords)
 * for every half-pair or invalid input so callers can spread the result
 * directly into a JSON payload without leaking a partial coord.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cityCoordSpread } from '../cityCoords.ts';

describe('cityCoordSpread', () => {
  it('returns { lat, lng } when both are finite numbers', () => {
    const result = cityCoordSpread({ lat: 48.8566, lng: 2.3522 });
    assert.deepEqual(result, { lat: 48.8566, lng: 2.3522 });
  });

  it('returns {} when lat is present but lng is null', () => {
    const result = cityCoordSpread({ lat: 48.8566, lng: null });
    assert.deepEqual(result, {});
  });

  it('returns {} when lng is present but lat is null', () => {
    const result = cityCoordSpread({ lat: null, lng: 2.3522 });
    assert.deepEqual(result, {});
  });

  it('returns {} when both are null', () => {
    const result = cityCoordSpread({ lat: null, lng: null });
    assert.deepEqual(result, {});
  });

  it('returns {} when lat is NaN', () => {
    const result = cityCoordSpread({ lat: NaN, lng: 2.3522 });
    assert.deepEqual(result, {});
  });

  it('returns {} when lng is NaN', () => {
    const result = cityCoordSpread({ lat: 48.8566, lng: NaN });
    assert.deepEqual(result, {});
  });

  it('returns {} when lat is Infinity', () => {
    const result = cityCoordSpread({ lat: Infinity, lng: 2.3522 });
    assert.deepEqual(result, {});
  });

  it('returns {} when lng is -Infinity', () => {
    const result = cityCoordSpread({ lat: 48.8566, lng: -Infinity });
    assert.deepEqual(result, {});
  });

  it('returns {} when coords is null', () => {
    const result = cityCoordSpread(null);
    assert.deepEqual(result, {});
  });

  it('returns {} when coords is undefined', () => {
    const result = cityCoordSpread(undefined);
    assert.deepEqual(result, {});
  });

  it('returns {} when lat is undefined', () => {
    const result = cityCoordSpread({ lat: undefined, lng: 2.3522 });
    assert.deepEqual(result, {});
  });

  it('returns {} when lng is undefined', () => {
    const result = cityCoordSpread({ lat: 48.8566, lng: undefined });
    assert.deepEqual(result, {});
  });
});
