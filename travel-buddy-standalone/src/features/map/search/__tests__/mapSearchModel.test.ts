/**
 * Map search guards (spec §27).
 *
 * The property these tests exist for: "Geographic results should center or
 * frame the relevant map object." An Area must FRAME its bounds — centring on
 * its centroid at a place-level zoom puts the searched-for thing off every edge
 * of the screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_SEARCH_GROUP_LABELS,
  MAP_SEARCH_RESULT_TYPES,
  anchorOf,
  compareSearchResults,
  frameFor,
  frameForResultSet,
  groupResults,
  isGeographic,
  orderResults,
} from '../mapSearchModel.ts';
import type {
  AreaSearchResult,
  MapSearchResult,
  PlaceSearchResult,
} from '../mapSearchModel.ts';

const DA_NANG: AreaSearchResult = {
  id: 'area-danang',
  type: 'area',
  title: 'An Thuong',
  areaKind: 'neighborhood',
  bounds: { south: 16.03, west: 108.23, north: 16.06, east: 108.26 },
  score: 5,
};

const CAFE: PlaceSearchResult = {
  id: 'place-1',
  type: 'place',
  title: '43 Factory',
  center: { lat: 16.071, lng: 108.211 },
  score: 9,
};

// ── §27: centre or frame ───────────────────────────────────────────────────────

test('an Area FRAMES its bounds rather than centring on its centroid', () => {
  const frame = frameFor(DA_NANG);
  assert.equal(frame.kind, 'bounds');
  if (frame.kind !== 'bounds') return;

  assert.equal(frame.cameraState, 'FOCUS_AREA');
  // The frame must fully contain the area, with margin on every side.
  assert.ok(frame.bounds.south < DA_NANG.bounds.south);
  assert.ok(frame.bounds.west < DA_NANG.bounds.west);
  assert.ok(frame.bounds.north > DA_NANG.bounds.north);
  assert.ok(frame.bounds.east > DA_NANG.bounds.east);
  assert.ok(!('zoom' in frame), 'a framed target must not carry a fixed zoom');
  assert.ok(!('center' in frame), 'a framed target must not carry a centre to fly to');
});

test('the Area centroid is available as a label anchor but is NOT the frame', () => {
  const anchor = anchorOf(DA_NANG);
  assert.deepEqual(anchor, { lat: 16.045, lng: 108.245 });
  const frame = frameFor(DA_NANG);
  assert.notEqual(frame.kind, 'center');
});

test('a point result centres at a place-level zoom', () => {
  const frame = frameFor(CAFE);
  assert.equal(frame.kind, 'center');
  if (frame.kind !== 'center') return;
  assert.deepEqual(frame.center, CAFE.center);
  assert.equal(frame.zoom, 16);
  assert.equal(frame.cameraState, 'FOCUS_PLACE');
});

test('a degenerate Area falls back to centring instead of zooming to infinity', () => {
  const frame = frameFor({
    ...DA_NANG,
    bounds: { south: 16.05, west: 108.24, north: 16.05, east: 108.24 },
  });
  assert.equal(frame.kind, 'center');
});

test('a trip frames its stops, and centres when it has only one', () => {
  const multi = frameFor({
    id: 't1',
    type: 'trip',
    title: 'Da Nang week',
    stops: [
      { lat: 16.0, lng: 108.1 },
      { lat: 16.3, lng: 108.4 },
    ],
  });
  assert.equal(multi.kind, 'bounds');
  if (multi.kind === 'bounds') assert.equal(multi.cameraState, 'FOCUS_TRIP');

  const single = frameFor({
    id: 't2',
    type: 'trip',
    title: 'Day trip',
    stops: [{ lat: 16.0, lng: 108.1 }],
  });
  assert.equal(single.kind, 'center');
  if (single.kind === 'center') assert.equal(single.cameraState, 'FOCUS_TRIP');
});

test('a hashtag frames the spread of what carries it', () => {
  const frame = frameFor({
    id: 'h1',
    type: 'hashtag',
    title: '#anthuong',
    tag: 'anthuong',
    count: 40,
    points: [
      { lat: 16.03, lng: 108.23 },
      { lat: 16.06, lng: 108.26 },
    ],
  });
  assert.equal(frame.kind, 'bounds');
});

test('a saved Area frames; a saved place centres', () => {
  const savedArea = frameFor({
    id: 's1',
    type: 'saved',
    title: 'My neighborhood',
    savedKind: 'area',
    bounds: { south: 1, west: 1, north: 2, east: 2 },
  });
  assert.equal(savedArea.kind, 'bounds');

  const savedPlace = frameFor({
    id: 's2',
    type: 'saved',
    title: 'That noodle place',
    savedKind: 'place',
    center: { lat: 16.05, lng: 108.24 },
  });
  assert.equal(savedPlace.kind, 'center');
});

test('a result with no geometry disables the camera rather than guessing', () => {
  const frame = frameFor({ id: 'u1', type: 'user', title: 'kim' });
  assert.deepEqual(frame, { kind: 'none', reason: 'no_geometry' });
  assert.equal(isGeographic({ id: 'u1', type: 'user', title: 'kim' }), false);
});

test('every one of the nine §27 types has a framing rule and a label', () => {
  assert.equal(MAP_SEARCH_RESULT_TYPES.length, 9);
  for (const type of MAP_SEARCH_RESULT_TYPES) {
    assert.equal(typeof MAP_SEARCH_GROUP_LABELS[type], 'string');
    assert.ok(MAP_SEARCH_GROUP_LABELS[type].length > 0);
  }
});

// ── Result-set framing ─────────────────────────────────────────────────────────

test('a whole result set frames everything geographic, Areas included whole', () => {
  const frame = frameForResultSet([
    CAFE,
    DA_NANG,
    { id: 'u1', type: 'user', title: 'kim' },
  ]);
  assert.equal(frame.kind, 'bounds');
  if (frame.kind !== 'bounds') return;
  // The Area's far corners, not just its centroid, are inside the set frame.
  assert.ok(frame.bounds.south <= DA_NANG.bounds.south);
  assert.ok(frame.bounds.north >= DA_NANG.bounds.north);
  assert.ok(frame.bounds.west <= DA_NANG.bounds.west);
  assert.ok(frame.bounds.east >= DA_NANG.bounds.east);
  // …and so is the point result.
  assert.ok(frame.bounds.north >= CAFE.center.lat && frame.bounds.west <= CAFE.center.lng);
});

test('a result set with one geographic result reuses that result\'s frame', () => {
  const frame = frameForResultSet([DA_NANG, { id: 'u1', type: 'user', title: 'kim' }]);
  assert.deepEqual(frame, frameFor(DA_NANG));
});

test('a fully non-geographic result set moves no camera', () => {
  assert.deepEqual(frameForResultSet([{ id: 'u1', type: 'user', title: 'kim' }]), {
    kind: 'none',
    reason: 'no_geometry',
  });
});

// ── Ordering and grouping ──────────────────────────────────────────────────────

const MIXED: MapSearchResult[] = [
  { id: 'p2', type: 'place', title: 'Bánh Mì Bà Lan', center: { lat: 16.06, lng: 108.22 }, score: 3 },
  CAFE,
  DA_NANG,
  { id: 'e1', type: 'event', title: 'Sunset set', center: { lat: 16.05, lng: 108.24 }, score: 7 },
  { id: 'g1', type: 'hidden_gem', title: 'Stairs to nowhere', center: { lat: 16.04, lng: 108.25 }, score: 8 },
  { id: 'u1', type: 'user', title: 'kim', score: 2 },
];

test('groups appear in the §27 order regardless of relevance', () => {
  const groups = groupResults(MIXED);
  assert.deepEqual(groups.map((g) => g.type), ['place', 'event', 'user', 'hidden_gem', 'area']);
});

test('grouping never mutates the input and is deterministic', () => {
  const before = JSON.parse(JSON.stringify(MIXED));
  const a = groupResults(MIXED).map((g) => `${g.type}:${g.results.map((r) => r.id).join(',')}`);
  const b = groupResults([...MIXED].reverse()).map(
    (g) => `${g.type}:${g.results.map((r) => r.id).join(',')}`,
  );
  assert.deepEqual(MIXED, before);
  assert.deepEqual(a, b);
});

test('within a group, higher score wins and ties break totally', () => {
  const ordered = orderResults([
    { id: 'z', type: 'place', title: 'Same', center: { lat: 0, lng: 0 }, score: 1 },
    { id: 'a', type: 'place', title: 'Same', center: { lat: 0, lng: 0 }, score: 1 },
    { id: 'm', type: 'place', title: 'Same', center: { lat: 0, lng: 0 }, score: 2 },
  ]);
  assert.deepEqual(ordered.map((r) => r.id), ['m', 'a', 'z']);
});

test('distance breaks a score tie before the title does', () => {
  const ordered = orderResults([
    { id: 'far', type: 'place', title: 'A', center: { lat: 0, lng: 0 }, score: 1, distanceKm: 9 },
    { id: 'near', type: 'place', title: 'B', center: { lat: 0, lng: 0 }, score: 1, distanceKm: 1 },
  ]);
  assert.deepEqual(ordered.map((r) => r.id), ['near', 'far']);
});

test('type weights bias the mix without reordering the sections', () => {
  const groups = groupResults(MIXED, { typeWeights: { area: 100 } });
  assert.deepEqual(groups.map((g) => g.type), ['place', 'event', 'user', 'hidden_gem', 'area']);
  const flat = orderResults(MIXED, { typeWeights: { area: 100 } });
  assert.equal(flat[0].id, 'area-danang');
});

test('preferGeographic sinks results the map cannot place', () => {
  const flat = orderResults(MIXED, { preferGeographic: true });
  assert.equal(flat[flat.length - 1].id, 'u1');
});

test('duplicate results collapse and blank results are dropped', () => {
  const groups = groupResults([
    CAFE,
    CAFE,
    { id: '', type: 'place', title: 'no id', center: { lat: 0, lng: 0 } },
    { id: 'blank', type: 'place', title: '   ', center: { lat: 0, lng: 0 } },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].results.map((r) => r.id), ['place-1']);
});

test('limitPerGroup caps each section independently', () => {
  const groups = groupResults(MIXED, { limitPerGroup: 1 });
  for (const g of groups) assert.ok(g.results.length <= 1);
});

test('omitEmpty:false keeps all nine sections', () => {
  const groups = groupResults([CAFE], { omitEmpty: false });
  assert.equal(groups.length, 9);
});

test('compareSearchResults is antisymmetric on the sample set', () => {
  for (const a of MIXED) {
    for (const b of MIXED) {
      const ab = compareSearchResults(a, b);
      const ba = compareSearchResults(b, a);
      if (a === b) assert.equal(ab, 0);
      else assert.equal(Math.sign(ab), -Math.sign(ba));
    }
  }
});
