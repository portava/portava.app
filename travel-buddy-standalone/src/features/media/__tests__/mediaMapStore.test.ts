/**
 * features/media — mediaMapStore (census-media §19: MD25 · MD329 · MD405 · MD416
 * · MD35 / MD449 via the owner cluster source).
 *
 * §21: "Media Map consumes the canonical Map projection system; it does not own
 * a second location engine." The properties that make that true here:
 *   1. positions come ONLY from canonical Map `place:<uuid>` objects;
 *   2. a cluster the Map did not position is listed as unpositioned — never
 *      placed at an invented point;
 *   3. an APPROXIMATE gem is a contoured zone, never a pin; a `none` /
 *      `aggregate_only` gem is not drawn at all (§46.1);
 *   4. the lens decides gem membership, the Map decides gem geometry;
 *   5. an unreadable count is an error, and a missing viewport / disabled
 *      gateway is said in words rather than drawn as an empty map.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapMediaMapProjection,
  clustersFromOwnMedia,
  joinClustersToPositions,
  gemMapTreatment,
  gemZonesFrom,
  gemZoneFeatures,
  circleRing,
  mediaMapReducer,
  selectMediaMapModel,
  positionsUnavailableCopy,
  placeIdOfMapObject,
  INITIAL_MEDIA_MAP_STATE,
  APPROXIMATE_GEM_ZONE_RADIUS_M,
  type MediaMapCluster,
} from '../state/mediaMapStore.ts';
import type { MapObject, PrivacyClass } from '../../../types/mapObjects.ts';
import type { MediaProjection } from '../types/media.ts';

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';

function placeObj(placeId: string, lat: number, lng: number, privacyClass: PrivacyClass = 'place_level'): MapObject {
  return {
    id: `place:${placeId}`,
    kind: 'place',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    title: `Place ${placeId.slice(0, 4)}`,
    privacyClass,
    renderingPriority: 1,
  };
}

function gemObj(gemId: string, lat: number, lng: number, privacyClass: PrivacyClass): MapObject {
  return {
    id: `gem:${gemId}`,
    kind: 'hidden_gem',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    title: `Gem ${gemId}`,
    privacyClass,
    renderingPriority: 2,
  };
}

function cluster(placeId: string, n: number): MediaMapCluster {
  return { placeId, label: `Place ${placeId.slice(0, 4)}`, perspectiveCount: n, freshness: 'fresh' };
}

function media(id: string, placeId: string | null, name = 'Somewhere'): MediaProjection {
  return {
    id,
    mediaType: 'image',
    thumbnailUrl: null,
    observationClass: 'observed',
    freshness: 'recent',
    place: placeId ? { id: placeId, name } : null,
  };
}

test('mapMediaMapProjection: reads counts per canonical place; drops label-only and zero clusters; never reads `live`', () => {
  const p = mapMediaMapProjection({
    generatedAt: '2026-09-26T00:00:00.000Z',
    totalPerspectives: 9,
    clusters: [
      { placeId: P1, label: 'An Thuong', perspectiveCount: 8, freshness: 'fresh' },
      { placeId: null, label: 'Label only', perspectiveCount: 3, freshness: 'fresh' },
      { placeId: P2, label: 'Empty', perspectiveCount: 0, freshness: 'fresh' },
      { placeId: 'x', label: 'Live?', perspectiveCount: 1, freshness: 'live' },
    ],
  });
  assert.deepEqual(p.clusters.map((c) => c.placeId), [P1, 'x']);
  assert.equal(p.clusters[1]!.freshness, null, 'a map cluster is never rendered as live');
});

test('positions come ONLY from canonical place objects; an unpositioned cluster is listed, never placed', () => {
  const j = joinClustersToPositions([cluster(P1, 5), cluster(P2, 2)], [placeObj(P1, 16.06, 108.24)]);
  assert.deepEqual(j.positioned.map((c) => [c.placeId, c.lat, c.lng]), [[P1, 16.06, 108.24]]);
  assert.deepEqual(j.unpositioned.map((c) => c.placeId), [P2]);
  // A gem object at the same id space is not a place position.
  const g = joinClustersToPositions([cluster(P1, 5)], [gemObj(P1, 1, 1, 'place_level')]);
  assert.equal(g.positioned.length, 0);
});

test('a place the Map served at the `none` rung does not position anything', () => {
  const j = joinClustersToPositions([cluster(P1, 5)], [placeObj(P1, 16, 108, 'none')]);
  assert.equal(j.positioned.length, 0);
  assert.equal(j.unpositioned.length, 1);
});

test('placeIdOfMapObject reads only `place:<uuid>` of kind place', () => {
  assert.equal(placeIdOfMapObject({ id: `place:${P1}`, kind: 'place' }), P1);
  assert.equal(placeIdOfMapObject({ id: P1, kind: 'place' }), null);
  assert.equal(placeIdOfMapObject({ id: `place:${P1}`, kind: 'event' }), null);
});

test('§46.1: the treatment is decided by the privacy rung alone', () => {
  assert.equal(gemMapTreatment('approximate'), 'approximate_zone');
  assert.equal(gemMapTreatment('place_level'), 'contour_marker');
  assert.equal(gemMapTreatment('precise_temporary'), 'contour_marker');
  assert.equal(gemMapTreatment('none'), null);
  assert.equal(gemMapTreatment('aggregate_only'), null);
});

test('an APPROXIMATE gem becomes a contoured AREA at neighbourhood scale, never a marker; hidden rungs are not drawn', () => {
  const zones = gemZonesFrom([
    gemObj('a', 16.1, 108.2, 'approximate'),
    gemObj('b', 16.2, 108.3, 'place_level'),
    gemObj('c', 16.3, 108.4, 'none'),
    gemObj('d', 16.4, 108.5, 'aggregate_only'),
  ]);
  assert.deepEqual(zones.map((z) => [z.gemId, z.treatment]), [['a', 'approximate_zone'], ['b', 'contour_marker']]);
  assert.equal(zones[0]!.radiusMeters, APPROXIMATE_GEM_ZONE_RADIUS_M);
  assert.ok(APPROXIMATE_GEM_ZONE_RADIUS_M >= 500, 'an approximate area must not be drawn at doorstep scale');
  const fc = gemZoneFeatures(zones);
  assert.deepEqual(fc.features.map((f) => f.properties.gemId), ['a'], 'only the approximate gem is a polygon');
});

test('the lens decides MEMBERSHIP, the Map decides GEOMETRY: a gem the lens did not disclose is not drawn', () => {
  const zones = gemZonesFrom([gemObj('a', 16.1, 108.2, 'approximate'), gemObj('z', 16.2, 108.3, 'approximate')], new Set(['a']));
  assert.deepEqual(zones.map((z) => z.gemId), ['a']);
});

test('circleRing is a closed ring whose points sit at the drawn radius', () => {
  const ring = circleRing(16, 108, 800, 16);
  assert.equal(ring.length, 17);
  assert.deepEqual(ring[0], ring[16]);
  const [lng, lat] = ring[4]!; // quarter turn: due north
  assert.ok(Math.abs(lng - 108) < 1e-9);
  assert.ok(Math.abs((lat - 16) * 111_320 - 800) < 1, 'north point must be ~800 m away');
});

test('clustersFromOwnMedia: the owner\'s media by canonical place, de-duplicated; media with no place is not clustered', () => {
  const c = clustersFromOwnMedia([media('m1', P1, 'Rooftop'), media('m2', P1), media('m1', P1), media('m3', null), media('m4', P2)]);
  assert.deepEqual(c.map((x) => [x.placeId, x.perspectiveCount]), [[P1, 2], [P2, 1]]);
  assert.equal(c[0]!.label, 'Rooftop');
});

test('reducer: no location / disabled gateway / failed gateway are three different, worded states — none of them is "empty"', () => {
  const ok = { ok: true as const, data: [cluster(P1, 3)] };
  const s1 = mediaMapReducer(INITIAL_MEDIA_MAP_STATE, { type: 'load_result', clusters: ok, positions: { ok: false, reason: 'no_location' } });
  assert.equal(s1.status, 'ready');
  assert.equal(s1.positionsUnavailable, 'no_location');
  const s2 = mediaMapReducer(INITIAL_MEDIA_MAP_STATE, { type: 'load_result', clusters: ok, positions: { ok: true, enabled: false, objects: [] } });
  assert.equal(s2.positionsUnavailable, 'map_disabled');
  const s3 = mediaMapReducer(INITIAL_MEDIA_MAP_STATE, { type: 'load_result', clusters: ok, positions: { ok: false, reason: 'map_failed' } });
  assert.equal(s3.positionsUnavailable, 'map_failed');
  for (const r of ['no_location', 'map_disabled', 'map_failed'] as const) assert.ok(positionsUnavailableCopy(r));
});

test('reducer: an UNREADABLE count is an error, not an empty map', () => {
  const s = mediaMapReducer(INITIAL_MEDIA_MAP_STATE, {
    type: 'load_result',
    clusters: { ok: false, data: null, errorKind: 'server', message: 'HTTP 503' },
    positions: { ok: true, enabled: true, objects: [] },
  });
  assert.equal(s.status, 'error');
  const empty = mediaMapReducer(INITIAL_MEDIA_MAP_STATE, {
    type: 'load_result',
    clusters: { ok: true, data: [] },
    positions: { ok: true, enabled: true, objects: [] },
  });
  assert.equal(empty.status, 'empty');
});

test('a gem-only map is not empty when the Map served gems', () => {
  const s = mediaMapReducer(INITIAL_MEDIA_MAP_STATE, {
    type: 'load_result',
    clusters: { ok: true, data: [] },
    positions: { ok: true, enabled: true, objects: [gemObj('a', 1, 1, 'approximate')] },
    expectGems: true,
  });
  assert.equal(s.status, 'ready');
});

test('selectMediaMapModel: layers toggle what is drawn; selection resolves to the cluster', () => {
  let s = mediaMapReducer(INITIAL_MEDIA_MAP_STATE, {
    type: 'load_result',
    clusters: { ok: true, data: [cluster(P1, 4)] },
    positions: { ok: true, enabled: true, objects: [placeObj(P1, 16, 108), gemObj('a', 16.1, 108.1, 'approximate')] },
    expectGems: true,
  });
  let m = selectMediaMapModel(s);
  assert.equal(m.positioned.length, 1);
  assert.equal(m.gemZones.length, 1);
  s = mediaMapReducer(s, { type: 'select_cluster', placeId: P1 });
  assert.equal(selectMediaMapModel(s).selected?.placeId, P1);
  s = mediaMapReducer(s, { type: 'toggle_layer', layer: 'gems' });
  m = selectMediaMapModel(s);
  assert.equal(m.gemZones.length, 0);
  assert.equal(m.positioned.length, 1);
});
