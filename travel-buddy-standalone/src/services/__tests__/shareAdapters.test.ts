/**
 * shareAdapters.test.ts — normalization correctness + canonicalUrl shape.
 *
 * Covers, per the Phase 2a brief:
 *   A. Every adapter produces a well-formed ShareableEntity (required fields
 *      present, title never empty, entityType correct).
 *   B. canonicalUrl shape — absolute, on the canonical origin, correct path
 *      segment, id percent-encoded. No adapter emits a bare path or a domain
 *      literal.
 *   C. The two redirecting adapters: postcard → the post's URL,
 *      compass_recommendation → the wrapped item's URL, both keeping their
 *      own entityType.
 *   D. Fallbacks and absent data — missing titles, missing ids, missing
 *      handles, unshareable compass item types.
 *   E. allowedActions/allowedDestinations are internally consistent with the
 *      registry.
 *
 * Run: node --import tsx/esm --test src/services/__tests__/shareAdapters.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CANONICAL_APP_URL } from '../../constants/canonicalUrl.ts';
import {
  toShareablePostcard,
  toShareableTrip,
  toShareablePlace,
  toShareableProfile,
  toShareableEvent,
  toShareableMemory,
  toShareableStamp,
  toShareableSharedMoment,
  toShareableCompassRecommendation,
  toShareableBuddyProfile,
  ENTITY_PATHS,
  entityUrl,
} from '../shareAdapters.ts';
import {
  SHARE_ACTION_REGISTRY,
  ALL_SHARE_ACTION_IDS,
  resolveShareActions,
  resolveDestinationActions,
  shareActionLabel,
  DESTINATION_TIER_ACTION_IDS,
} from '../shareActionRegistry.ts';
import type { ShareableEntity } from '../../types/models.ts';

// Adapters read process.env through canonicalUrl() at call time; with neither
// override set, every URL below must sit on CANONICAL_APP_URL.
delete process.env.EXPO_PUBLIC_WEB_ORIGIN;
delete process.env.EXPO_PUBLIC_API_BASE_URL;

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ── Fixtures — minimal, cast at the boundary so a domain-type change that
// matters (a renamed field an adapter reads) still fails the build.
const postcard = {
  id: 'pc-1', postId: ID, mediaUrl: 'https://cdn/x.jpg', caption: 'Sunrise at Batad',
  locationName: 'Batad Rice Terraces', locationCity: 'Banaue', locationCountry: 'Philippines',
  locationVerified: true, stampEligible: true, visibility: 'public', status: 'active',
  pinnedAt: null, note: null, createdAt: '2026-01-01T00:00:00Z',
} as unknown as Parameters<typeof toShareablePostcard>[0];

const trip = {
  id: ID, title: 'Luzon loop', destinationCity: 'Manila', destinationCountry: 'Philippines',
  neighborhoods: [], startDate: '2026-02-01', endDate: '2026-02-10', nights: 9,
  status: 'planning', visibility: 'public', travelStyle: 'solo', openToMeet: true,
  coverUrl: 'https://cdn/trip.jpg', progress: 0, progressSteps: [], timeline: [],
  savedIdeas: [], safetyStatus: 'ok', tripNotes: 'Bring a rain shell.',
} as unknown as Parameters<typeof toShareableTrip>[0];

const place = {
  id: ID, name: 'Time Out Market', category: 'food',
  coordinates: { lat: 38.7, lng: -9.1 }, address: 'Av. 24 de Julho',
  formattedAddress: 'Av. 24 de Julho 49, Lisbon', city: 'Lisbon', neighborhood: 'Cais do Sodré',
  countryCode: 'PT', status: 'active', detailRoute: `/place/${ID}`,
  headerImageUrl: 'https://cdn/place.jpg',
} as unknown as Parameters<typeof toShareablePlace>[0];

const profile = {
  id: ID, username: 'wanderer', displayName: 'Wan Derer', bio: 'Chasing sunsets.',
  avatarUrl: 'https://cdn/a.jpg', homeCity: 'Lisbon', homeCountry: 'Portugal',
  travelStyle: 'solo', interests: [], verified: true, verificationStatus: 'verified',
  verifiedAt: null, passportVisibility: 'public', createdAt: null,
} as unknown as Parameters<typeof toShareableProfile>[0];

const event = {
  id: ID, hostId: 'host-1', hostName: 'Ana', hostHandle: 'ana', hostAvatarUrl: null,
  title: 'Jazz Night', description: 'Live sets until 2am.', locationName: 'Hot Clube',
  locationLat: null, locationLng: null, startsAt: '2026-03-01T20:00:00Z', endsAt: null,
  coverUrl: 'https://cdn/e.jpg', coverMediaType: 'image', maxAttendees: null,
  ageMin: null, ageMax: null, trustScoreMin: null, verifiedOnly: false,
  visibility: 'public', state: 'open', chatEnabled: true, chatThreadId: null,
  waitlistEnabled: false, priceType: 'free', priceUrl: null, rsvpOptions: [],
  goingCount: 3, waitlistCount: 0, category: 'nightlife', city: 'Lisbon', country: 'PT',
  rsvpClosed: false, showExactLocation: true, isHost: false,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
} as unknown as Parameters<typeof toShareableEvent>[0];

const memory = {
  id: ID, ownerId: 'u-1', title: 'First night out', caption: 'We got lost twice.',
  visibility: 'public', allowedUserIds: [], hiddenUserIds: [], tripId: null, eventId: null,
  placeId: null, locationCity: 'Lisbon', locationCountry: 'PT', locationLat: null,
  locationLng: null, canonicalLocationId: null, startsAt: null, endsAt: null,
  state: 'published', createdAt: '2026-01-01T00:00:00Z', updatedAt: null,
  cover: { mediaUrl: 'https://cdn/m.jpg', mediaType: 'image' },
  owner: { id: 'u-1', name: 'Ana', handle: 'ana', avatarUrl: null },
} as unknown as Parameters<typeof toShareableMemory>[0];

const stamp = {
  id: ID, stampDefinitionId: 'def-1',
  definition: { name: 'Lisbon Explorer', description: 'Visited 5 places.', rarity: 'rare' },
  stampType: 'city', country: 'PT', city: 'Lisbon', neighborhood: null,
  titleOverride: null, placeId: null, planId: null, tripId: null, sourceType: 'auto',
  verificationLevel: 'verified', visibility: 'public', displayOnPassport: true,
  isRevoked: false, earnedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
  catalogId: null, activeArtworkUrl: 'https://cdn/s.png', thumbnailUrl: null,
} as unknown as Parameters<typeof toShareableStamp>[0];

const moment = {
  id: ID, title: 'Rooftop sunset', description: 'Everyone bring something.',
  placeDayId: null, placeId: null, tripId: null, joinPolicy: 'invite_only',
  status: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  role: 'owner',
} as unknown as Parameters<typeof toShareableSharedMoment>[0];

const buddy = {
  id: ID, userId: 'u-9', displayName: 'Ana', tagline: 'Lisbon born and raised',
  bio: 'Food tours and fado.', languages: ['pt', 'en'], city: 'Lisbon', country: 'PT',
  categories: [], hourlyRateUsd: 30, status: 'active', verified: true, verifiedAt: null,
  averageRating: 4.9, reviewCount: 22, responseTimeH: 2,
  coverPhotoUrl: 'https://cdn/b.jpg', galleryUrls: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
} as unknown as Parameters<typeof toShareableBuddyProfile>[0];

// ── Shared assertions ────────────────────────────────────────────────────────

/** Every adapter's output must satisfy this, whatever the entity. */
function assertWellFormed(e: ShareableEntity) {
  assert.ok(e.entityType, 'entityType present');
  assert.ok(e.entityId, 'entityId present');
  assert.equal(typeof e.title, 'string');
  assert.notEqual(e.title.trim(), '', 'title is never empty');
  assert.ok(e.metadata && typeof e.metadata === 'object', 'metadata is an object');
  assert.ok(Array.isArray(e.allowedDestinations));
  assert.ok(Array.isArray(e.allowedActions));
  assert.ok(e.allowedActions.length > 0, 'at least one action');
  for (const a of e.allowedActions) {
    assert.ok(SHARE_ACTION_REGISTRY[a], `action "${a}" exists in the registry`);
  }
  if (e.canonicalUrl !== null) {
    assert.ok(e.canonicalUrl.startsWith(`${CANONICAL_APP_URL}/`), `absolute canonical URL: ${e.canonicalUrl}`);
    assert.ok(!e.canonicalUrl.includes('travelbuddy.app'), 'no legacy domain');
  }
  // 'external' only makes sense when there is something to open.
  assert.equal(e.allowedDestinations.includes('external'), e.canonicalUrl !== null);
}

const ALL: Array<[string, ShareableEntity]> = [
  ['postcard',   toShareablePostcard(postcard)],
  ['trip',       toShareableTrip(trip)],
  ['place',      toShareablePlace(place)],
  ['profile',    toShareableProfile(profile)],
  ['event',      toShareableEvent(event)],
  ['memory',     toShareableMemory(memory)],
  ['stamp',      toShareableStamp(stamp)],
  ['moment',     toShareableSharedMoment(moment)],
  ['compass',    toShareableCompassRecommendation({ id: ID, type: 'place', category: 'food', title: 'Time Out Market' })],
  ['buddy',      toShareableBuddyProfile(buddy)],
];

// ── A + B. shape and URLs ────────────────────────────────────────────────────

describe('A: every adapter produces a well-formed entity', () => {
  for (const [name, entity] of ALL) {
    it(`${name} is well-formed`, () => assertWellFormed(entity));
  }

  it('covers all ten adapters', () => {
    assert.equal(ALL.length, 10);
    const types = new Set(ALL.map(([, e]) => e.entityType));
    // postcard and compass_recommendation are distinct types despite
    // redirecting elsewhere, so all ten entries are distinct.
    assert.equal(types.size, 10);
  });
});

describe('B: canonicalUrl shape', () => {
  it('uses the right path segment for each entity', () => {
    assert.equal(toShareableTrip(trip).canonicalUrl,    `${CANONICAL_APP_URL}/trips/${ID}`);
    assert.equal(toShareablePlace(place).canonicalUrl,  `${CANONICAL_APP_URL}/place/${ID}`);
    assert.equal(toShareableEvent(event).canonicalUrl,  `${CANONICAL_APP_URL}/event/${ID}`);
    assert.equal(toShareableMemory(memory).canonicalUrl, `${CANONICAL_APP_URL}/memory/${ID}`);
    assert.equal(toShareableStamp(stamp).canonicalUrl,  `${CANONICAL_APP_URL}/stamp/${ID}`);
    assert.equal(toShareableSharedMoment(moment).canonicalUrl, `${CANONICAL_APP_URL}/shared-moments/${ID}`);
    assert.equal(toShareableBuddyProfile(buddy).canonicalUrl, `${CANONICAL_APP_URL}/buddy/${ID}`);
  });

  it('profile uses /u/:username — not /profile/:handle or /passport/:username', () => {
    const url = toShareableProfile(profile).canonicalUrl;
    assert.equal(url, `${CANONICAL_APP_URL}/u/wanderer`);
    assert.ok(!url!.includes('/profile/'), '/profile/:handle is a redirect alias');
    assert.ok(!url!.includes('/passport/'), '/passport/:username is the web presentation route');
  });

  it('percent-encodes the id', () => {
    assert.equal(entityUrl('place', 'a b/c'), `${CANONICAL_APP_URL}/place/a%20b%2Fc`);
  });

  it('returns null rather than a dangling path for a missing id', () => {
    assert.equal(entityUrl('post', null), null);
    assert.equal(entityUrl('post', ''), null);
    assert.equal(entityUrl('post', '   '), null);
  });

  it('honours EXPO_PUBLIC_WEB_ORIGIN so a domain swap needs no adapter change', () => {
    process.env.EXPO_PUBLIC_WEB_ORIGIN = 'https://portava.example';
    try {
      assert.equal(toShareableEvent(event).canonicalUrl, `https://portava.example/event/${ID}`);
    } finally {
      delete process.env.EXPO_PUBLIC_WEB_ORIGIN;
    }
  });

  it('the path map is the only source of paths', () => {
    // Every ENTITY_PATHS entry produces a leading-slash relative path.
    for (const [kind, build] of Object.entries(ENTITY_PATHS)) {
      const p = build('x');
      assert.ok(p.startsWith('/'), `${kind} path starts with /`);
      assert.ok(!p.includes('://'), `${kind} path carries no origin`);
    }
  });
});

// ── C. the two redirecting adapters ──────────────────────────────────────────

describe('C: postcard resolves to its post', () => {
  it('emits the post URL but keeps entityType=postcard', () => {
    const e = toShareablePostcard(postcard);
    assert.equal(e.entityType, 'postcard', 'type survives for preview + analytics');
    assert.equal(e.entityId, 'pc-1', 'entityId is the postcard, not the post');
    assert.equal(e.canonicalUrl, `${CANONICAL_APP_URL}/posts/${ID}`);
    assert.equal(e.metadata.postId, ID);
    assert.equal(e.metadata.resolvesTo, 'post');
  });

  it('normalizes caption, location and image', () => {
    const e = toShareablePostcard(postcard);
    assert.equal(e.title, 'Sunrise at Batad');
    assert.equal(e.subtitle, 'Batad Rice Terraces · Banaue, Philippines');
    assert.equal(e.imageUrl, 'https://cdn/x.jpg');
    assert.deepEqual(e.location, { city: 'Banaue', country: 'Philippines', name: 'Batad Rice Terraces' });
  });

  it('carries a creator only when one is supplied', () => {
    assert.equal(toShareablePostcard(postcard).creator, null);
    const withCreator = toShareablePostcard(postcard, {
      id: 'u-1', username: 'ana', displayName: 'Ana', avatarUrl: null,
    });
    assert.equal(withCreator.creator?.username, 'ana');
  });
});

describe('C: compass recommendation unwraps to the item it recommends', () => {
  const cases: Array<[string, string]> = [
    ['event',      `${CANONICAL_APP_URL}/event/${ID}`],
    ['place',      `${CANONICAL_APP_URL}/place/${ID}`],
    ['buddy',      `${CANONICAL_APP_URL}/buddy/${ID}`],
    ['post',       `${CANONICAL_APP_URL}/posts/${ID}`],
    ['hidden_gem', `${CANONICAL_APP_URL}/gems/${ID}`],
    ['trip',       `${CANONICAL_APP_URL}/trips/${ID}`],
  ];

  for (const [type, expected] of cases) {
    it(`itemType "${type}" resolves to ${expected.replace(CANONICAL_APP_URL, '')}`, () => {
      const e = toShareableCompassRecommendation({ id: ID, type, category: 'x', title: 'T' });
      assert.equal(e.entityType, 'compass_recommendation', 'type survives the unwrap');
      assert.equal(e.canonicalUrl, expected);
      assert.equal(e.metadata.itemType, type);
    });
  }

  it('covers every itemType observed in production', () => {
    // compass_served_recommendations, 86 rows: event 47, place 18, buddy 17, post 4.
    for (const t of ['event', 'place', 'buddy', 'post']) {
      assert.ok(
        toShareableCompassRecommendation({ id: ID, type: t, category: 'x' }).canonicalUrl,
        `${t} must resolve`,
      );
    }
  });

  it('yields a null URL for item types that are not shareable entities', () => {
    for (const t of ['booking', 'suggestion', 'message', 'wat']) {
      const e = toShareableCompassRecommendation({ id: ID, type: t, category: 'x' });
      assert.equal(e.canonicalUrl, null, `${t} has no route`);
      assert.equal(e.metadata.resolvesTo, null);
      assert.ok(!e.allowedDestinations.includes('external'), 'nothing to open externally');
      assert.ok(e.allowedDestinations.includes('dm'), 'still sendable as an in-app card');
    }
  });

  it('keeps the per-user token out of the URL', () => {
    const e = toShareableCompassRecommendation(
      { id: ID, type: 'place', category: 'food' },
      { recommendationToken: 'SIGNED.TOKEN.VALUE' },
    );
    assert.equal(e.metadata.recommendationToken, 'SIGNED.TOKEN.VALUE');
    assert.ok(!e.canonicalUrl!.includes('SIGNED'), 'token is per-user; never in a shared link');
  });
});

// ── D. fallbacks and absent data ─────────────────────────────────────────────

describe('D: fallbacks', () => {
  it('falls back rather than emitting an empty title', () => {
    const bare = toShareableSharedMoment({ ...moment, title: '   ' } as typeof moment);
    assert.equal(bare.title, 'Shared moment');

    const noName = toShareablePlace({ ...place, name: '' } as typeof place);
    assert.equal(noName.title, 'Place');

    const noCaption = toShareablePostcard({
      ...postcard, caption: null, locationName: null,
    } as unknown as typeof postcard);
    assert.equal(noCaption.title, 'Banaue, Philippines', 'falls through to location');
  });

  it('stamp title falls back title_override → definition name → location', () => {
    assert.equal(toShareableStamp(stamp).title, 'Lisbon Explorer');
    assert.equal(
      toShareableStamp({ ...stamp, titleOverride: 'My Lisbon' } as typeof stamp).title,
      'My Lisbon',
    );
    assert.equal(
      toShareableStamp({ ...stamp, definition: null } as unknown as typeof stamp).title,
      'Lisbon, PT',
    );
  });

  it('a handle-less profile is not shareable by URL', () => {
    const e = toShareableProfile({ ...profile, username: null } as typeof profile);
    assert.equal(e.canonicalUrl, null, 'no /u/<uuid> — the landing page strips uuid dashes');
    assert.equal(e.title, 'Wan Derer', 'still previewable in-app');
    assert.ok(!e.allowedDestinations.includes('external'));
  });

  it('omits location entirely when there is none', () => {
    assert.equal(toShareableSharedMoment(moment).location, null);
    assert.equal(
      toShareableMemory({ ...memory, locationCity: null, locationCountry: null } as typeof memory).location,
      null,
    );
  });

  it('places have no creator; events and memories carry theirs', () => {
    assert.equal(toShareablePlace(place).creator, null);
    assert.equal(toShareableEvent(event).creator?.username, 'ana');
    assert.equal(toShareableMemory(memory).creator?.displayName, 'Ana');
    assert.equal(
      toShareableMemory({ ...memory, owner: null } as typeof memory).creator,
      null,
    );
  });

  it('trip metadata exposes the plan alias', () => {
    assert.equal(toShareableTrip(trip).metadata.planUrl, `${CANONICAL_APP_URL}/plan/${ID}`);
  });
});

// ── E. registry consistency + the §8 action lists ────────────────────────────

describe('E: action registry', () => {
  it('every declared id has a descriptor and every descriptor is reachable', () => {
    for (const id of ALL_SHARE_ACTION_IDS) {
      const d = SHARE_ACTION_REGISTRY[id];
      assert.ok(d, `${id} has a descriptor`);
      assert.equal(d.id, id);
      assert.ok(d.label.trim(), `${id} has a label`);
      assert.ok(d.icon.trim(), `${id} has an icon`);
      assert.ok(d.evidence.trim(), `${id} cites its source line or call site`);
      assert.ok(['spec', 'spec-label', 'production'].includes(d.source), `${id} declares provenance`);
    }
    assert.equal(Object.keys(SHARE_ACTION_REGISTRY).length, ALL_SHARE_ACTION_IDS.length);
  });

  it('carries the five ids §8 names verbatim, marked source=spec', () => {
    const named = ['add_to_trip', 'send_to_circle', 'share_to_pulse', 'add_to_shared_moment', 'invite_to_trip'] as const;
    for (const id of named) {
      assert.ok(SHARE_ACTION_REGISTRY[id], `${id} is registered`);
      assert.equal(SHARE_ACTION_REGISTRY[id].source, 'spec', `${id} is spec-named`);
    }
    const specNamed = ALL_SHARE_ACTION_IDS.filter((id) => SHARE_ACTION_REGISTRY[id].source === 'spec');
    assert.equal(specNamed.length, named.length, 'exactly five ids claim to be spec-named');
  });

  it('every action an adapter declares is in the registry', () => {
    const used = new Set(ALL.flatMap(([, e]) => e.allowedActions));
    for (const id of used) assert.ok(SHARE_ACTION_REGISTRY[id], `${id} is registered`);
  });

  it('every send action targets a real destination', () => {
    for (const id of ALL_SHARE_ACTION_IDS) {
      const d = SHARE_ACTION_REGISTRY[id];
      if (d.group !== 'send') continue;
      assert.ok(d.destination, `${id} declares a destination`);
      assert.ok(d.requiresRecipient, `${id} needs a recipient picked`);
    }
  });
});

describe('E: §8 per-entity action lists', () => {
  // The five entity types §8 covers, transcribed literally.
  const SPEC: Array<[string, string[]]> = [
    ['place',    ['send_to_trip_crew', 'recommend_to_traveler', 'add_to_trip', 'save_to_trip', 'add_to_shared_moment']],
    ['postcard', ['send_to_traveler', 'share_to_pulse', 'add_to_shared_moment', 'add_to_trip']],
    ['profile',  ['send_to_traveler', 'recommend_to_traveler', 'invite_to_trip', 'invite_to_plan']],
    // "Copy Trip Link" is destination-tier, so it is NOT in allowedActions;
    // it comes from resolveDestinationActions with the trip label override.
    ['trip',     ['send_to_traveler', 'share_to_pulse', 'invite_traveler']],
    ['event',    ['send_to_traveler', 'send_to_circle', 'share_to_pulse', 'invite_traveler']],
  ];

  const byType = new Map(ALL.map(([, e]) => [e.entityType, e]));

  for (const [type, expected] of SPEC) {
    it(`${type} declares exactly the §8 actions`, () => {
      const e = byType.get(type as never)!;
      assert.ok(e, `${type} adapter exists`);
      assert.deepEqual([...e.allowedActions].sort(), [...expected].sort());
    });
  }

  it('place keeps add_to_trip and save_to_trip distinct', () => {
    // §8 lists both on Place: one writes a trip_plan_items row, the other a
    // saved idea. Collapsing them would silently drop a specced action.
    const e = toShareablePlace(place);
    assert.ok(e.allowedActions.includes('add_to_trip'));
    assert.ok(e.allowedActions.includes('save_to_trip'));
  });

  it('profile invite_to_trip and trip invite_traveler are inverse directions', () => {
    // Entity is the person → pick a trip. Entity is the trip → pick a person.
    assert.ok(toShareableProfile(profile).allowedActions.includes('invite_to_trip'));
    assert.ok(toShareableTrip(trip).allowedActions.includes('invite_traveler'));
    assert.ok(!toShareableTrip(trip).allowedActions.includes('invite_to_trip'));
  });
});

describe('E: per-entity labels', () => {
  it('applies the §8 copy overrides', () => {
    assert.equal(shareActionLabel('send_to_traveler', 'trip'), 'Send to Traveler');
    assert.equal(shareActionLabel('send_to_traveler', 'profile'), 'Send Profile');
    assert.equal(shareActionLabel('send_to_traveler', 'postcard'), 'Send through Telegraph');
    assert.equal(shareActionLabel('recommend_to_traveler', 'place'), 'Recommend to someone');
    assert.equal(shareActionLabel('recommend_to_traveler', 'profile'), 'Recommend Buddy');
    assert.equal(shareActionLabel('copy_link', 'trip'), 'Copy Trip Link');
    assert.equal(shareActionLabel('copy_link', 'stamp'), 'Copy link', 'falls back to the default');
  });

  it('resolveShareActions hands the sheet a ready label', () => {
    const e = toShareableProfile(profile);
    const resolved = resolveShareActions(e.allowedActions, {
      hasUrl: e.canonicalUrl !== null,
      entityType: e.entityType,
      allowedDestinations: e.allowedDestinations,
    });
    const labels = resolved.map((d) => d.resolvedLabel);
    assert.deepEqual(labels, ['Send Profile', 'Recommend Buddy', 'Invite to Trip', 'Invite to Plan']);
  });
});

describe('E: resolveShareActions preconditions', () => {
  it('never yields a destination-tier action from allowedActions', () => {
    // Even if an adapter regressed and declared one, resolveShareActions must
    // not render it contextually — it would appear twice in the sheet.
    const ids = resolveShareActions(
      ['send_to_traveler', 'copy_link', 'share_external'],
      { hasUrl: true, entityType: 'trip' },
    ).map((d) => d.id);
    assert.deepEqual(ids, ['send_to_traveler']);
  });

  it('drops a send action whose destination the entity does not permit', () => {
    const e = toShareableEvent(event);
    const ids = resolveShareActions(e.allowedActions, {
      hasUrl: true,
      entityType: 'event',
      allowedDestinations: ['dm', 'external'],   // no circle
    }).map((d) => d.id);
    assert.ok(ids.includes('send_to_traveler'), 'dm is permitted');
    assert.ok(!ids.includes('send_to_circle'), 'circle is not');
  });

  it('sorts send → collect → invite → direct → secondary', () => {
    const e = toShareableEvent(event);
    const ids = resolveShareActions(e.allowedActions, {
      hasUrl: true,
      entityType: 'event',
      allowedDestinations: e.allowedDestinations,
    }).map((d) => d.id);
    assert.deepEqual(ids, ['send_to_traveler', 'send_to_circle', 'share_to_pulse', 'invite_traveler']);
  });

  it('ignores unknown ids instead of throwing', () => {
    const ids = resolveShareActions(
      ['send_to_traveler', 'not_an_action' as never],
      { hasUrl: true, entityType: 'trip' },
    ).map((d) => d.id);
    assert.deepEqual(ids, ['send_to_traveler']);
  });
});

// ── F. destination tier (14a) ────────────────────────────────────────────────

describe('F: external and copy_link are destinations, not contextual actions', () => {
  it('no adapter declares a destination-tier action', () => {
    for (const [name, e] of ALL) {
      for (const id of DESTINATION_TIER_ACTION_IDS) {
        assert.ok(
          !e.allowedActions.includes(id),
          `${name} must not declare ${id} — it is universal, not contextual`,
        );
      }
    }
  });

  it('exactly copy_link and share_external are destination-tier', () => {
    assert.deepEqual([...DESTINATION_TIER_ACTION_IDS].sort(), ['copy_link', 'share_external']);
    for (const id of ALL_SHARE_ACTION_IDS) {
      const expected = DESTINATION_TIER_ACTION_IDS.includes(id) ? 'destination' : 'contextual';
      assert.equal(SHARE_ACTION_REGISTRY[id].tier, expected, `${id} tier`);
    }
  });

  it("allowedDestinations includes 'external' exactly when there is a URL", () => {
    for (const [name, e] of ALL) {
      assert.equal(
        e.allowedDestinations.includes('external'),
        e.canonicalUrl !== null,
        `${name}: external ⟺ canonicalUrl`,
      );
    }
  });

  it("a linkless compass recommendation has no 'external' and no destination row", () => {
    for (const t of ['booking', 'suggestion', 'message']) {
      const e = toShareableCompassRecommendation({ id: ID, type: t, category: 'x' });
      assert.equal(e.canonicalUrl, null);
      assert.ok(!e.allowedDestinations.includes('external'), `${t}: no external destination`);
      assert.deepEqual(
        resolveDestinationActions({ hasUrl: false, entityType: e.entityType }),
        [],
        `${t}: nothing to copy, nothing to hand the OS`,
      );
      assert.ok(e.allowedDestinations.includes('dm'), `${t}: still sendable in-app`);
    }
  });

  it('every entity with a URL gets the same two-item destination row', () => {
    for (const [name, e] of ALL) {
      if (e.canonicalUrl === null) continue;
      const ids = resolveDestinationActions({ hasUrl: true, entityType: e.entityType }).map((d) => d.id);
      assert.deepEqual(ids, ['copy_link', 'share_external'], `${name} destination row`);
    }
  });

  it('keeps the trip → "Copy Trip Link" label override', () => {
    const t = toShareableTrip(trip);
    const row = resolveDestinationActions({ hasUrl: true, entityType: t.entityType });
    assert.equal(row[0].resolvedLabel, 'Copy Trip Link');
    // Everything else keeps the default.
    const s = toShareableStamp(stamp);
    assert.equal(
      resolveDestinationActions({ hasUrl: true, entityType: s.entityType })[0].resolvedLabel,
      'Copy link',
    );
  });

  it('recommend_to_traveler carries the unresolved-schema TODO', () => {
    // 14a: the action is send-shaped and no recommendation record exists.
    // If this assertion is deleted, the TODO should have been resolved first.
    const d = SHARE_ACTION_REGISTRY.recommend_to_traveler;
    assert.equal(d.tier, 'contextual');
    assert.equal(d.destination, 'dm', 'currently indistinguishable from a DM send');
  });
});
