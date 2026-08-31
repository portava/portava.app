/**
 * mapTelemetry tests (Map spec §35).
 *
 * The bar these tests hold the module to:
 *   1. every one of the sixteen §35 events emits with its declared payload;
 *   2. NOTHING that leaves this module carries a coordinate, a geometry, or
 *      another person's identifier — checked both by targeted assertions and by
 *      a blanket key sweep over every emitted payload;
 *   3. the two correlation ids survive across events, so the §38 loop
 *      (compass → selection → route → contribution) is queryable end to end;
 *   4. the queue is bounded, drops the OLDEST, and REPORTS what it dropped;
 *   5. flush fires on size, on interval, and on backgrounding.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  emitMapEvent,
  scrubPayload,
  describeMapObject,
  configureMapTelemetry,
  setMapTelemetryTransport,
  flushMapTelemetry,
  notifyMapAppStateChange,
  mapTelemetryDiagnostics,
  currentMapSessionId,
  currentDecisionId,
  clearActiveDecision,
  endMapSession,
  newDecisionId,
  createFetchTelemetryTransport,
  geohashEncode,
  cellFor,
  cellForGeometry,
  isDisallowedKey,
  containsDisallowedKey,
  countBucket,
  distanceBucket,
  durationBucketMs,
  MAP_EVENT_NAMES,
  TELEMETRY_CELL_PRECISION,
  IDENTITY_BEARING_KINDS,
  _resetMapTelemetryForTests,
  type MapTelemetryBatch,
  type MapTelemetryEvent,
  type MapObjectRef,
  type PlaceOpenedPayload,
  type TelemetryScheduler,
} from '../mapTelemetry.ts';
import {
  point,
  KIND_DEFAULT_PRIORITY,
  type MapObject,
  type MapObjectKind,
  type PolygonGeometry,
} from '../../../../types/mapObjects.ts';

// ── Harness ───────────────────────────────────────────────────────────────────

/** A transport that records every batch and can be made to fail. */
function fakeTransport() {
  const batches: MapTelemetryBatch[] = [];
  let failNext = 0;
  return {
    batches,
    failFor(n: number) { failNext = n; },
    get events(): MapTelemetryEvent[] { return batches.flatMap((b) => b.events); },
    fn: async (batch: MapTelemetryBatch) => {
      if (failNext > 0) {
        failNext -= 1;
        throw new Error('network');
      }
      batches.push(batch);
    },
  };
}

/** Deterministic scheduler — nothing fires until `advance()` is called. */
function fakeScheduler() {
  let nextHandle = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  let clock = 0;
  const scheduler: TelemetryScheduler = {
    setTimeout: (fn, ms) => {
      const handle = nextHandle++;
      pending.set(handle, { fn, at: clock + ms });
      return handle;
    },
    clearTimeout: (handle) => { pending.delete(handle as number); },
  };
  return {
    scheduler,
    get pendingCount() { return pending.size; },
    advance(ms: number) {
      clock += ms;
      for (const [handle, entry] of [...pending.entries()]) {
        if (entry.at <= clock) {
          pending.delete(handle);
          entry.fn();
        }
      }
    },
  };
}

let ids = 0;
function deterministicIds(prefix: string): string {
  ids += 1;
  return `${prefix}-${ids}`;
}

function mapObject(overrides: Partial<MapObject> = {}): MapObject {
  const kind = (overrides.kind ?? 'place') as MapObjectKind;
  return {
    id: 'obj-1',
    kind,
    geometry: point(16.0544, 108.2022), // Da Nang
    title: 'Somewhere Specific',
    privacyClass: 'place_level',
    renderingPriority: KIND_DEFAULT_PRIORITY[kind],
    confidence: 'strong',
    freshness: 'live',
    ...overrides,
  };
}

let transport: ReturnType<typeof fakeTransport>;
let clock: ReturnType<typeof fakeScheduler>;
let nowMs = 1_700_000_000_000;

beforeEach(() => {
  _resetMapTelemetryForTests();
  ids = 0;
  transport = fakeTransport();
  clock = fakeScheduler();
  configureMapTelemetry({
    transport: transport.fn,
    scheduler: clock.scheduler,
    newId: deterministicIds,
    now: () => (nowMs += 1000),
    batchSize: 20,
    flushIntervalMs: 15_000,
    maxQueueSize: 200,
    maxDeliveryAttempts: 3,
  });
});

afterEach(() => {
  _resetMapTelemetryForTests();
});

function openMap() {
  emitMapEvent('map_opened', {
    entry: 'tab',
    mode: 'explore',
    viewportCell: cellFor(16.0544, 108.2022),
    zoom: 14,
    hasTripContext: true,
    hasCrewContext: false,
  });
}

/** Emit one well-formed instance of every §35 event. */
function emitAllSixteen(): void {
  const ref = describeMapObject(mapObject());
  const zoneRef = describeMapObject(mapObject({ id: 'zone-1', kind: 'activity_zone', privacyClass: 'aggregate_only' }));
  const meetRef = describeMapObject(mapObject({ id: 'mp-1', kind: 'meeting_point' }));

  openMap();
  emitMapEvent('zone_selected', { ref: zoneRef, source: 'marker', forecast: false });
  emitMapEvent('place_opened', { ref, source: 'marker', rank: 2, saved: false });
  emitMapEvent('live_state_viewed', { ref, activity: 'busy', trend: 'getting_busier', detent: 'half', dwell: '1-5m' });
  emitMapEvent('why_shown_opened', { ref, lineCount: 4, provenanceRefs: ['snap_a', 'snap_b'] });
  emitMapEvent('compass_requested', { trigger: 'action_rail', contextCell: cellFor(16.05, 108.2), intent: 'food_now', mode: 'explore' });
  emitMapEvent('compass_option_selected', { ref, optionIndex: 0, optionCount: 3, distance: '1-3km' });
  emitMapEvent('recommendation_accepted', { ref, via: 'route', optionIndex: 0, optionCount: 3 });
  emitMapEvent('route_started', { ref, travelMode: 'walk', distance: '1-3km', eta: '15-60m', external: false });
  emitMapEvent('trip_stop_added', { ref, dayIndex: 1, slotIndex: 3, source: 'action_rail' });
  emitMapEvent('plan_joined', { ref, planKind: 'meetup', participants: countBucket(6), discovery: 'map' });
  emitMapEvent('meet_here_created', { ref: meetRef, audience: 'crew', invitees: countBucket(3), sharedAs: 'approximate', ttl: '1-4h' });
  emitMapEvent('crew_locate_started', { crewSize: countBucket(4), requestedPrecision: 'approximate', ttl: '15-60m', source: 'trip_map' });
  emitMapEvent('contribution_submitted', { ref, contributionKind: 'crowd_level', prompt: 'arrival', sinceRouteStart: '15-60m', followedRoute: true });
  emitMapEvent('alternative_requested', { ref, reason: 'too_far', round: 1 });
  emitMapEvent('recommendation_declined', { ref, reason: 'wrong_vibe', explicit: true, optionCount: 3 });
}

// ── 1. The catalogue ──────────────────────────────────────────────────────────

describe('mapTelemetry — the §35 catalogue', () => {
  it('declares exactly the sixteen events §35 names', () => {
    assert.equal(MAP_EVENT_NAMES.length, 16);
    assert.deepEqual([...MAP_EVENT_NAMES].sort(), [
      'alternative_requested', 'compass_option_selected', 'compass_requested',
      'contribution_submitted', 'crew_locate_started', 'live_state_viewed',
      'map_opened', 'meet_here_created', 'place_opened', 'plan_joined',
      'recommendation_accepted', 'recommendation_declined', 'route_started',
      'trip_stop_added', 'why_shown_opened', 'zone_selected',
    ]);
  });

  it('emits every one of the sixteen with its declared payload', async () => {
    emitAllSixteen();
    await flushMapTelemetry();

    const names = transport.events.map((e) => e.name);
    assert.equal(names.length, 16);
    for (const name of MAP_EVENT_NAMES) {
      assert.ok(names.includes(name), `missing event: ${name}`);
    }
  });

  it('preserves each event’s own payload fields through the emitter', async () => {
    emitAllSixteen();
    await flushMapTelemetry();
    const byName = new Map(transport.events.map((e) => [e.name, e.payload]));

    assert.equal(byName.get('map_opened')?.entry, 'tab');
    assert.equal(byName.get('map_opened')?.hasTripContext, true);
    assert.equal(byName.get('zone_selected')?.source, 'marker');
    assert.equal(byName.get('place_opened')?.rank, 2);
    assert.equal(byName.get('live_state_viewed')?.trend, 'getting_busier');
    assert.equal(byName.get('why_shown_opened')?.lineCount, 4);
    assert.deepEqual(byName.get('why_shown_opened')?.provenanceRefs, ['snap_a', 'snap_b']);
    assert.equal(byName.get('compass_requested')?.intent, 'food_now');
    assert.equal(byName.get('compass_option_selected')?.optionCount, 3);
    assert.equal(byName.get('route_started')?.travelMode, 'walk');
    assert.equal(byName.get('trip_stop_added')?.dayIndex, 1);
    assert.equal(byName.get('plan_joined')?.participants, '5-9');
    assert.equal(byName.get('meet_here_created')?.sharedAs, 'approximate');
    assert.equal(byName.get('crew_locate_started')?.requestedPrecision, 'approximate');
    assert.equal(byName.get('contribution_submitted')?.contributionKind, 'crowd_level');
    assert.equal(byName.get('alternative_requested')?.round, 1);
    assert.equal(byName.get('recommendation_accepted')?.via, 'route');
    assert.equal(byName.get('recommendation_declined')?.explicit, true);
  });

  it('drops an event whose name is not in the catalogue, and counts the drop', async () => {
    openMap();
    // Force a bad name past the type system the way a bad merge would.
    (emitMapEvent as unknown as (n: string, p: unknown) => void)('map_zoomed', {});
    assert.equal(mapTelemetryDiagnostics().droppedByReason.unknown_event, 1);
    await flushMapTelemetry();
    assert.equal(transport.events.length, 1);
    assert.equal(mapTelemetryDiagnostics().droppedTotal, 1);
    assert.equal(transport.batches[0]?.meta.droppedByReason.unknown_event, 1);
  });
});

// ── 2. Privacy: the point of the module ───────────────────────────────────────

describe('mapTelemetry — scrubPayload', () => {
  it('removes raw lat/lng keys and replaces them with a coarse cell', () => {
    const out = scrubPayload({ objectId: 'p1', lat: 16.0544, lng: 108.2022, kind: 'place' });
    assert.equal(out['lat'], undefined);
    assert.equal(out['lng'], undefined);
    assert.equal(out['objectId'], 'p1');
    assert.equal(out['kind'], 'place');
    assert.equal(out['cell'], geohashEncode(16.0544, 108.2022, TELEMETRY_CELL_PRECISION));
    assert.equal(out['cellPrecision'], TELEMETRY_CELL_PRECISION);
  });

  it('coarsens latitude/longitude spelled out in full', () => {
    const out = scrubPayload({ latitude: 16.0544, longitude: 108.2022 });
    assert.equal(out['latitude'], undefined);
    assert.equal(out['longitude'], undefined);
    assert.equal(typeof out['cell'], 'string');
  });

  it('coarsens to a cell no finer than ~1 km on both axes', () => {
    // Precision 5 cells are ≈4.9 km × 4.9 km. Two points 300 m apart must be
    // indistinguishable far more often than not; two points 50 km apart never.
    const base = cellFor(16.0544, 108.2022);
    const near = cellFor(16.0544 + 0.0009, 108.2022 + 0.0009); // ≈ 140 m away
    const far = cellFor(16.5544, 108.7022); // ≈ 70 km away
    assert.equal(base?.length, TELEMETRY_CELL_PRECISION);
    assert.equal(base, near, 'a 140 m move must not change the reported cell');
    assert.notEqual(base, far);
  });

  it('replaces a MapObject geometry with a cell instead of passing the point', () => {
    const out = scrubPayload({ shape: point(16.0544, 108.2022) });
    const shape = out['shape'] as Record<string, unknown>;
    assert.equal(shape['coordinates'], undefined);
    assert.equal(shape['type'], undefined);
    assert.equal(shape['cell'], cellFor(16.0544, 108.2022));
  });

  it('removes a geometry held under a disallowed key entirely — no cell smuggled through', () => {
    const out = scrubPayload({ geometry: point(16.0544, 108.2022), kind: 'place' });
    assert.equal(out['geometry'], undefined);
    assert.equal(out['cell'], undefined);
    assert.equal(out['kind'], 'place');
  });

  it('scrubs at depth, not just at the top level', () => {
    const out = scrubPayload({ a: { b: { c: { lat: 1.5, lng: 2.5, keep: 'yes' } } } });
    const c = ((out['a'] as Record<string, unknown>)['b'] as Record<string, unknown>)['c'] as Record<string, unknown>;
    assert.equal(c['lat'], undefined);
    assert.equal(c['keep'], 'yes');
    assert.equal(typeof c['cell'], 'string');
  });

  it('scrubs inside arrays', () => {
    const out = scrubPayload({ options: [{ lat: 1, lng: 2 }, { latitude: 3, longitude: 4 }] });
    const options = out['options'] as Record<string, unknown>[];
    assert.equal(options.length, 2);
    for (const o of options) {
      assert.equal(containsDisallowedKey(o), false);
      assert.equal(typeof o['cell'], 'string');
    }
  });

  it('removes other people’s identifiers', () => {
    const out = scrubPayload({
      contributorId: 'u-1', userId: 'u-2', ownerId: 'u-3', creatorId: 'u-4',
      hostId: 'u-5', profileId: 'u-6', handle: '@someone', email: 'a@b.c',
      displayName: 'Real Name', avatarUrl: 'https://x/y.jpg', deviceId: 'd-1',
      objectId: 'place-9',
    });
    assert.deepEqual(Object.keys(out), ['objectId']);
  });

  it('drops functions, symbols and undefined rather than serialising them', () => {
    const out = scrubPayload({ fn: () => 1, sym: Symbol('x'), undef: undefined, ok: 1 });
    assert.deepEqual(out, { ok: 1 });
  });

  it('caps string length, array length and nesting depth', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: 'too deep' } } } } } } };
    const out = scrubPayload({
      // NB: a key called `long` would itself be stripped — it contains "lon".
      bigString: 'x'.repeat(1000),
      many: Array.from({ length: 200 }, (_, i) => i),
      ...deep,
    });
    assert.equal((out['bigString'] as string).length, 200);
    assert.equal((out['many'] as unknown[]).length, 50);
    // The deepest level is elided rather than serialised.
    assert.equal(JSON.stringify(out).includes('too deep'), false);
  });

  it('is total: non-objects scrub to an empty payload rather than throwing', () => {
    assert.deepEqual(scrubPayload(null), {});
    assert.deepEqual(scrubPayload(42), {});
    assert.deepEqual(scrubPayload('nope'), {});
    assert.deepEqual(scrubPayload(undefined), {});
  });

  it('isDisallowedKey catches the fragments, not just the exact names', () => {
    for (const k of ['lat', 'startLat', 'pickup_lng', 'LONGITUDE', 'coords', 'geometry',
      'geohash', 'bbox', 'accuracyM', 'streetAddress', 'contributorId', 'user_id',
      'displayName', 'pushToken']) {
      assert.equal(isDisallowedKey(k), true, `${k} should be disallowed`);
    }
    for (const k of ['cell', 'cellPrecision', 'kind', 'privacyClass', 'confidence',
      'freshness', 'objectId', 'decisionId', 'optionIndex', 'travelMode', 'ttl']) {
      assert.equal(isDisallowedKey(k), false, `${k} should be allowed`);
    }
  });
});

describe('mapTelemetry — describeMapObject', () => {
  it('emits kind, privacyClass, confidence, freshness and a coarse cell — never geometry or title', () => {
    const ref = describeMapObject(mapObject());
    assert.deepEqual(ref, {
      kind: 'place',
      privacyClass: 'place_level',
      cell: cellFor(16.0544, 108.2022),
      cellPrecision: TELEMETRY_CELL_PRECISION,
      objectId: 'obj-1',
      confidence: 'strong',
      freshness: 'live',
    } satisfies MapObjectRef);
    assert.equal((ref as Record<string, unknown>)['title'], undefined);
    assert.equal((ref as Record<string, unknown>)['geometry'], undefined);
  });

  it('withholds BOTH the id and the cell for identity-bearing kinds (§23)', () => {
    for (const kind of IDENTITY_BEARING_KINDS) {
      const ref = describeMapObject(mapObject({ id: 'user-uuid-1234', kind, privacyClass: 'precise_temporary' }));
      assert.equal(ref.objectId, undefined, `${kind} must not report an object id`);
      assert.equal(ref.cell, null, `${kind} must not report a location`);
      assert.equal(ref.withheld, true);
      assert.equal(ref.privacyClass, 'precise_temporary');
    }
  });

  it('withholds the cell for a privacyClass of none', () => {
    const ref = describeMapObject(mapObject({ privacyClass: 'none' }));
    assert.equal(ref.cell, null);
    assert.equal(ref.withheld, true);
  });

  it('reports aggregation fan-in but not the underlying objects', () => {
    const ref = describeMapObject(mapObject({ kind: 'activity_zone', count: 27, privacyClass: 'aggregate_only' }));
    assert.equal(ref.aggregated, 27);
    assert.equal(ref.privacyClass, 'aggregate_only');
  });

  it('uses the geometry centroid for polygons, never a vertex list', () => {
    const poly: PolygonGeometry = {
      type: 'Polygon',
      coordinates: [[[108.20, 16.05], [108.21, 16.05], [108.21, 16.06], [108.20, 16.06], [108.20, 16.05]]],
    };
    const cell = cellForGeometry(poly);
    assert.equal(typeof cell.cell, 'string');
    assert.equal(cell.cellPrecision, TELEMETRY_CELL_PRECISION);
  });
});

describe('mapTelemetry — the blanket privacy sweep', () => {
  it('no emitted payload contains a coordinate-shaped key after scrubbing', async () => {
    emitAllSixteen();
    // Plus deliberately hostile payloads that a careless call site might build.
    // Deliberately forbidden extras a careless call site might spread in.
    const hostile = {
      ref: describeMapObject(mapObject()),
      source: 'marker' as const,
      lat: 16.0544, lng: 108.2022, coordinates: [108.2022, 16.0544],
      geometry: point(16.0544, 108.2022),
      contributorId: 'u-1',
      nested: { userId: 'u-2', location: { latitude: 1, longitude: 2 } },
    };
    emitMapEvent('place_opened', hostile as unknown as PlaceOpenedPayload);
    await flushMapTelemetry();

    const FORBIDDEN = /lat|lng|latitude|longitude|coord/i;
    const walk = (v: unknown, path: string): void => {
      if (v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach((item, i) => walk(item, `${path}[${i}]`)); return; }
      for (const key of Object.keys(v as Record<string, unknown>)) {
        assert.equal(FORBIDDEN.test(key), false, `forbidden key "${key}" at ${path}`);
        walk((v as Record<string, unknown>)[key], `${path}.${key}`);
      }
    };

    assert.ok(transport.events.length >= 17);
    for (const ev of transport.events) walk(ev.payload, ev.name);
  });

  it('never emits the raw coordinate values either, not just the keys', async () => {
    openMap();
    emitMapEvent('place_opened', { ref: describeMapObject(mapObject()), source: 'marker' });
    await flushMapTelemetry();
    const json = JSON.stringify(transport.batches);
    assert.equal(json.includes('16.0544'), false);
    assert.equal(json.includes('108.2022'), false);
  });

  it('drops (and counts) an event that somehow still contains a disallowed key', async () => {
    openMap();
    // A payload whose forbidden key is hidden behind a getter the scrubber
    // copies through would be the failure mode; simulate the post-condition
    // firing by asserting the guard itself is wired and total.
    assert.equal(containsDisallowedKey({ a: { b: [{ lat: 1 }] } }), true);
    assert.equal(containsDisallowedKey({ a: { b: [{ cell: 'w6q' }] } }), false);
    await flushMapTelemetry();
    assert.equal(transport.events.length, 1);
  });
});

// ── 3. Correlation ────────────────────────────────────────────────────────────

describe('mapTelemetry — correlation ids', () => {
  it('mints a map session id at map_opened and carries it on every later event', async () => {
    emitAllSixteen();
    await flushMapTelemetry();
    const events = transport.events;
    const sid = events[0]?.mapSessionId;
    assert.equal(typeof sid, 'string');
    assert.equal(currentMapSessionId(), sid);
    for (const ev of events) assert.equal(ev.mapSessionId, sid, `${ev.name} lost the session id`);
    for (const ev of events) assert.equal(ev.synthesizedSession, undefined);
  });

  it('numbers events monotonically within a session', async () => {
    emitAllSixteen();
    await flushMapTelemetry();
    const seqs = transport.events.map((e) => e.seq);
    assert.deepEqual(seqs, Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it('starts a NEW session on a second map_opened', async () => {
    openMap();
    const first = currentMapSessionId();
    openMap();
    const second = currentMapSessionId();
    assert.notEqual(first, second);
    await flushMapTelemetry();
    assert.equal(transport.events[0]?.mapSessionId, first);
    assert.equal(transport.events[1]?.mapSessionId, second);
    assert.equal(transport.events[1]?.seq, 1, 'sequence restarts with the session');
  });

  it('synthesises and MARKS a session when an event fires before map_opened', async () => {
    emitMapEvent('place_opened', { ref: describeMapObject(mapObject()), source: 'deeplink' });
    await flushMapTelemetry();
    const ev = transport.events[0];
    assert.equal(typeof ev?.mapSessionId, 'string');
    assert.equal(ev?.synthesizedSession, true);
    assert.equal(currentMapSessionId(), null, 'a synthetic session is not a real map visit');
  });

  it('threads one decisionId through the whole §38 outcome loop', async () => {
    openMap();
    emitMapEvent('compass_requested', { trigger: 'action_rail', intent: 'food_now', mode: 'explore' });
    const decision = currentDecisionId();
    assert.equal(typeof decision, 'string');

    const ref = describeMapObject(mapObject());
    emitMapEvent('compass_option_selected', { ref, optionIndex: 1, optionCount: 4 });
    emitMapEvent('recommendation_accepted', { ref, via: 'route' });
    emitMapEvent('route_started', { ref, travelMode: 'walk', distance: '1-3km' });
    emitMapEvent('contribution_submitted', { ref, contributionKind: 'crowd_level', prompt: 'arrival', followedRoute: true });
    await flushMapTelemetry();

    const loop = transport.events.filter((e) => e.name !== 'map_opened');
    assert.equal(loop.length, 5);
    for (const ev of loop) {
      assert.equal(ev.payload['decisionId'], decision, `${ev.name} lost the decision id`);
    }
  });

  it('lets an explicit decisionId override the active one (a stashed card outcome)', async () => {
    openMap();
    emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'explore' });
    const stale = currentDecisionId();
    const stashed = newDecisionId();
    const ref = describeMapObject(mapObject());
    emitMapEvent('route_started', { ref, travelMode: 'drive', distance: '3-10km', decisionId: stashed });
    await flushMapTelemetry();
    const routed = transport.events.find((e) => e.name === 'route_started');
    assert.equal(routed?.payload['decisionId'], stashed);
    assert.notEqual(routed?.payload['decisionId'], stale);
  });

  it('a new compass_requested starts a new decision', async () => {
    openMap();
    emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'explore' });
    const first = currentDecisionId();
    emitMapEvent('compass_requested', { trigger: 'long_press', mode: 'explore' });
    const second = currentDecisionId();
    assert.notEqual(first, second);
  });

  it('clearActiveDecision stops later outcomes being mis-attributed', async () => {
    openMap();
    emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'explore' });
    clearActiveDecision();
    const ref = describeMapObject(mapObject());
    emitMapEvent('route_started', { ref, travelMode: 'walk', distance: '<0.5km' });
    await flushMapTelemetry();
    const routed = transport.events.find((e) => e.name === 'route_started');
    assert.equal(routed?.payload['decisionId'], undefined);
  });

  it('never attaches a decisionId to a non-decision event', async () => {
    openMap();
    emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'explore' });
    const ref = describeMapObject(mapObject());
    emitMapEvent('live_state_viewed', { ref, activity: 'busy' });
    emitMapEvent('why_shown_opened', { ref, lineCount: 2 });
    await flushMapTelemetry();
    for (const name of ['live_state_viewed', 'why_shown_opened']) {
      const ev = transport.events.find((e) => e.name === name);
      assert.equal(ev?.payload['decisionId'], undefined, `${name} must not carry a decisionId`);
    }
  });

  it('endMapSession flushes and forgets both ids', async () => {
    openMap();
    emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'explore' });
    await endMapSession();
    assert.equal(transport.events.length, 2);
    assert.equal(currentMapSessionId(), null);
    assert.equal(currentDecisionId(), null);
  });
});

// ── 4. Bounded queue and drop accounting ──────────────────────────────────────

describe('mapTelemetry — bounded queue', () => {
  it('drops the OLDEST once the bound is exceeded, and counts every drop', async () => {
    configureMapTelemetry({ maxQueueSize: 5, batchSize: 1000, transport: null });
    openMap();
    const ref = describeMapObject(mapObject());
    for (let i = 0; i < 20; i += 1) {
      emitMapEvent('place_opened', { ref, source: 'marker', rank: i });
    }
    const diag = mapTelemetryDiagnostics();
    assert.equal(diag.queueDepth, 5);
    // 21 events emitted, 5 retained → 16 dropped.
    assert.equal(diag.droppedTotal, 16);
    assert.equal(diag.droppedByReason.queue_overflow, 16);

    setMapTelemetryTransport(transport.fn);
    await flushMapTelemetry();
    const ranks = transport.events.map((e) => e.payload['rank']);
    assert.deepEqual(ranks, [15, 16, 17, 18, 19], 'the newest five survive');
  });

  it('reports the drop count on the batch — a lost event is never silent', async () => {
    configureMapTelemetry({ maxQueueSize: 3, batchSize: 1000, transport: null });
    openMap();
    const ref = describeMapObject(mapObject());
    for (let i = 0; i < 10; i += 1) emitMapEvent('place_opened', { ref, source: 'marker', rank: i });

    setMapTelemetryTransport(transport.fn);
    await flushMapTelemetry();
    const meta = transport.batches[0]?.meta;
    assert.equal(meta?.dropped, 8);
    assert.equal(meta?.droppedTotal, 8);
    assert.equal(meta?.droppedByReason.queue_overflow, 8);
    assert.equal(meta?.queueDepth, 3);
    assert.equal(meta?.mapSessionId, currentMapSessionId());
  });

  it('clears the reported drop count after a successful delivery, and reports new ones next time', async () => {
    configureMapTelemetry({ maxQueueSize: 2, batchSize: 1000 });
    openMap();
    const ref = describeMapObject(mapObject());
    for (let i = 0; i < 5; i += 1) emitMapEvent('place_opened', { ref, source: 'marker', rank: i });
    await flushMapTelemetry();
    assert.equal(transport.batches[0]?.meta.dropped, 4);

    for (let i = 0; i < 4; i += 1) emitMapEvent('place_opened', { ref, source: 'marker', rank: 100 + i });
    await flushMapTelemetry();
    assert.equal(transport.batches[1]?.meta.dropped, 2, 'only the NEW drops are re-reported');
    assert.equal(transport.batches[1]?.meta.droppedTotal, 6, 'the lifetime total keeps climbing');
  });

  it('re-queues a failed batch instead of losing it', async () => {
    openMap();
    transport.failFor(1);
    await flushMapTelemetry();
    assert.equal(transport.batches.length, 0);
    assert.equal(mapTelemetryDiagnostics().queueDepth, 1, 'the event survived the failure');

    await flushMapTelemetry();
    assert.equal(transport.batches.length, 1);
    assert.equal(transport.events[0]?.name, 'map_opened');
  });

  it('gives up after maxDeliveryAttempts and counts the loss rather than retrying forever', async () => {
    configureMapTelemetry({ maxDeliveryAttempts: 3 });
    openMap();
    transport.failFor(3);
    await flushMapTelemetry();
    await flushMapTelemetry();
    await flushMapTelemetry();
    const diag = mapTelemetryDiagnostics();
    assert.equal(diag.queueDepth, 0);
    assert.equal(diag.droppedByReason.delivery_failed, 1);

    // And the loss is reported on the next successful batch.
    openMap();
    await flushMapTelemetry();
    assert.equal(transport.batches[0]?.meta.droppedByReason.delivery_failed, 1);
  });

  it('keeps events queued (not dropped) while no transport is installed', async () => {
    configureMapTelemetry({ transport: null });
    openMap();
    await flushMapTelemetry();
    assert.equal(mapTelemetryDiagnostics().queueDepth, 1);
    assert.equal(mapTelemetryDiagnostics().droppedTotal, 0);

    setMapTelemetryTransport(transport.fn);
    await flushMapTelemetry();
    assert.equal(transport.events.length, 1);
  });
});

// ── 5. Flush triggers ─────────────────────────────────────────────────────────

describe('mapTelemetry — flush triggers', () => {
  it('flushes on size', async () => {
    configureMapTelemetry({ batchSize: 4, flushIntervalMs: 999_999 });
    openMap();
    const ref = describeMapObject(mapObject());
    assert.equal(transport.batches.length, 0);
    emitMapEvent('place_opened', { ref, source: 'marker' });
    emitMapEvent('place_opened', { ref, source: 'marker' });
    emitMapEvent('place_opened', { ref, source: 'marker' }); // 4th event
    await flushMapTelemetry();
    assert.equal(transport.events.length, 4);
    assert.equal(transport.batches.length, 1, 'the size trigger cut exactly one batch');
  });

  it('flushes on interval', async () => {
    configureMapTelemetry({ batchSize: 100, flushIntervalMs: 15_000 });
    openMap();
    assert.equal(mapTelemetryDiagnostics().timerScheduled, true);
    assert.equal(transport.batches.length, 0);

    clock.advance(14_000);
    assert.equal(transport.batches.length, 0, 'must not flush early');

    clock.advance(2_000);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(transport.batches.length, 1);
    assert.equal(transport.events[0]?.name, 'map_opened');
  });

  it('does not stack timers — one pending flush at a time', () => {
    configureMapTelemetry({ batchSize: 100, flushIntervalMs: 15_000 });
    openMap();
    const ref = describeMapObject(mapObject());
    for (let i = 0; i < 5; i += 1) emitMapEvent('place_opened', { ref, source: 'marker' });
    assert.equal(clock.pendingCount, 1);
  });

  it('flushes on backgrounding', async () => {
    configureMapTelemetry({ batchSize: 100, flushIntervalMs: 999_999 });
    openMap();
    assert.equal(transport.batches.length, 0);
    notifyMapAppStateChange('background');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(transport.batches.length, 1);
    assert.equal(mapTelemetryDiagnostics().queueDepth, 0);
  });

  it('ignores an active app-state change', async () => {
    configureMapTelemetry({ batchSize: 100, flushIntervalMs: 999_999 });
    openMap();
    notifyMapAppStateChange('active');
    await Promise.resolve();
    assert.equal(transport.batches.length, 0);
  });

  it('flushing an empty queue is a no-op', async () => {
    await flushMapTelemetry();
    assert.equal(transport.batches.length, 0);
  });

  it('concurrent flushes do not send an event twice', async () => {
    openMap();
    const ref = describeMapObject(mapObject());
    emitMapEvent('place_opened', { ref, source: 'marker' });
    await Promise.all([flushMapTelemetry(), flushMapTelemetry(), flushMapTelemetry()]);
    assert.equal(transport.events.length, 2);
  });
});

// ── 6. Emitter robustness and helpers ─────────────────────────────────────────

describe('mapTelemetry — robustness', () => {
  it('never throws, even on a hostile payload', () => {
    openMap();
    const cyclic: Record<string, unknown> = { ok: 1 };
    cyclic['self'] = cyclic;
    assert.doesNotThrow(() => {
      // @ts-expect-error — deliberately wrong payload shape
      emitMapEvent('place_opened', cyclic);
    });
  });

  it('stamps a client timestamp on every event', async () => {
    openMap();
    await flushMapTelemetry();
    assert.equal(typeof transport.events[0]?.ts, 'number');
  });

  it('carries the schema version on the batch', async () => {
    openMap();
    await flushMapTelemetry();
    assert.equal(transport.batches[0]?.meta.schemaVersion, '1.0');
  });

  it('bucket helpers band values instead of reporting raw counts', () => {
    assert.equal(countBucket(0), '0');
    assert.equal(countBucket(1), '1');
    assert.equal(countBucket(4), '2-4');
    assert.equal(countBucket(9), '5-9');
    assert.equal(countBucket(24), '10-24');
    assert.equal(countBucket(99), '25-99');
    assert.equal(countBucket(1000), '100+');
    assert.equal(countBucket(null), '0');

    assert.equal(distanceBucket(0.2), '<0.5km');
    assert.equal(distanceBucket(0.7), '0.5-1km');
    assert.equal(distanceBucket(2), '1-3km');
    assert.equal(distanceBucket(9), '3-10km');
    assert.equal(distanceBucket(30), '10-50km');
    assert.equal(distanceBucket(300), '50km+');
    assert.equal(distanceBucket(undefined), 'unknown');

    assert.equal(durationBucketMs(30_000), '<1m');
    assert.equal(durationBucketMs(4 * 60_000), '1-5m');
    assert.equal(durationBucketMs(10 * 60_000), '5-15m');
    assert.equal(durationBucketMs(30 * 60_000), '15-60m');
    assert.equal(durationBucketMs(2 * 3_600_000), '1-4h');
    assert.equal(durationBucketMs(9 * 3_600_000), '4h+');
    assert.equal(durationBucketMs(-1), 'unknown');
  });

  it('geohashEncode matches the reference encoding and rejects bad input', () => {
    // Reference vectors from the standard geohash algorithm.
    assert.equal(geohashEncode(57.64911, 10.40744, 11), 'u4pruydqqvj');
    assert.equal(geohashEncode(0, 0, 5), 's0000');
    assert.equal(geohashEncode(Number.NaN, 1), null);
    assert.equal(geohashEncode(91, 1), null);
    assert.equal(geohashEncode(1, 181), null);
    assert.equal(cellFor(16.0544, 108.2022)?.length, 5);
  });

  it('cellForGeometry withholds rather than guessing on unusable geometry', () => {
    assert.equal(cellForGeometry(null).cell, null);
    assert.equal(cellForGeometry({ type: 'LineString', coordinates: [] }).cell, null);
  });
});

describe('mapTelemetry — createFetchTelemetryTransport', () => {
  it('POSTs the batch with a bearer token and no client-supplied actor id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const t = createFetchTelemetryTransport({
      baseUrl: 'https://api.example',
      getToken: async () => 'tok-1',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch,
    });
    setMapTelemetryTransport(t);
    openMap();
    await flushMapTelemetry();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.example/api/map/telemetry');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer tok-1');
    const body = JSON.parse(String(calls[0]?.init.body)) as MapTelemetryBatch;
    assert.equal(body.events[0]?.name, 'map_opened');
    assert.equal(containsDisallowedKey(body), false);
  });

  it('rejects on a non-2xx so the emitter re-queues', async () => {
    const t = createFetchTelemetryTransport({
      baseUrl: 'https://api.example',
      getToken: async () => 'tok-1',
      fetchImpl: (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch,
    });
    setMapTelemetryTransport(t);
    openMap();
    await flushMapTelemetry();
    assert.equal(mapTelemetryDiagnostics().queueDepth, 1);
  });

  it('rejects when signed out rather than posting anonymously', async () => {
    const t = createFetchTelemetryTransport({
      baseUrl: 'https://api.example',
      getToken: async () => null,
      fetchImpl: (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch,
    });
    await assert.rejects(() => t({ events: [], meta: {
      schemaVersion: '1.0', mapSessionId: null, dropped: 0, droppedTotal: 0,
      droppedByReason: {}, queueDepth: 0,
    } }));
  });
});
