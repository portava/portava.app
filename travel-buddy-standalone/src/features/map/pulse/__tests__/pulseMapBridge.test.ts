/**
 * Pulse ⇄ Map bridge guards (spec §26).
 *
 * The property these tests exist for: "map states should never contradict Pulse
 * because of separately implemented truth logic." `assertNoContradiction` is
 * the mechanism, so the suite proves it catches a real divergence rather than
 * merely existing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAP_LAYERS,
  MAP_CAMERA_STATES,
  MAP_LAYERS,
  MAP_MODES,
  MapPulseContradictionError,
  assertNoContradiction,
  boundsOfPoints,
  cameraPointForObject,
  centerOfBounds,
  entityIdOfMapObject,
  findContradictions,
  mapObjectIdFor,
  mapStateToPulseQuery,
  normaliseLayers,
  padBounds,
  pulseItemToMapState,
  reconcileOrDrop,
} from '../pulseMapBridge.ts';
import type { PulseIntelItem } from '../pulseMapBridge.ts';
import type { LivePulseItem, LivePulseItemType } from '../../../../services/livePulse.ts';
import type { MapObject } from '../../../../types/mapObjects.ts';
import { point } from '../../../../types/mapObjects.ts';

function pulseItem(over: Partial<PulseIntelItem> = {}): PulseIntelItem {
  return {
    id: 'card-1',
    item_type: 'event',
    item_id: 'evt-42',
    status_label: 'Starting Soon',
    title: 'Rooftop set',
    subtitle: null,
    city: 'Da Nang',
    starts_at: null,
    ends_at: null,
    people_count: null,
    user_relationship: null,
    primary_action: null,
    secondary_action: null,
    reason_labels: [],
    expires_at: null,
    is_joinable: true,
    ...over,
  };
}

function mapObject(over: Partial<MapObject> = {}): MapObject {
  return {
    id: 'event:evt-42',
    kind: 'event',
    geometry: point(16.06, 108.22),
    title: 'Rooftop set',
    privacyClass: 'place_level',
    renderingPriority: 60,
    ...over,
  };
}

// ── The §26 guarantee ──────────────────────────────────────────────────────────

test('agreeing surfaces pass', () => {
  const item = pulseItem({ activity: 'busy', trend: 'getting_busier', confidence: 'live', freshness: 'live' });
  const obj = mapObject({ activity: 'busy', trend: 'getting_busier', confidence: 'live', freshness: 'live' });
  assert.doesNotThrow(() => assertNoContradiction(item, obj));
  assert.deepEqual(findContradictions(item, obj), []);
});

test('a real divergence is caught and named', () => {
  const item = pulseItem({ activity: 'very_busy', confidence: 'strong' });
  const obj = mapObject({ activity: 'quiet', confidence: 'provisional' });

  assert.throws(
    () => assertNoContradiction(item, obj),
    (err: unknown) => {
      assert.ok(err instanceof MapPulseContradictionError);
      assert.equal(err.subjectId, 'evt-42');
      assert.deepEqual(
        err.divergences.map((d) => d.axis).sort(),
        ['activity', 'confidence'],
      );
      assert.match(err.message, /activity: pulse=very_busy map=quiet/);
      return true;
    },
  );
});

test('a freshness divergence alone is enough to fail', () => {
  const item = pulseItem({ freshness: 'live' });
  const obj = mapObject({ freshness: 'stale' });
  assert.throws(() => assertNoContradiction(item, obj), MapPulseContradictionError);
});

test('silence on an axis is not a contradiction', () => {
  const item = pulseItem({ activity: 'busy' });
  const obj = mapObject({ confidence: 'strong' }); // no activity stated
  assert.doesNotThrow(() => assertNoContradiction(item, obj));
});

test('a subject mismatch is itself a §26 failure, not a silent pass', () => {
  const item = pulseItem({ item_id: 'evt-42', activity: 'busy' });
  const obj = mapObject({ id: 'event:evt-99', activity: 'busy' });
  const divergences = findContradictions(item, obj);
  assert.deepEqual(divergences, [{ axis: 'subject', pulse: 'evt-42', map: 'evt-99' }]);
  assert.throws(() => assertNoContradiction(item, obj), MapPulseContradictionError);
});

test('reconcileOrDrop reports instead of throwing, and drops on divergence', () => {
  const ok = reconcileOrDrop(pulseItem({ activity: 'busy' }), mapObject({ activity: 'busy' }));
  assert.equal(ok.ok, true);

  const bad = reconcileOrDrop(pulseItem({ activity: 'busy' }), mapObject({ activity: 'peak' }));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.divergences[0].axis, 'activity');
});

test('entityIdOfMapObject prefers an explicit sourceId over the id prefix', () => {
  assert.equal(entityIdOfMapObject(mapObject()), 'evt-42');
  assert.equal(entityIdOfMapObject(mapObject({ id: 'bare-id' })), 'bare-id');
  assert.equal(
    entityIdOfMapObject(mapObject({ id: 'event:wrong', payload: { sourceId: 'right' } })),
    'right',
  );
});

// ── Deep-link, forward ─────────────────────────────────────────────────────────

test('every Pulse item type deep-links into a valid map state', () => {
  const types: LivePulseItemType[] = [
    'event',
    'trip',
    'trip_request',
    'buddy_request',
    'available_buddy',
    'hidden_gem',
    'compass',
    'circle',
    'safe_return',
  ];
  for (const item_type of types) {
    const state = pulseItemToMapState(pulseItem({ item_type }));
    assert.ok(MAP_MODES.includes(state.mode), `${item_type} → bad mode`);
    assert.ok(MAP_CAMERA_STATES.includes(state.cameraTarget.state), `${item_type} → bad camera`);
    for (const l of state.layers) assert.ok(MAP_LAYERS.includes(l));
    assert.equal(state.cameraTarget.subject.id, 'evt-42');
  }
});

test('an unknown Pulse type falls back to LIVE rather than throwing', () => {
  const state = pulseItemToMapState(
    pulseItem({ item_type: 'brand_new_type' as LivePulseItemType }),
  );
  assert.equal(state.mode, 'LIVE');
  assert.deepEqual(state.layers, normaliseLayers([...DEFAULT_MAP_LAYERS]));
});

test('an event deep-links to a selected place at a point camera', () => {
  const state = pulseItemToMapState(pulseItem(), { center: { lat: 16.06, lng: 108.22 } });
  assert.equal(state.mode, 'PLACE_SELECTED');
  assert.equal(state.cameraTarget.state, 'FOCUS_PLACE');
  assert.deepEqual(state.cameraTarget.center, { lat: 16.06, lng: 108.22 });
  assert.equal(state.cameraTarget.bounds, null);
  assert.equal(state.selectedObjectId, mapObjectIdFor('event', 'evt-42'));
});

test('a multi-point subject frames its bounds instead of centring on one stop', () => {
  const state = pulseItemToMapState(pulseItem({ item_type: 'trip', item_id: 'trip-9' }), {
    points: [
      { lat: 16.0, lng: 108.0 },
      { lat: 16.2, lng: 108.4 },
    ],
  });
  assert.equal(state.mode, 'TRIP');
  assert.equal(state.cameraTarget.state, 'FOCUS_TRIP');
  assert.deepEqual(state.cameraTarget.bounds, { south: 16.0, west: 108.0, north: 16.2, east: 108.4 });
  assert.equal(state.cameraTarget.zoom, null, 'a framed target has no fixed zoom');
  assert.deepEqual(state.cameraTarget.center, { lat: 16.1, lng: 108.2 });
});

test('a Pulse item with no resolved geography enters the mode without moving the camera', () => {
  const state = pulseItemToMapState(pulseItem({ item_type: 'compass' }));
  assert.equal(state.mode, 'COMPASS');
  assert.equal(state.cameraTarget.center, null);
  assert.equal(state.cameraTarget.bounds, null);
});

test('safe_return lands on the safety layer', () => {
  const state = pulseItemToMapState(pulseItem({ item_type: 'safe_return' }));
  assert.ok(state.layers.includes('safety'));
  assert.equal(state.cameraTarget.state, 'FOCUS_ROUTE');
});

test('layers come back de-duplicated in the canonical §16 order', () => {
  assert.deepEqual(normaliseLayers(['saved', 'events', 'events', 'live_activity']), [
    'live_activity',
    'events',
    'saved',
  ]);
});

// ── Deep-link, reverse ─────────────────────────────────────────────────────────

test('a trip focus asks Pulse for that specific trip', () => {
  const state = pulseItemToMapState(pulseItem({ item_type: 'trip', item_id: 'trip-9' }), {
    center: { lat: 16.06, lng: 108.22 },
  });
  const q = mapStateToPulseQuery(state);
  assert.equal(q.context, 'specificTrip');
  assert.equal(q.focusItemId, 'trip-9');
  assert.ok(q.itemTypes.includes('trip'));
});

test('a user-following camera asks Pulse for nearMe with coordinates', () => {
  const q = mapStateToPulseQuery({
    mode: 'LIVE',
    cameraTarget: {
      state: 'FOLLOW_USER',
      center: { lat: 16.06, lng: 108.22 },
      bounds: null,
      zoom: 15,
      subject: { kind: null, id: null },
    },
    selectedObjectId: null,
    layers: ['live_activity'],
  });
  assert.equal(q.context, 'nearMe');
  assert.equal(q.lat, 16.06);
  assert.equal(q.lng, 108.22);
});

test('a placeless map state falls back to city, then to my plans', () => {
  const base = {
    mode: 'LIVE' as const,
    cameraTarget: {
      state: 'FREE_EXPLORE' as const,
      center: null,
      bounds: null,
      zoom: null,
      subject: { kind: null, id: null },
    },
    selectedObjectId: null,
    layers: [],
  };
  assert.equal(mapStateToPulseQuery(base, { citySlug: 'da-nang' }).context, 'currentCity');
  assert.equal(mapStateToPulseQuery(base).context, 'myPlans');
});

test('Locate My Friends asks for the crew-shaped Pulse items', () => {
  const state = pulseItemToMapState(pulseItem({ item_type: 'circle', item_id: 'circle-3' }));
  const q = mapStateToPulseQuery(state);
  assert.equal(q.context, 'nearMe');
  assert.deepEqual(q.itemTypes, ['circle', 'available_buddy', 'buddy_request', 'safe_return']);
});

test('the round trip preserves the subject', () => {
  const item = pulseItem({ item_type: 'hidden_gem', item_id: 'gem-7' });
  const q = mapStateToPulseQuery(pulseItemToMapState(item, { center: { lat: 1, lng: 2 } }));
  assert.equal(q.focusItemId, 'gem-7');
  assert.ok(q.itemTypes.includes('hidden_gem'));
});

// ── Geometry helpers ───────────────────────────────────────────────────────────

test('boundsOfPoints ignores unusable points and returns null when none remain', () => {
  assert.equal(boundsOfPoints([]), null);
  assert.equal(boundsOfPoints([{ lat: Number.NaN, lng: 1 }]), null);
  assert.deepEqual(
    boundsOfPoints([
      { lat: 1, lng: 2 },
      { lat: Number.NaN, lng: 9 },
      { lat: 3, lng: 4 },
    ]),
    { south: 1, west: 2, north: 3, east: 4 },
  );
});

test('padBounds only ever grows the box', () => {
  const b = { south: 0, west: 0, north: 2, east: 2 };
  const p = padBounds(b, 0.1);
  assert.ok(p.south < b.south && p.west < b.west && p.north > b.north && p.east > b.east);
  assert.deepEqual(centerOfBounds(p), centerOfBounds(b));
});

test('cameraPointForObject returns the object centroid', () => {
  assert.deepEqual(cameraPointForObject(mapObject()), { lat: 16.06, lng: 108.22 });
});

test('the LivePulseItem contract is what the bridge consumes', () => {
  // Compile-time assertion that PulseIntelItem widens the real service type.
  const raw: LivePulseItem = pulseItem();
  const widened: PulseIntelItem = raw;
  assert.equal(widened.item_id, 'evt-42');
});
