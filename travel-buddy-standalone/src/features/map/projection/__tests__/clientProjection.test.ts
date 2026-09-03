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

import type { HiddenGem } from '../../../../services/hiddenGems.ts';

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
import {
  buddyDto,
  eventDto,
  friendDto,
  gemDto,
  tripDto,
} from '../../../../__fixtures__/mapEntities.ts';

const NOW = Date.parse('2026-08-31T21:00:00.000Z');

// The DTOs come from src/__fixtures__/mapEntities.ts, where they are TYPED
// (`BuddyProfile`, `TripRow`, …) and therefore typechecked. This file used to
// declare its own untyped literals, and three of them carried fields the DTOs
// have never had — `buddy.headline`, `trip.destination`, `friend.displayName` /
// `friend.handle`. tsconfig excludes `**/*.test.ts` from the typecheck, so the
// compiler never saw them; the projectors read those names, got undefined, and
// these tests asserted the resulting emptiness as if it were correct behaviour.
const BUDDY = buddyDto;
const TRIP = tripDto;
const FRIEND = friendDto;
const GEM = gemDto;
const EVENT = eventDto;

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
    // [lng, lat] per RFC 7946 — read off the DTO so the fixture and the
    // assertion cannot drift apart.
    assert.deepEqual(projectBuddy(BUDDY)!.geometry, {
      type: 'Point',
      coordinates: [BUDDY.meetupBaseLng, BUDDY.meetupBaseLat],
    });
    assert.deepEqual(projectFriend(FRIEND)!.geometry, {
      type: 'Point',
      coordinates: [FRIEND.lng, FRIEND.lat],
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
    assert.equal(projectGemLocal({ ...GEM, coordsPrecision: null as unknown as HiddenGem['coordsPrecision'] })!.privacyClass, 'approximate');
    assert.equal(projectGemLocal({ ...GEM, coordsPrecision: 'unknown' as unknown as HiddenGem['coordsPrecision'] })!.privacyClass, 'approximate');
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
    const later = projectEventLocal({ ...EVENT, startsAt: '2026-09-01T20:00:00.000Z' }, NOW)!;
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
    const { status: _status, ...noStatus } = GEM;
    assert.ok(projectGemLocal(noStatus as HiddenGem) !== null);
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
      projectBuddy({ ...BUDDY, displayName: null })!,
      projectTrip({ ...TRIP, title: null as unknown as string })!,
      projectFriend({ ...FRIEND, name: null })!,
      projectGemLocal({ ...GEM, name: null as unknown as string })!,
      projectEventLocal({ ...EVENT, title: null as unknown as string }, NOW)!,
    ]) {
      assert.ok(obj.title.trim().length > 0, `empty title on ${obj.id}`);
      assert.ok(isRenderable(obj));
    }
  });

  test('subtitle is undefined rather than an empty or dangling separator', () => {
    assert.equal(projectBuddy({ ...BUDDY, city: null as unknown as string, tagline: null })!.subtitle, undefined);
    assert.equal(projectGemLocal({ ...GEM, category: null as unknown as HiddenGem['category'], city: null as unknown as string })!.subtitle, undefined);
    // One present part must not carry the separator.
    assert.equal(projectGemLocal({ ...GEM, category: null as unknown as HiddenGem['category'] })!.subtitle, 'Da Nang');
  });

  test('a trip with only one date still renders a legible range', () => {
    assert.match(projectTrip({ ...TRIP, endDate: null })!.subtitle!, /2026-04-12 → \?/);
  });
});

// ── The fields the projectors read ────────────────────────────────────────────
//
// Every one of these guards a read that was previously spelled with a field name
// the DTO does not have. The projector found undefined, the card rendered a
// generic fallback, and nothing anywhere failed. They are asserted against the
// DTO's own value rather than a literal so a fixture change cannot make them
// vacuous.

describe('projectors read fields that exist on their DTOs', () => {
  test('a buddy subtitle carries the TAGLINE (BuddyProfile has no `headline`)', () => {
    const obj = projectBuddy(BUDDY)!;
    assert.ok(BUDDY.tagline, 'fixture must have a tagline for this to mean anything');
    assert.ok(
      obj.subtitle!.includes(BUDDY.tagline!),
      `subtitle "${obj.subtitle}" does not carry the tagline`,
    );
    // …and drops entirely when the tagline is the only part left.
    assert.equal(projectBuddy({ ...BUDDY, tagline: null }).subtitle, BUDDY.city);
  });

  test('a trip subtitle carries destinationCity (TripRow has no `destination`)', () => {
    const obj = projectTrip(TRIP)!;
    assert.ok(
      obj.subtitle!.includes(TRIP.destinationCity),
      `subtitle "${obj.subtitle}" does not carry the destination city`,
    );
  });

  test('a friend title is the member NAME (CircleMemberLocation has no displayName/handle)', () => {
    const obj = projectFriend(FRIEND)!;
    assert.equal(obj.title, FRIEND.name);
    // The bug this replaces titled EVERY circle pin "Friend".
    assert.notEqual(obj.title, 'Friend');
  });
});

// ── Payload shapes ────────────────────────────────────────────────────────────

describe('payloads are enumerated, not passed through', () => {
  test('a buddy payload carries the card fields and NOT the whole DTO', () => {
    const p = projectBuddy(BUDDY)!.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(p).sort(), [
      'averageRating', 'bio', 'buddyId', 'categories', 'city', 'country',
      'coverPhotoUrl', 'hourlyRateUsd', 'languages', 'responseTimeH',
      'reviewCount', 'userId',
    ]);
    // `buddyId` is the LISTING id, never the namespaced object id.
    assert.equal(p.buddyId, BUDDY.id);
    assert.notEqual(p.buddyId, projectBuddy(BUDDY)!.id);
    // Fields the card must not be able to reach for.
    assert.equal('galleryUrls' in p, false);
    assert.equal('status' in p, false);
  });

  test('a trip payload carries the card fields, keyed by the bare trip id', () => {
    const p = projectTrip(TRIP)!.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(p).sort(), [
      'coverUrl', 'destinationCity', 'destinationCountry', 'endDate',
      'startDate', 'tripId', 'visibility',
    ]);
    assert.equal(p.tripId, TRIP.id);
    assert.equal(p.visibility, TRIP.visibility);
  });

  test('a friend payload carries only userId, avatarUrl and city', () => {
    const p = projectFriend(FRIEND)!.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(p).sort(), ['avatarUrl', 'city', 'userId']);
    assert.equal(p.userId, FRIEND.userId);
  });

  test('a gem payload is the SERVER projectGem shape', () => {
    const p = projectGemLocal(GEM)!.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(p).sort(), [
      'category', 'city', 'coordsPrecision', 'thumbnailUrl', 'verificationLevel',
    ]);
    assert.equal(p.thumbnailUrl, GEM.imageUrl);
  });

  test('an event payload is the SERVER projectEvent shape', () => {
    const p = projectEventLocal(EVENT, NOW)!.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(p).sort(), [
      'coverUrl', 'hasStarted', 'locationName', 'startsAt', 'visibility',
    ]);
    assert.equal(p.hasStarted, true);
    assert.equal(projectEventLocal({ ...EVENT, startsAt: '2026-09-01T20:00:00.000Z' }, NOW)!
      .payload!.hasStarted, false);
  });
});

// ── Compass results ───────────────────────────────────────────────────────────

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

  test('it carries no payload — Compass sends no per-kind detail', () => {
    // A card must therefore render from title/subtitle alone rather than
    // reaching for fields a recommendation was never going to have.
    assert.equal(projectCompassResult(REC)!.payload, undefined);
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
