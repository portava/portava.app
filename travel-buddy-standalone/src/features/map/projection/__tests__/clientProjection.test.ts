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
  projectCompassResult,
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

// `destinationCity`, not `destination`. The old fixture carried `destination`,
// a field neither TripRow (services/trips.ts) nor the server's TripViewLike has
// ever had — so `projectTrip` read undefined in production and every trip
// subtitle rendered as a bare date range, while this suite stayed green because
// the fixture supplied the invented field. Same failure, same shape, as
// `headline` and `displayName` before it; the TRIP guard below is what was
// missing.
const TRIP = {
  id: 't1',
  title: 'Songkran',
  destinationCity: 'Chiang Mai',
  destinationCountry: 'Thailand',
  destinationLat: 18.79,
  destinationLng: 98.98,
  startDate: '2026-04-12',
  endDate: '2026-04-16',
  status: 'planning',
  visibility: 'public',
};

const FRIEND = {
  userId: 'u9',
  name: 'Rui',
  city: 'Tokyo',
  country: 'Japan',
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
    // Every non-active member of GemStatus. This used to test 'removed', which
    // is not a GemStatus at all — so the second case proved only that an
    // impossible value is dropped, and 'hidden' and 'merged' went uncovered.
    assert.equal(projectGemLocal({ ...GEM, status: 'pending' }), null);
    assert.equal(projectGemLocal({ ...GEM, status: 'hidden' }), null);
    assert.equal(projectGemLocal({ ...GEM, status: 'merged' }), null);
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
      projectTrip({ ...TRIP, title: null, destinationCity: null })!,
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

  test('every TRIP fixture field is one the server actually emits', () => {
    // The guard that did not exist. BUDDY and FRIEND were pinned after their
    // invented fields were found; TRIP was not, and `destination` survived.
    const emitted = emittedKeys('lib/mapProjection.ts', 'export type TripViewLike', '\n}');
    const invented = Object.keys(TRIP).filter((k) => !emitted.has(k));
    assert.deepEqual(
      invented,
      [],
      'the fixture names fields no server DTO emits — a projector reading one of these gets undefined in production while this suite stays green',
    );
  });

  test('the trip subtitle uses a field that survives the round trip', () => {
    // The specific regression: reading `destination` produced a subtitle of the
    // date range alone, which looks exactly like a trip whose city is simply
    // unset. Nothing in the rendered output said a field was missing.
    const withCity = projectTrip(TRIP)!;
    const withoutCity = projectTrip({ ...TRIP, destinationCity: null })!;
    assert.notEqual(
      withCity.subtitle,
      withoutCity.subtitle,
      'the subtitle ignores the destination city entirely — it is reading a field the DTO does not carry',
    );
    assert.ok(withCity.subtitle?.includes('Chiang Mai'));
  });

  test('an untitled trip falls back to its city, not to the generic label', () => {
    assert.equal(projectTrip({ ...TRIP, title: null })!.title, 'Chiang Mai');
  });
});

// ── Byte-parity with the server's projectors ──────────────────────────────────
//
// These are the rollback projectors: they run only when the gateway did not
// answer. "The renderer cannot tell which path produced an object" is their
// whole contract, so the expectations below are written from the SERVER source
// (artifacts/api-server/src/lib/mapProjection.ts) rather than from this
// module's current output. A field this file gets right and the server gets
// differently is still a bug — it makes the map change shape when a flag flips.

describe('the rollback projectors mirror the server field for field', () => {
  test('buddy_zone: title, subtitle and rung match projectBuddy', () => {
    const obj = projectBuddy(BUDDY)!;
    assert.equal(obj.id, 'buddy:b1');
    assert.equal(obj.kind, 'buddy_zone');
    // server: title: b.displayName ?? "Buddy"
    assert.equal(obj.title, 'Mika');
    // server: subtitle: joinParts([b.city, b.tagline], " · ")
    assert.equal(obj.subtitle, 'Bangkok · Street food guide');
    assert.equal(obj.privacyClass, 'approximate');
    assert.deepEqual(obj.geometry, { type: 'Point', coordinates: [100.5, 13.75] });
  });

  test('crew_member: subtitle carries city AND country, as the server joins them', () => {
    const obj = projectFriend(FRIEND)!;
    assert.equal(obj.id, 'friend:u9');
    assert.equal(obj.kind, 'crew_member');
    assert.equal(obj.title, 'Rui');
    // server: subtitle: joinParts([m.city, m.country], ", ") — the country was
    // dropped here, so the same member read "Tokyo" through one transport and
    // "Tokyo, Japan" through the other.
    assert.equal(obj.subtitle, 'Tokyo, Japan');
    assert.equal(obj.privacyClass, 'approximate');
  });

  test('trip_stop: title falls back to the city and the subtitle leads with it', () => {
    const obj = projectTrip(TRIP)!;
    assert.equal(obj.id, 'trip:t1');
    assert.equal(obj.kind, 'trip_stop');
    assert.equal(obj.title, 'Songkran');
    // server: joinParts([t.destinationCity, tripDateRange(start, end)], " · ")
    assert.equal(obj.subtitle, 'Chiang Mai · 2026-04-12 → 2026-04-16');
    assert.equal(obj.privacyClass, 'place_level');
  });

  test('a circle member payload carries no coordinates', () => {
    // The server's projectCircleMember emits userId/name/avatarUrl/city/
    // country/updatedAt and NOT lat/lng. The position belongs in `geometry`,
    // which the §24 protection gate and the §31 aggregator both coarsen; a
    // second copy in `payload` would sail past both.
    const payload = projectFriend(FRIEND)!.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      'avatarUrl', 'city', 'country', 'name', 'updatedAt', 'userId',
    ]);
    assert.ok(!('lat' in payload), 'a coordinate in payload escapes every downstream coarsening step');
    assert.ok(!('lng' in payload));
  });

  test('a trip payload carries the six fields the server emits, and no more', () => {
    const payload = projectTrip(TRIP)!.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      'destinationCity', 'destinationCountry', 'endDate', 'startDate', 'status', 'visibility',
    ]);
  });

  test('a buddy payload drops the marketplace-only distanceKm', () => {
    // POST /api/rent-a-buddy/search adds `distanceKm` on top of the shared
    // mapper; the gateway's readBuddyMapPins does not. Carrying it would be the
    // one field that tells the renderer which transport ran.
    const payload = projectBuddy({ ...BUDDY, distanceKm: 2.4 })!.payload as Record<string, unknown>;
    assert.ok(!('distanceKm' in payload));
    assert.equal(payload.displayName, 'Mika', 'the rest of the DTO must survive the strip');
  });
});

// ── Compass results ───────────────────────────────────────────────────────────
//
// AskCompassBar used to hand the raw `CompassRecommendation` through as
// `entity.payload` — a THIRD shape the map cards had to guess at, and the one
// that made a Compass buddy or trip result hit `categories.slice` /
// `visibility.replace` and take the card down. It goes through a projector now,
// like every other producer.

describe('projectCompassResult', () => {
  const REC = {
    id: 'rec-1',
    type: 'buddy',
    category: 'city',
    title: 'Mika',
    reason: 'Speaks your languages',
    city: 'Bangkok',
    data: { lat: 13.75, lng: 100.5 },
  };

  test('a Compass result becomes a contract object, not a raw recommendation', () => {
    const obj = projectCompassResult(REC)!;
    assert.equal(obj.kind, 'buddy_zone');
    assert.equal(obj.title, 'Mika');
    assert.equal(obj.subtitle, 'Speaks your languages · Bangkok');
    assert.ok(isRenderable(obj));
  });

  test('it carries no payload when the server sent no intent-match datum', () => {
    // A card must therefore render from title/subtitle alone rather than
    // reaching for fields a recommendation was never going to have.
    assert.equal(projectCompassResult(REC)!.payload, undefined);
  });

  test('§14: carries the intent-match datum when the server decided it', () => {
    const matched = projectCompassResult({
      ...REC,
      data: { ...REC.data, matchesIntent: true, intentLabel: 'Party' },
    })!;
    assert.deepEqual(matched.payload, { matchesIntent: true, intentLabel: 'Party' });

    const notMatched = projectCompassResult({
      ...REC,
      data: { ...REC.data, matchesIntent: false, intentLabel: 'Party' },
    })!;
    // A boolean false is server truth and must be carried, not dropped.
    assert.deepEqual(notMatched.payload, { matchesIntent: false, intentLabel: 'Party' });
  });

  test('§14: an ABSENT match is not carried as false (no intent this request)', () => {
    // matchesIntent absent ⇒ the request had no live intent; the payload must
    // stay undefined so a why-line renders nothing rather than "does not match".
    assert.equal(projectCompassResult(REC)!.payload, undefined);
    // A present match with a blank label normalises the label to null.
    const obj = projectCompassResult({
      ...REC,
      data: { ...REC.data, matchesIntent: true, intentLabel: '  ' },
    })!;
    assert.deepEqual(obj.payload, { matchesIntent: true, intentLabel: null });
  });

  test('it invents no intelligence (spec §37)', () => {
    const obj = projectCompassResult(REC)!;
    assert.equal(obj.confidence, undefined);
    assert.equal(obj.freshness, undefined);
    assert.equal(obj.activity, undefined);
    assert.equal(obj.provenance, undefined);
  });

  test('coordinates are never invented', () => {
    assert.equal(projectCompassResult({ ...REC, data: {} }), null);
    assert.equal(projectCompassResult({ ...REC, data: { lat: 1 } }), null);
    assert.equal(projectCompassResult({ ...REC, data: null }), null);
  });

  test('an unmapped Compass type is dropped, never rendered as an untyped dot', () => {
    assert.equal(projectCompassResult({ ...REC, type: 'weather' }), null);
    assert.equal(projectCompassResult({ ...REC, type: null }), null);
  });

  test('person-shaped kinds fail closed to a non-identifying rung', () => {
    // §23: nothing here may render at a precision Compass never stated.
    assert.equal(projectCompassResult(REC)!.privacyClass, 'approximate');
    assert.equal(projectCompassResult({ ...REC, type: 'traveler' })!.privacyClass, 'aggregate_only');
    assert.equal(mayRenderIdentity('aggregate_only'), false);
  });

  test('a title is always present — isRenderable drops empty ones', () => {
    const obj = projectCompassResult({ ...REC, title: null })!;
    assert.equal(obj.title, REC.category);
    assert.ok(isRenderable(projectCompassResult({ ...REC, title: null, category: null })!));
  });
});
