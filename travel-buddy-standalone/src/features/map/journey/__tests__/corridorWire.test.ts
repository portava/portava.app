/**
 * The Along My Way wire encoding (§36 Phase 6).
 *
 * Two different coordinate orders meet in one query string: `bbox` is
 * w,s,e,n (LONGITUDE first at each end) and `corridor` is lat,lng per vertex.
 * A transposition in either produces a perfectly well-formed request that
 * answers about the wrong part of the world and fails silently, so both are
 * pinned here rather than left to review.
 *
 * Also pinned: a corridor below two points is NOT sent. The server would
 * refuse it as `invalid_corridor`, and a client that sent it anyway would be
 * asking for a radius search around a single position under another name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectionParams } from '../projectionQuery.ts';

const BBOX = { west: 108.1, south: 15.9, east: 108.4, north: 16.2 };

test('bbox is written w,s,e,n — longitude at each end', () => {
  const p = buildProjectionParams({ bbox: BBOX, zoom: 14 });
  assert.equal(p.get('bbox'), '108.1,15.9,108.4,16.2');
  assert.equal(p.get('zoom'), '14');
});

test('a corridor vertex is written lat,lng — the OPPOSITE order to bbox', () => {
  const p = buildProjectionParams({
    bbox: BBOX,
    zoom: 14,
    corridor: [
      { lat: 16.06, lng: 108.22 },
      { lat: 16.07, lng: 108.23 },
    ],
    corridorMeters: 400,
  });
  assert.equal(p.get('corridor'), '16.06,108.22;16.07,108.23');
  assert.equal(p.get('corridorMeters'), '400');
});

test('a corridor below two points is not sent at all', () => {
  const one = buildProjectionParams({
    bbox: BBOX,
    zoom: 14,
    corridor: [{ lat: 16.06, lng: 108.22 }],
    corridorMeters: 400,
  });
  assert.equal(one.get('corridor'), null);
  assert.equal(one.get('corridorMeters'), null, 'no width for a corridor that was not sent');

  const none = buildProjectionParams({ bbox: BBOX, zoom: 14, corridor: [] });
  assert.equal(none.get('corridor'), null);
});

test('corridorMeters is omitted when the caller does not choose one', () => {
  const p = buildProjectionParams({
    bbox: BBOX,
    zoom: 14,
    corridor: [
      { lat: 16.06, lng: 108.22 },
      { lat: 16.07, lng: 108.23 },
    ],
  });
  assert.equal(p.get('corridor'), '16.06,108.22;16.07,108.23');
  assert.equal(p.get('corridorMeters'), null, 'the server applies its own default');
});

test('the other parameters are unaffected by the corridor', () => {
  const p = buildProjectionParams({
    bbox: BBOX,
    zoom: 12,
    kinds: ['place', 'event'],
    limit: 50,
    cursor: 'abc',
    corridor: [
      { lat: 16.06, lng: 108.22 },
      { lat: 16.07, lng: 108.23 },
    ],
  });
  assert.equal(p.get('kinds'), 'place,event');
  assert.equal(p.get('limit'), '50');
  assert.equal(p.get('cursor'), 'abc');
});
