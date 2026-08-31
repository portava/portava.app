/**
 * clientProjection — the client-edge projectors for the layers that do not yet
 * come through the Map Intelligence Gateway.
 *
 * The point of these tests is that a client-side projector is the easiest place
 * in the system to accidentally break the two rules the gateway exists to
 * enforce, because it runs where the raw payloads already are:
 *
 *   - it must not INVENT freshness or a confidence band (spec §37);
 *   - it must not SHARPEN a coordinate or a privacy rung (spec §19, §23).
 *
 * The fallback projectors additionally have to produce byte-compatible output
 * with their server counterparts, or the renderer would behave differently
 * depending on whether a feature flag happened to be on.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

import {
  BUDDY_PRIVACY_CLASS,
  FRIEND_PRIVACY_CLASS,
  TRIP_PRIVACY_CLASS,
  projectBuddy,
  projectEventLocal,
  projectFriend,
  projectGemLocal,
  projectTrip,
} from '../clientProjection.ts';
import {
  KIND_DEFAULT_PRIORITY,
  isRenderable,
  mayRenderIdentity,
  type MapObject,
} from '../../../../types/mapObjects.ts';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');

// These fixtures MUST mirror what the server actually puts on the wire.
// They previously did not — BUDDY carried `handle` and `headline`, FRIEND
// carried `displayName`, and none of the three exist in any server DTO. The
// projectors read those invented fields, so every buddy subtitle collapsed to
// the city and every friend pin rendered the generic fallback. The tests
// passed throughout, because the fixtures had been written to match the
// projectors rather than reality.
//
// `dtoFieldGuard` at the bottom of this file now pins these key sets against
// the server source, so a fixture can no longer drift into fiction.
const BUDDY = {
  id: 'b1',
  displayName: 'Mika',
  city: 'Bangkok',
  tagline: 'Street food guide',
  meetupBaseLat: 13.75,
  meetupBaseLng: 100.5,
};

const TRIP = {
  id: 't1',
  title: 'Songkran',
  destination: 'Chiang Mai',
  destinationLat: 18.79,
  destinationLng: 98.98,
  startDate: '2026-04-12',
  endDate: '2026-04-16',
};

const FRIEND = {
  userId: 'u9',
  name: 'Rui',
  city: 'Tokyo',
  lat: 35.68,
  lng: 139.76,
};

const GEM = {
  id: 'g1',
  name: 'Rooftop stairwell',
  category: 'viewpoint',
  city: 'Da Nang',
  status: 'active',
  coordsPrecision: 'exact',
  lat: 16.06,
  lng: 108.21,
};

const EVENT = {
  id: 'e1',
  title: 'Night market',
  locationName: 'Han River',
  locationLat: 16.07,
  locationLng: 108.22,
  startsAt: '2026-08-31T12:00:00.000Z',
};

// ── the two invariants ────────────────────────────────────────────────────────

describe('no invented intelligence (spec §37)', () => {
  const all: Array<[string, MapObject]> = [
    ['buddy', projectBuddy(BUDDY)!],
    ['trip', projectTrip(TRIP)!],
    ['friend', projectFriend(FRIEND)!],
    ['gem', projectGemLocal(GEM)!],
    ['event', projectEventLocal(EVENT, NOW)!],
  ];

  for (const [name, obj] of all) {
    test(`${name} asserts no confidence band`, () => {
      assert.equal(obj.confidence, undefined);
    });
    test(`${name} asserts no freshness`, () => {
      // None of these sources observes "what is true here right now", so a
      // freshness value here would be a fabrication.
      assert.equal(obj.freshness, undefined);
    });
    test(`${name} asserts no activity, trend or provenance`, () => {
      assert.equal(obj.activity, undefined);
      assert.equal(obj.trend, undefined);
      assert.equal(obj.provenance, undefined);
      assert.equal(obj.sourceRefs, undefined);
    });
  }
});

describe('coordinates are echoed, never derived', () => {
  test('geometry matches the source coordinates exactly', () => {
    assert.deepEqual(projectBuddy(BUDDY)!.geometry, {
      type: 'Point',
      coordinates: [100.5, 13.75],
    });
    assert.deepEqual(projectFriend(FRIEND)!.geometry, {
      type: 'Point',
      coordinates: [139.76, 35.68],
    });
  });

  test('a missing coordinate yields null, never a fallback position', () => {
    assert.equal(projectBuddy({ ...BUDDY, meetupBaseLat: null }), null);
    assert.equal(projectBuddy({ ...BUDDY, meetupBaseLng: undefined }), null);
    assert.equal(projectTrip({ ...TRIP, destinationLat: null }), null);
    assert.equal(projectFriend({ ...FRIEND, lat: null }), null);
    assert.equal(projectGemLocal({ ...GEM, lng: null }), null);
    assert.equal(projectEventLocal({ ...EVENT, locationLat: null }, NOW), null);
  });

  test('projectFriend does not coarsen — the caller must pass safe coordinates', () => {
    // A projector that could coarsen could also un-coarsen. Jitter is applied
    // upstream in useMapEntities; this asserts the projector stays a pure shaper.
    const obj = projectFriend(FRIEND)!;
    assert.deepEqual(obj.geometry.coordinates, [FRIEND.lng, FRIEND.lat]);
  });
});

// ── privacy rungs ─────────────────────────────────────────────────────────────

describe('privacy classes (spec §23)', () => {
  test('a buddy meetup base is approximate, not place_level', () => {
    assert.equal(BUDDY_PRIVACY_CLASS, 'approximate');
    assert.equal(projectBuddy(BUDDY)!.privacyClass, 'approximate');
  });

  test('a friend is approximate — a ring, never an avatar-precision pin', () => {
    assert.equal(FRIEND_PRIVACY_CLASS, 'approximate');
    assert.equal(projectFriend(FRIEND)!.privacyClass, 'approximate');
  });

  test('a trip destination is place_level', () => {
    assert.equal(TRIP_PRIVACY_CLASS, 'place_level');
    assert.equal(projectTrip(TRIP)!.privacyClass, 'place_level');
  });

  test('a gem only reaches place_level on an explicit "exact"', () => {
    assert.equal(projectGemLocal(GEM)!.privacyClass, 'place_level');
    assert.equal(projectGemLocal({ ...GEM, coordsPrecision: 'approximate' })!.privacyClass, 'approximate');
    // Fail-closed: anything the guard did not explicitly mark exact is blurred.
    assert.equal(projectGemLocal({ ...GEM, coordsPrecision: null })!.privacyClass, 'approximate');
    assert.equal(projectGemLocal({ ...GEM, coordsPrecision: 'unknown' })!.privacyClass, 'approximate');
  });

  test('no projector ever emits the "none" rung, which must not render', () => {
    for (const obj of [
      projectBuddy(BUDDY)!,
      projectTrip(TRIP)!,
      projectFriend(FRIEND)!,
      projectGemLocal(GEM)!,
      projectEventLocal(EVENT, NOW)!,
    ]) {
      assert.notEqual(obj.privacyClass, 'none');
      assert.ok(isRenderable(obj));
    }
  });

  test('approximate still permits identity — the ring, not the name, is the limit', () => {
    // mayRenderIdentity is the gate the RENDERER consults; asserting it here
    // pins the relationship between these rungs and that gate.
    assert.equal(mayRenderIdentity(FRIEND_PRIVACY_CLASS), true);
    assert.equal(mayRenderIdentity('aggregate_only'), false);
  });
});

// ── kinds and priorities ──────────────────────────────────────────────────────

describe('contract kinds and rendering priority', () => {
  test('each source maps to its contract kind', () => {
    assert.equal(projectBuddy(BUDDY)!.kind, 'buddy_zone');
    assert.equal(projectTrip(TRIP)!.kind, 'trip_stop');
    assert.equal(projectFriend(FRIEND)!.kind, 'crew_member');
    assert.equal(projectGemLocal(GEM)!.kind, 'hidden_gem');
    assert.equal(projectEventLocal(EVENT, NOW)!.kind, 'event');
  });

  test('priorities come from the contract ladder, not from local numbers', () => {
    assert.equal(projectBuddy(BUDDY)!.renderingPriority, KIND_DEFAULT_PRIORITY.buddy_zone);
    assert.equal(projectTrip(TRIP)!.renderingPriority, KIND_DEFAULT_PRIORITY.trip_stop);
    assert.equal(projectFriend(FRIEND)!.renderingPriority, KIND_DEFAULT_PRIORITY.crew_member);
    assert.equal(projectGemLocal(GEM)!.renderingPriority, KIND_DEFAULT_PRIORITY.hidden_gem);
  });

  test('a crew member outranks a buddy zone — §31 puts crew above social', () => {
    assert.ok(
      projectFriend(FRIEND)!.renderingPriority > projectBuddy(BUDDY)!.renderingPriority,
    );
  });

  test('a started event outranks a merely scheduled one', () => {
    const started = projectEventLocal(EVENT, NOW)!;
    const later = projectEventLocal({ ...EVENT, startsAt: '2026-08-31T20:00:00.000Z' }, NOW)!;
    assert.equal(started.renderingPriority, KIND_DEFAULT_PRIORITY.event);
    assert.ok(later.renderingPriority < started.renderingPriority);
  });

  test('an unparseable start time is treated as not-yet-started, not as active', () => {
    const bad = projectEventLocal({ ...EVENT, startsAt: 'not-a-date' }, NOW)!;
    assert.ok(bad.renderingPriority < KIND_DEFAULT_PRIORITY.event);
    assert.equal((bad.payload as any).hasStarted ?? false, false);
  });
});

// ── status filtering ──────────────────────────────────────────────────────────

describe('status filtering', () => {
  test('a non-active gem is dropped', () => {
    assert.equal(projectGemLocal({ ...GEM, status: 'pending' }), null);
    assert.equal(projectGemLocal({ ...GEM, status: 'removed' }), null);
  });

  test('a gem with no status field is kept', () => {
    const { status, ...noStatus } = GEM;
    assert.ok(projectGemLocal(noStatus) !== null);
  });
});

// ── interaction config ────────────────────────────────────────────────────────

describe('interaction', () => {
  test('a friend gets no static detail route — threads resolve dynamically', () => {
    assert.equal(projectFriend(FRIEND)!.interaction!.detailRoute, undefined);
  });

  test('gems and events are contributable; buddies, trips and friends are not', () => {
    assert.equal(projectGemLocal(GEM)!.interaction!.contributable, true);
    assert.equal(projectEventLocal(EVENT, NOW)!.interaction!.contributable, true);
    assert.equal(projectBuddy(BUDDY)!.interaction!.contributable, undefined);
    assert.equal(projectTrip(TRIP)!.interaction!.contributable, undefined);
    assert.equal(projectFriend(FRIEND)!.interaction!.contributable, undefined);
  });

  test('detail routes point at the real app routes', () => {
    assert.equal(projectBuddy(BUDDY)!.interaction!.detailRoute, '/(rent-a-buddy)/buddy/b1');
    assert.equal(projectTrip(TRIP)!.interaction!.detailRoute, '/trip/t1');
    assert.equal(projectGemLocal(GEM)!.interaction!.detailRoute, '/gems/g1');
    assert.equal(projectEventLocal(EVENT, NOW)!.interaction!.detailRoute, '/event/e1');
  });
});

// ── ids and titles ────────────────────────────────────────────────────────────

describe('identity of the object itself', () => {
  test('ids are namespaced so two sources can never collide', () => {
    assert.equal(projectBuddy(BUDDY)!.id, 'buddy:b1');
    assert.equal(projectTrip(TRIP)!.id, 'trip:t1');
    assert.equal(projectFriend(FRIEND)!.id, 'friend:u9');
    assert.equal(projectGemLocal(GEM)!.id, 'gem:g1');
    assert.equal(projectEventLocal(EVENT, NOW)!.id, 'event:e1');
  });

  test('a missing title falls back to a generic label, never to an empty string', () => {
    // isRenderable() drops empty titles, so a nameless row must still get a word.
    for (const obj of [
      projectBuddy({ ...BUDDY, displayName: null, handle: null })!,
      projectTrip({ ...TRIP, title: null, destination: null })!,
      projectFriend({ ...FRIEND, displayName: null, handle: null })!,
      projectGemLocal({ ...GEM, name: null })!,
      projectEventLocal({ ...EVENT, title: null }, NOW)!,
    ]) {
      assert.ok(obj.title.trim().length > 0, `empty title on ${obj.id}`);
      assert.ok(isRenderable(obj));
    }
  });

  test('subtitle is undefined rather than an empty or dangling separator', () => {
    assert.equal(projectBuddy({ ...BUDDY, city: null, tagline: null })!.subtitle, undefined);
    assert.equal(projectGemLocal({ ...GEM, category: null, city: null })!.subtitle, undefined);
    // One present part must not carry the separator.
    assert.equal(projectGemLocal({ ...GEM, category: null })!.subtitle, 'Da Nang');
  });

  test('a trip with only one date still renders a legible range', () => {
    assert.match(projectTrip({ ...TRIP, endDate: null })!.subtitle!, /2026-04-12 → \?/);
  });
});

// ── The fixtures are pinned to the server's real DTOs ─────────────────────────
//
// The buddy and friend projectors both read fields that no server DTO has ever
// emitted (`headline`, `handle`, `displayName` on a circle member). The bugs
// were invisible for the same reason in both cases: the fixture supplied the
// invented field, so the projector found it and the assertion passed. The test
// was checking that the code agreed with itself.
//
// These guards read the SERVER SOURCE and fail when a fixture names a field the
// server does not emit. That is the property that was actually missing — not
// another example, which would have been written against the same wrong fixture.

describe('the fixtures mirror the server DTOs', () => {
  const SERVER = resolve(__dir, '../../../../../..', 'artifacts', 'api-server', 'src');

  /** The object-literal keys of a mapper/interface, read from source. */
  function emittedKeys(file: string, startMarker: string, endMarker: string): Set<string> {
    const src = readFileSync(resolve(SERVER, file), 'utf8');
    const from = src.indexOf(startMarker);
    assert.ok(from >= 0, `marker "${startMarker}" not found in ${file} — did it get renamed?`);
    const to = src.indexOf(endMarker, from);
    assert.ok(to > from, `end marker "${endMarker}" not found after "${startMarker}" in ${file}`);
    const body = src.slice(from, to);
    const keys = new Set<string>();
    for (const m of body.matchAll(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\s*[:?]/gm)) keys.add(m[1]);
    assert.ok(keys.size > 3, `parsed only ${keys.size} keys from ${file} — the parse broke, so this guard would be inert`);
    return keys;
  }

  test('every BUDDY fixture field is one the server actually emits', () => {
    const emitted = emittedKeys('lib/buddyMapRead.ts', 'export function mapBuddyPublicProfile', '\n}');
    const invented = Object.keys(BUDDY).filter((k) => !emitted.has(k));
    assert.deepEqual(
      invented,
      [],
      'the fixture names fields no server DTO emits — a projector reading one of these gets undefined in production while this suite stays green',
    );
  });

  test('every FRIEND fixture field is one the server actually emits', () => {
    const emitted = emittedKeys('lib/circleLocationsRead.ts', 'export interface CircleLocationEntry', '\n}');
    const invented = Object.keys(FRIEND).filter((k) => !emitted.has(k));
    assert.deepEqual(invented, [], 'the fixture names fields no server DTO emits');
  });

  test('the buddy subtitle uses a field that survives the round trip', () => {
    // The specific regression: `headline` produced a subtitle of the city alone,
    // which looks like a buddy who simply has no tagline. Nothing about the
    // rendered output said the field was missing.
    const withTagline = projectBuddy(BUDDY)!;
    const withoutTagline = projectBuddy({ ...BUDDY, tagline: null })!;
    assert.notEqual(
      withTagline.subtitle,
      withoutTagline.subtitle,
      'the subtitle ignores the tagline entirely — it is reading a field the DTO does not carry',
    );
    assert.ok(withTagline.subtitle?.includes('Street food guide'));
  });

  test('a named circle member renders their name, not the fallback', () => {
    assert.equal(projectFriend(FRIEND)!.title, 'Rui');
  });

  test('an unnamed circle member falls back generically, never to a handle', () => {
    // `name` is null when the member has NOT opted into showing a real name.
    // Reaching past it for a handle would defeat that gate, so the projector
    // must not accept one even if a caller supplies it.
    const anon = projectFriend({ ...FRIEND, name: null, handle: 'rui_t' })!;
    assert.equal(anon.title, 'Circle member');
    assert.ok(!JSON.stringify(anon.title).includes('rui_t'));
  });
});
