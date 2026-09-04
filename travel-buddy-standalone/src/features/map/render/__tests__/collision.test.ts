/**
 * Tests for the §31 collision ladder.
 *
 * The two properties worth stating up front, because most of the file exists to
 * defend them:
 *
 *   1. CONSERVATION. `kept ∪ dropped` is exactly the input, with no duplicates
 *      and nothing invented. §31 hides objects; it must never lose them, or the
 *      "N more" affordance lies about how much is behind the pin.
 *   2. PRECEDENCE. §5: "Safety and active navigation always take visual
 *      precedence over popularity or activity." Tested at the same coordinate,
 *      where the two objects genuinely cannot both be drawn.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HIT_BOX,
  DEMOTED_ZONE_PRIORITY,
  MAX_MERCATOR_LATITUDE,
  TILE_SIZE,
  ZOOM_BANDS,
  circlePolygon,
  compassRecommendationIdsOf,
  confidenceAtLeast,
  confidenceRank,
  explainPriority,
  fromScreen,
  isKindVisibleAtBand,
  kindsVisibleAtBand,
  metresPerPixel,
  participatesInCollision,
  prepareForRender,
  projectToWorld,
  promoteAll,
  promotePriority,
  resolveCollisions,
  toScreen,
  unprojectFromWorld,
  worldSize,
  zoomRenderBand,
} from '../collision.ts';
import type { ScreenViewport } from '../collision.ts';
import {
  MAP_OBJECT_KINDS,
  RENDERING_PRIORITY,
  KIND_DEFAULT_PRIORITY,
  point,
} from '../../../../types/mapObjects.ts';
import type { MapObject, MapObjectKind } from '../../../../types/mapObjects.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VIEWPORT: ScreenViewport = {
  center: { lat: 16.0544, lng: 108.2022 }, // Da Nang
  zoom: 15,
  width: 390,
  height: 844,
};

function obj(over: Partial<MapObject> & { id: string; kind: MapObjectKind }): MapObject {
  return {
    title: over.title ?? `obj-${over.id}`,
    geometry: over.geometry ?? point(VIEWPORT.center.lat, VIEWPORT.center.lng),
    privacyClass: over.privacyClass ?? 'place_level',
    renderingPriority: over.renderingPriority ?? KIND_DEFAULT_PRIORITY[over.kind],
    ...over,
  } as MapObject;
}

/** Offsets a coordinate by a given number of screen points at VIEWPORT.zoom. */
function offsetByPixels(lat: number, lng: number, dx: number, dy: number) {
  const w = projectToWorld(lat, lng, VIEWPORT.zoom);
  return unprojectFromWorld(w.x + dx, w.y + dy, VIEWPORT.zoom);
}

// ── Mercator projection ───────────────────────────────────────────────────────

test('worldSize is TILE_SIZE at zoom 0 and doubles per level', () => {
  assert.equal(worldSize(0), TILE_SIZE);
  assert.equal(worldSize(1), TILE_SIZE * 2);
  assert.equal(worldSize(10), TILE_SIZE * 1024);
});

test('projectToWorld puts 0,0 at the centre of the world square', () => {
  const p = projectToWorld(0, 0, 0);
  assert.ok(Math.abs(p.x - TILE_SIZE / 2) < 1e-9, `x=${p.x}`);
  assert.ok(Math.abs(p.y - TILE_SIZE / 2) < 1e-9, `y=${p.y}`);
});

test('projectToWorld maps the antimeridian and the Mercator pole to the corners', () => {
  const nw = projectToWorld(MAX_MERCATOR_LATITUDE, -180, 0);
  assert.ok(Math.abs(nw.x - 0) < 1e-6, `x=${nw.x}`);
  assert.ok(Math.abs(nw.y - 0) < 1e-6, `y=${nw.y}`);
  const se = projectToWorld(-MAX_MERCATOR_LATITUDE, 180, 0);
  assert.ok(Math.abs(se.x - TILE_SIZE) < 1e-6, `x=${se.x}`);
  assert.ok(Math.abs(se.y - TILE_SIZE) < 1e-6, `y=${se.y}`);
});

test('projectToWorld/unprojectFromWorld round-trip across the globe and zooms', () => {
  const lats = [-84, -60, -33.8688, -0.0001, 0, 16.0544, 35.6762, 51.5072, 84];
  const lngs = [-179.9, -122.4194, -0.1276, 0, 1e-7, 108.2022, 139.6503, 179.9];
  for (const zoom of [0, 3, 11, 15, 19]) {
    for (const lat of lats) {
      for (const lng of lngs) {
        const w = projectToWorld(lat, lng, zoom);
        const back = unprojectFromWorld(w.x, w.y, zoom);
        assert.ok(
          Math.abs(back.lat - lat) < 1e-9,
          `lat ${lat}@z${zoom} -> ${back.lat}`,
        );
        assert.ok(
          Math.abs(back.lng - lng) < 1e-9,
          `lng ${lng}@z${zoom} -> ${back.lng}`,
        );
      }
    }
  }
});

test('latitude is clamped, not wrapped, beyond the Mercator limit', () => {
  const beyond = projectToWorld(89.9, 10, 5);
  const atLimit = projectToWorld(MAX_MERCATOR_LATITUDE, 10, 5);
  assert.equal(beyond.y, atLimit.y);
  // Wrapping would have flipped the hemisphere; clamping keeps it north.
  assert.ok(beyond.y < worldSize(5) / 2);
});

test('toScreen puts the viewport centre at the middle of the screen', () => {
  const s = toScreen(VIEWPORT.center.lat, VIEWPORT.center.lng, VIEWPORT);
  assert.ok(Math.abs(s.x - VIEWPORT.width / 2) < 1e-6);
  assert.ok(Math.abs(s.y - VIEWPORT.height / 2) < 1e-6);
});

test('toScreen/fromScreen round-trip', () => {
  for (const [dx, dy] of [[0, 0], [120, -300], [-180, 420], [5, 5]]) {
    const ll = fromScreen(VIEWPORT.width / 2 + dx, VIEWPORT.height / 2 + dy, VIEWPORT);
    const back = toScreen(ll.lat, ll.lng, VIEWPORT);
    assert.ok(Math.abs(back.x - (VIEWPORT.width / 2 + dx)) < 1e-6);
    assert.ok(Math.abs(back.y - (VIEWPORT.height / 2 + dy)) < 1e-6);
  }
});

test('north is up: a higher latitude has a smaller screen y', () => {
  const north = toScreen(VIEWPORT.center.lat + 0.01, VIEWPORT.center.lng, VIEWPORT);
  const south = toScreen(VIEWPORT.center.lat - 0.01, VIEWPORT.center.lng, VIEWPORT);
  assert.ok(north.y < south.y);
});

test('metresPerPixel halves per zoom level and shrinks toward the poles', () => {
  const eq15 = metresPerPixel(0, 15);
  const eq16 = metresPerPixel(0, 16);
  assert.ok(Math.abs(eq15 / eq16 - 2) < 1e-9);
  assert.ok(metresPerPixel(60, 15) < eq15);
});

test('circlePolygon returns a closed ring that is round on screen', () => {
  const poly = circlePolygon(16.0544, 108.2022, 300, 32);
  assert.equal(poly.type, 'Polygon');
  const ring = poly.coordinates[0];
  assert.equal(ring.length, 33);
  assert.deepEqual(ring[0], ring[ring.length - 1]);

  // Every vertex must land the same screen distance from the centre.
  const c = toScreen(16.0544, 108.2022, VIEWPORT);
  const radii = ring.map(([lng, lat]) => {
    const p = toScreen(lat, lng, VIEWPORT);
    return Math.hypot(p.x - c.x, p.y - c.y);
  });
  const min = Math.min(...radii);
  const max = Math.max(...radii);
  assert.ok(max - min < max * 0.02, `screen radii spread ${min}..${max}`);
});

// ── §17 zoom bands ────────────────────────────────────────────────────────────

test('zoomRenderBand maps §17 zooms to bands and fails closed on NaN', () => {
  assert.equal(zoomRenderBand(0), 'world');
  assert.equal(zoomRenderBand(4.9), 'world');
  assert.equal(zoomRenderBand(5), 'city');
  assert.equal(zoomRenderBand(11.99), 'city');
  assert.equal(zoomRenderBand(12), 'district');
  assert.equal(zoomRenderBand(14.9), 'district');
  assert.equal(zoomRenderBand(15), 'street');
  assert.equal(zoomRenderBand(17.4), 'street');
  assert.equal(zoomRenderBand(17.5), 'venue');
  assert.equal(zoomRenderBand(22), 'venue');
  assert.equal(zoomRenderBand(Number.NaN), 'world');
});

test('§17: no POI pins at world zoom', () => {
  const world = kindsVisibleAtBand('world');
  for (const kind of ['place', 'hidden_gem', 'event', 'social_zone'] as MapObjectKind[]) {
    assert.equal(isKindVisibleAtBand(kind, 'world'), false, `${kind} must be hidden at world`);
    assert.ok(!world.includes(kind));
  }
});

test('§17: individual places appear only from district down', () => {
  assert.equal(isKindVisibleAtBand('place', 'world'), false);
  assert.equal(isKindVisibleAtBand('place', 'city'), false);
  assert.equal(isKindVisibleAtBand('place', 'district'), true);
  assert.equal(isKindVisibleAtBand('place', 'street'), true);
  assert.equal(isKindVisibleAtBand('place', 'venue'), true);
});

test('§5: safety notices are visible at every band, including world', () => {
  for (const band of ZOOM_BANDS) {
    assert.equal(isKindVisibleAtBand('safety_notice', band), true, `band ${band}`);
  }
});

test('band visibility is strictly cumulative as you zoom in', () => {
  for (let i = 1; i < ZOOM_BANDS.length; i += 1) {
    const wider = kindsVisibleAtBand(ZOOM_BANDS[i - 1]);
    const closer = kindsVisibleAtBand(ZOOM_BANDS[i]);
    for (const kind of wider) {
      assert.ok(closer.includes(kind), `${kind} disappeared between ${ZOOM_BANDS[i - 1]} and ${ZOOM_BANDS[i]}`);
    }
  }
});

test('every declared kind is renderable at the venue band', () => {
  const venue = kindsVisibleAtBand('venue');
  for (const kind of MAP_OBJECT_KINDS) {
    assert.ok(venue.includes(kind), `${kind} is renderable nowhere`);
  }
});

// ── Priority promotion ────────────────────────────────────────────────────────

test('confidenceRank orders the bands and returns -1 for absent', () => {
  assert.equal(confidenceRank(undefined), -1);
  assert.ok(confidenceRank('strong') > confidenceRank('live'));
  assert.ok(confidenceRank('live') > confidenceRank('likely_current'));
  assert.equal(confidenceAtLeast('strong', 'live'), true);
  assert.equal(confidenceAtLeast('likely_current', 'live'), false);
  assert.equal(confidenceAtLeast(undefined, 'unverified'), false);
});

test('an unpromoted object keeps its kind default', () => {
  for (const kind of MAP_OBJECT_KINDS) {
    const o = obj({ id: kind, kind, confidence: 'strong', freshness: 'live' });
    assert.equal(promotePriority(o, {}), KIND_DEFAULT_PRIORITY[kind], kind);
  }
});

test('selection, Compass and navigation promote in ladder order', () => {
  const place = obj({ id: 'p1', kind: 'place' });
  assert.equal(promotePriority(place, {}), RENDERING_PRIORITY.relevant_place);
  assert.equal(
    promotePriority(place, { compassRecommendationIds: ['p1'] }),
    RENDERING_PRIORITY.compass_recommendation,
  );
  assert.equal(
    promotePriority(place, { selectedId: 'p1' }),
    RENDERING_PRIORITY.selected_destination,
  );
  assert.equal(
    promotePriority(place, { navigationTargetId: 'p1' }),
    RENDERING_PRIORITY.active_navigation,
  );
  // A Set is accepted as well as an array.
  assert.equal(
    promotePriority(place, { compassRecommendationIds: new Set(['p1']) }),
    RENDERING_PRIORITY.compass_recommendation,
  );
});

test('compassRecommendationIdsOf recovers the rung promoteAll would discard', () => {
  // The producers (compassMapModel.toMapObjects, tripMapModel's Compass
  // alternatives) stamp the rung on the object. explainPriority seeds from the
  // KIND, never from obj.renderingPriority, so promoteAll DROPS it — which is
  // what made the whole Compass rung inert on the map screen.
  const pick = obj({ id: 'p1', kind: 'place' });
  pick.renderingPriority = RENDERING_PRIORITY.compass_recommendation;
  const ordinary = obj({ id: 'p2', kind: 'place' });

  assert.deepEqual(compassRecommendationIdsOf([pick, ordinary]), ['p1']);
  assert.deepEqual(compassRecommendationIdsOf([ordinary]), []);
  assert.deepEqual(compassRecommendationIdsOf([]), []);

  // Without the context the stamp is lost; with it, it survives.
  assert.equal(promoteAll([pick], {})[0].renderingPriority, RENDERING_PRIORITY.relevant_place);
  assert.equal(
    promoteAll([pick], { compassRecommendationIds: compassRecommendationIdsOf([pick]) })[0]
      .renderingPriority,
    RENDERING_PRIORITY.compass_recommendation,
  );
});

test('promotion never lowers: safety outranks even an active navigation target', () => {
  const notice = obj({ id: 's1', kind: 'safety_notice' });
  assert.equal(
    promotePriority(notice, { navigationTargetId: 's1', selectedId: 's1' }),
    RENDERING_PRIORITY.safety,
  );
});

test('a high-confidence live zone keeps its tier while it qualifies', () => {
  const zone = obj({ id: 'z1', kind: 'activity_zone', confidence: 'live', freshness: 'live' });
  assert.equal(promotePriority(zone), RENDERING_PRIORITY.high_confidence_live_zone);
  const confirmed = obj({ id: 'z2', kind: 'activity_zone', confidence: 'strong', freshness: 'recent' });
  assert.equal(promotePriority(confirmed), RENDERING_PRIORITY.high_confidence_live_zone);
});

test('§37: a stale zone loses its tier however confident it was', () => {
  for (const freshness of ['aging', 'stale', 'historical', 'unknown'] as const) {
    const zone = obj({ id: `z-${freshness}`, kind: 'activity_zone', confidence: 'strong', freshness });
    const ex = explainPriority(zone);
    assert.equal(ex.priority, DEMOTED_ZONE_PRIORITY.stale, freshness);
    assert.ok(ex.reasons.includes('stale_freshness'), freshness);
    assert.ok(ex.priority < RENDERING_PRIORITY.high_confidence_live_zone);
  }
  // No freshness at all is the fail-closed case and must demote too.
  const noFreshness = obj({ id: 'z-none', kind: 'activity_zone', confidence: 'strong' });
  assert.equal(promotePriority(noFreshness), DEMOTED_ZONE_PRIORITY.stale);
});

test('§37: an expired zone is demoted even when it still claims to be live', () => {
  const now = Date.parse('2026-08-31T12:00:00Z');
  const zone = obj({
    id: 'z-exp',
    kind: 'activity_zone',
    confidence: 'strong',
    freshness: 'live',
    expiresAt: '2026-08-31T11:59:00Z',
  });
  const ex = explainPriority(zone, { now });
  assert.equal(ex.priority, DEMOTED_ZONE_PRIORITY.stale);
  assert.ok(ex.reasons.includes('expired'));

  // One minute earlier the same object is still current.
  const before = explainPriority(zone, { now: new Date('2026-08-31T11:58:00Z') });
  assert.equal(before.priority, RENDERING_PRIORITY.high_confidence_live_zone);
});

test('a fresh but thinly evidenced zone falls to the uncertain rung, not the stale one', () => {
  for (const confidence of ['unverified', 'provisional', 'likely_current'] as const) {
    const zone = obj({ id: `z-${confidence}`, kind: 'activity_zone', confidence, freshness: 'live' });
    const ex = explainPriority(zone);
    assert.equal(ex.priority, DEMOTED_ZONE_PRIORITY.uncertain, confidence);
    assert.ok(ex.reasons.includes('low_confidence'));
  }
});

test('a user-driven promotion outranks an evidence-driven demotion', () => {
  const stale = obj({ id: 'z9', kind: 'activity_zone', confidence: 'strong', freshness: 'historical' });
  assert.equal(promotePriority(stale), DEMOTED_ZONE_PRIORITY.stale);
  assert.equal(
    promotePriority(stale, { selectedId: 'z9' }),
    RENDERING_PRIORITY.selected_destination,
  );
});

test('demotion applies to every live-zone kind and to no other kind', () => {
  const staleish = { confidence: 'unverified', freshness: 'stale' } as const;
  for (const kind of MAP_OBJECT_KINDS) {
    const o = obj({ id: `k-${kind}`, kind, ...staleish });
    const p = promotePriority(o);
    if (kind === 'activity_zone' || kind === 'crowd_flow' || kind === 'prediction') {
      assert.equal(p, DEMOTED_ZONE_PRIORITY.stale, kind);
    } else {
      assert.equal(p, KIND_DEFAULT_PRIORITY[kind], kind);
    }
  }
});

test('promoteAll does not mutate its inputs and preserves identity when unchanged', () => {
  const a = obj({ id: 'a', kind: 'place' });
  const b = obj({ id: 'b', kind: 'place' });
  const out = promoteAll([a, b], { selectedId: 'a' });
  assert.equal(a.renderingPriority, KIND_DEFAULT_PRIORITY.place, 'input mutated');
  assert.equal(out[0].renderingPriority, RENDERING_PRIORITY.selected_destination);
  assert.equal(out[1], b, 'unchanged objects should not be cloned');
});

// ── Collision resolution ──────────────────────────────────────────────────────

test('§5: a safety notice beats a popular place at the same point', () => {
  const here = point(VIEWPORT.center.lat, VIEWPORT.center.lng);
  const notice = obj({ id: 'safety', kind: 'safety_notice', geometry: here });
  const place = obj({ id: 'hotspot', kind: 'place', geometry: here, activity: 'peak' });

  // Order of the input must not matter.
  for (const input of [[place, notice], [notice, place]]) {
    const r = resolveCollisions(input, { viewport: VIEWPORT });
    assert.deepEqual(r.kept.map((o) => o.id), ['safety']);
    assert.equal(r.dropped.length, 1);
    assert.equal(r.dropped[0].object.id, 'hotspot');
    assert.equal(r.dropped[0].reason, 'collision');
    assert.equal(r.dropped[0].occludedBy, 'safety');
    assert.equal(r.collisionDroppedCount, 1);
  }
});

test('§5: an active navigation target beats a busier place at the same point', () => {
  const here = point(VIEWPORT.center.lat, VIEWPORT.center.lng);
  const target = obj({ id: 'dest', kind: 'place', geometry: here });
  const rival = obj({ id: 'rival', kind: 'event', geometry: here, activity: 'peak' });
  const r = prepareForRender([rival, target], {
    viewport: VIEWPORT,
    promotion: { navigationTargetId: 'dest' },
  });
  assert.deepEqual(r.kept.map((o) => o.id), ['dest']);
  assert.equal(r.dropped[0].object.id, 'rival');
});

test('conservation: kept + dropped is exactly the input, with no duplicates', () => {
  const objects: MapObject[] = [];
  for (let i = 0; i < 60; i += 1) {
    const { lat, lng } = offsetByPixels(
      VIEWPORT.center.lat,
      VIEWPORT.center.lng,
      (i % 8) * 14 - 56,
      Math.floor(i / 8) * 14 - 56,
    );
    objects.push(
      obj({
        id: `o${i}`,
        kind: MAP_OBJECT_KINDS[i % MAP_OBJECT_KINDS.length],
        geometry: point(lat, lng),
        confidence: 'strong',
        freshness: 'live',
      }),
    );
  }
  // Plus objects that fail other gates, so all three drop reasons are present.
  objects.push(obj({ id: 'blank', kind: 'place', title: '   ' }));
  objects.push(obj({ id: 'hidden', kind: 'place', privacyClass: 'none' }));

  const r = resolveCollisions(objects, { viewport: { ...VIEWPORT, zoom: 6 } });

  const ids = [...r.kept.map((o) => o.id), ...r.dropped.map((d) => d.object.id)];
  assert.equal(ids.length, objects.length, 'object lost or duplicated');
  assert.equal(new Set(ids).size, objects.length, 'duplicate ids across kept/dropped');
  assert.deepEqual(new Set(ids), new Set(objects.map((o) => o.id)));
  assert.equal(r.droppedCount, r.dropped.length);
  assert.ok(r.dropped.some((d) => d.reason === 'not_renderable'));
  assert.ok(r.dropped.some((d) => d.reason === 'zoom_band'));
  assert.ok(r.dropped.some((d) => d.reason === 'collision'));
});

test('the dropped set is never truncated even when everything collides', () => {
  const here = point(VIEWPORT.center.lat, VIEWPORT.center.lng);
  const objects = Array.from({ length: 250 }, (_, i) =>
    obj({ id: `p${i}`, kind: 'place', geometry: here }),
  );
  const r = resolveCollisions(objects, { viewport: VIEWPORT });
  assert.equal(r.kept.length, 1);
  assert.equal(r.droppedCount, 249);
  assert.equal(r.collisionDroppedCount, 249);
});

test('resolution is deterministic under input shuffling', () => {
  const base = Array.from({ length: 30 }, (_, i) => {
    const { lat, lng } = offsetByPixels(VIEWPORT.center.lat, VIEWPORT.center.lng, (i % 6) * 18, Math.floor(i / 6) * 18);
    return obj({ id: `d${i}`, kind: 'place', geometry: point(lat, lng) });
  });
  const expected = resolveCollisions(base, { viewport: VIEWPORT }).kept.map((o) => o.id);
  for (let seed = 0; seed < 5; seed += 1) {
    const shuffled = [...base].sort(() => (Math.sin(seed * 97 + 13) > 0 ? 1 : -1)).reverse();
    const got = resolveCollisions(shuffled, { viewport: VIEWPORT }).kept.map((o) => o.id);
    assert.deepEqual(got, expected);
  }
});

test('objects further apart than the hit box + padding both survive', () => {
  const gap = DEFAULT_HIT_BOX.width + 2 * 4 + 1;
  const a = point(VIEWPORT.center.lat, VIEWPORT.center.lng);
  const shifted = offsetByPixels(VIEWPORT.center.lat, VIEWPORT.center.lng, gap, 0);
  const r = resolveCollisions(
    [obj({ id: 'a', kind: 'place', geometry: a }), obj({ id: 'b', kind: 'place', geometry: point(shifted.lat, shifted.lng) })],
    { viewport: VIEWPORT },
  );
  assert.equal(r.kept.length, 2);
  assert.equal(r.droppedCount, 0);
});

test('zooming in separates two objects that collided at a wider zoom', () => {
  const a = point(VIEWPORT.center.lat, VIEWPORT.center.lng);
  const near = offsetByPixels(VIEWPORT.center.lat, VIEWPORT.center.lng, 20, 0);
  const pair = [
    obj({ id: 'a', kind: 'place', geometry: a }),
    obj({ id: 'b', kind: 'place', geometry: point(near.lat, near.lng) }),
  ];
  assert.equal(resolveCollisions(pair, { viewport: VIEWPORT }).kept.length, 1);
  assert.equal(
    resolveCollisions(pair, { viewport: { ...VIEWPORT, zoom: VIEWPORT.zoom + 2 } }).kept.length,
    2,
  );
});

test('area geometry never collides — a zone under a pin is the design, not a clash', () => {
  const centre = { lat: VIEWPORT.center.lat, lng: VIEWPORT.center.lng };
  const zone = obj({
    id: 'zone',
    kind: 'activity_zone',
    geometry: circlePolygon(centre.lat, centre.lng, 400),
    confidence: 'strong',
    freshness: 'live',
  });
  const flow = obj({
    id: 'flow',
    kind: 'crowd_flow',
    geometry: {
      type: 'LineString',
      coordinates: [[centre.lng, centre.lat], [centre.lng + 0.004, centre.lat + 0.004]],
    },
    confidence: 'strong',
    freshness: 'live',
  });
  const pin = obj({ id: 'pin', kind: 'place', geometry: point(centre.lat, centre.lng) });

  assert.equal(participatesInCollision(zone), false);
  assert.equal(participatesInCollision(flow), false);
  assert.equal(participatesInCollision(pin), true);

  const r = resolveCollisions([zone, flow, pin], { viewport: VIEWPORT });
  assert.equal(r.kept.length, 3);
  assert.equal(r.droppedCount, 0);
});

test('zoom-band gating drops out-of-band kinds with their own reason', () => {
  const world: ScreenViewport = { ...VIEWPORT, zoom: 3 };
  const objects = [
    obj({ id: 'place', kind: 'place' }),
    obj({ id: 'gem', kind: 'hidden_gem' }),
    obj({ id: 'trip', kind: 'trip_stop' }),
  ];
  const r = resolveCollisions(objects, { viewport: world });
  assert.equal(r.band, 'world');
  assert.deepEqual(r.kept.map((o) => o.id), ['trip']);
  const reasons = Object.fromEntries(r.dropped.map((d) => [d.object.id, d.reason]));
  assert.equal(reasons.place, 'zoom_band');
  assert.equal(reasons.gem, 'zoom_band');
});

test('zoom-band gating can be turned off for an explicitly enabled layer', () => {
  const r = resolveCollisions([obj({ id: 'place', kind: 'place' })], {
    viewport: { ...VIEWPORT, zoom: 3 },
    applyZoomBands: false,
  });
  assert.deepEqual(r.kept.map((o) => o.id), ['place']);
});

test('an explicit band overrides the one derived from zoom', () => {
  const r = resolveCollisions([obj({ id: 'place', kind: 'place' })], {
    viewport: { ...VIEWPORT, zoom: 3 },
    band: 'district',
  });
  assert.equal(r.band, 'district');
  assert.equal(r.kept.length, 1);
});

test('unrenderable objects are dropped with reason, never rendered as anonymous dots', () => {
  const objects = [
    obj({ id: 'no-title', kind: 'place', title: '' }),
    obj({ id: 'private', kind: 'crew_member', privacyClass: 'none' }),
    obj({ id: 'bad-geom', kind: 'place', geometry: { type: 'Point', coordinates: [Number.NaN, 1] } }),
    obj({ id: 'good', kind: 'place' }),
  ];
  const r = resolveCollisions(objects, { viewport: { ...VIEWPORT, zoom: 18 } });
  assert.deepEqual(r.kept.map((o) => o.id), ['good']);
  assert.equal(r.dropped.filter((d) => d.reason === 'not_renderable').length, 3);
});

test('a custom hit box changes what collides', () => {
  const shifted = offsetByPixels(VIEWPORT.center.lat, VIEWPORT.center.lng, 30, 0);
  const pair = [
    obj({ id: 'a', kind: 'place' }),
    obj({ id: 'b', kind: 'place', geometry: point(shifted.lat, shifted.lng) }),
  ];
  assert.equal(resolveCollisions(pair, { viewport: VIEWPORT }).kept.length, 1);
  assert.equal(
    resolveCollisions(pair, {
      viewport: VIEWPORT,
      hitBoxFor: () => ({ width: 16, height: 16 }),
      padding: 0,
    }).kept.length,
    2,
  );
});

test('alwaysKeepKinds exempts a kind from collision entirely', () => {
  const here = point(VIEWPORT.center.lat, VIEWPORT.center.lng);
  const objects = [
    obj({ id: 'crew1', kind: 'crew_member', geometry: here, privacyClass: 'approximate' }),
    obj({ id: 'crew2', kind: 'crew_member', geometry: here, privacyClass: 'approximate' }),
  ];
  assert.equal(resolveCollisions(objects, { viewport: { ...VIEWPORT, zoom: 18 } }).kept.length, 1);
  assert.equal(
    resolveCollisions(objects, {
      viewport: { ...VIEWPORT, zoom: 18 },
      alwaysKeepKinds: ['crew_member'],
    }).kept.length,
    2,
  );
});

test('prepareForRender applies the ladder before judging collisions', () => {
  const here = point(VIEWPORT.center.lat, VIEWPORT.center.lng);
  // A generic memory pin would normally lose to a place; Compass promotes it.
  const memory = obj({ id: 'mem', kind: 'memory', geometry: here });
  const place = obj({ id: 'plc', kind: 'place', geometry: here });
  const naive = resolveCollisions([memory, place], { viewport: VIEWPORT });
  assert.deepEqual(naive.kept.map((o) => o.id), ['plc']);

  const promoted = prepareForRender([memory, place], {
    viewport: VIEWPORT,
    promotion: { compassRecommendationIds: ['mem'] },
  });
  assert.deepEqual(promoted.kept.map((o) => o.id), ['mem']);
});

test('kept is ordered highest priority first, matching compareByRenderingPriority', () => {
  const spread = [0, 60, 120, 180].map((dx, i) => {
    const p = offsetByPixels(VIEWPORT.center.lat, VIEWPORT.center.lng, dx, 0);
    return obj({
      id: ['poi', 'place', 'crew', 'safety'][i],
      kind: (['memory', 'place', 'crew_member', 'safety_notice'] as MapObjectKind[])[i],
      geometry: point(p.lat, p.lng),
      privacyClass: 'approximate',
    });
  });
  const r = resolveCollisions(spread, { viewport: { ...VIEWPORT, zoom: 18 } });
  assert.deepEqual(r.kept.map((o) => o.id), ['safety', 'crew', 'place', 'poi']);
  const priorities = r.kept.map((o) => o.renderingPriority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
});

test('an empty input yields an empty, well-formed result', () => {
  const r = resolveCollisions([], { viewport: VIEWPORT });
  assert.deepEqual(r.kept, []);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.droppedCount, 0);
  assert.equal(r.collisionDroppedCount, 0);
  assert.equal(r.band, 'street');
});
