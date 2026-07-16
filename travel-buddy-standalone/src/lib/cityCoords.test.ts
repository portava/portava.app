/**
 * Guards the city-coordinate both-or-null contract:
 *  - partial pairs (lat without lng, or vice versa) are never forwarded to the API
 *  - returned keys are exactly `lat` and `lng` (the API field names)
 *  - coordinate values pass through unchanged — no accidental rounding
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCityCoords, cityCoordSpread } from './cityCoords.ts';

// ── buildCityCoords ───────────────────────────────────────────────────────────

test('buildCityCoords returns both coords when both are present', () => {
  const result = buildCityCoords(35.6895, 139.6917);
  assert.deepEqual(result, { lat: 35.6895, lng: 139.6917 });
});

test('buildCityCoords API keys are exactly lat and lng', () => {
  const result = buildCityCoords(35.6895, 139.6917);
  assert.notEqual(result, null);
  assert.deepEqual(Object.keys(result!).sort(), ['lat', 'lng']);
});

test('buildCityCoords forwards values unchanged — no rounding', () => {
  const lat = 48.8566101;
  const lng = 2.3514992;
  const result = buildCityCoords(lat, lng);
  assert.notEqual(result, null);
  assert.equal(result!.lat, lat);
  assert.equal(result!.lng, lng);
});

test('buildCityCoords returns null when lat is null', () => {
  assert.equal(buildCityCoords(null, 139.6917), null);
});

test('buildCityCoords returns null when lng is null', () => {
  assert.equal(buildCityCoords(35.6895, null), null);
});

test('buildCityCoords returns null when both are null', () => {
  assert.equal(buildCityCoords(null, null), null);
});

test('buildCityCoords returns null when lat is undefined', () => {
  assert.equal(buildCityCoords(undefined, 139.6917), null);
});

test('buildCityCoords returns null when lng is undefined', () => {
  assert.equal(buildCityCoords(35.6895, undefined), null);
});

test('buildCityCoords returns null when both are undefined', () => {
  assert.equal(buildCityCoords(undefined, undefined), null);
});

// ── cityCoordSpread ───────────────────────────────────────────────────────────

test('cityCoordSpread spreads both lat and lng when both are present', () => {
  const spread = cityCoordSpread(35.6895, 139.6917);
  assert.deepEqual(spread, { lat: 35.6895, lng: 139.6917 });
});

test('cityCoordSpread returns empty object when lat is null — no half-pair', () => {
  const spread = cityCoordSpread(null, 139.6917);
  assert.deepEqual(spread, {});
  assert.equal('lat' in spread, false);
  assert.equal('lng' in spread, false);
});

test('cityCoordSpread returns empty object when lng is null — no half-pair', () => {
  const spread = cityCoordSpread(35.6895, null);
  assert.deepEqual(spread, {});
  assert.equal('lat' in spread, false);
  assert.equal('lng' in spread, false);
});

test('cityCoordSpread never ships lat alone', () => {
  const spread = cityCoordSpread(35.6895, undefined);
  assert.equal('lat' in spread, false);
});

test('cityCoordSpread never ships lng alone', () => {
  const spread = cityCoordSpread(undefined, 139.6917);
  assert.equal('lng' in spread, false);
});

test('cityCoordSpread returns empty object when both are undefined', () => {
  assert.deepEqual(cityCoordSpread(undefined, undefined), {});
});

test('cityCoordSpread forwards coord values unchanged', () => {
  const lat = 40.4167754;
  const lng = -3.7037902;
  const spread = cityCoordSpread(lat, lng);
  assert.equal((spread as any).lat, lat);
  assert.equal((spread as any).lng, lng);
});
