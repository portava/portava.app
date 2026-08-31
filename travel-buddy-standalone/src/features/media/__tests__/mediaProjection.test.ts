/**
 * features/media — projection service mapping + degrade tests.
 *
 * Verifies (a) the pure mappers coerce partial/garbage payloads into valid
 * domain objects without throwing, and (b) the transport degrades gracefully:
 * a 404 (parallel backend PR not deployed) becomes an EMPTY result, auth/network
 * failures are reported by kind, and nothing ever throws.
 *
 * Pure node:test suite — imports only the service + pure state helpers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapMediaProjection,
  mapWorldProjection,
  mapCityVisualZone,
  mapPlaceCurrentView,
  isPlaceViewEmpty,
  mapExperienceProjection,
  buildExperienceChain,
  mapHiddenGemMedia,
  mapPeopleProjection,
  mapMyWorldLibrary,
  isMyWorldEmpty,
  fetchWorld,
  fetchPlaceView,
  fetchExperience,
  fetchExperiencesByIds,
  fetchPeople,
  fetchMyWorld,
  _setTestFreshToken,
  _clearTestFreshToken,
} from '../services/mediaProjection.ts';
import { isWorldProjectionEmpty } from '../state/worldState.ts';

// ── Mapper: media projection ──────────────────────────────────────────────────

test('mapMediaProjection coerces a full payload', () => {
  const m = mapMediaProjection({
    id: 'm1',
    mediaType: 'video',
    thumbnailUrl: 'post-media/x.jpg',
    observationClass: 'observed',
    freshness: 'fresh',
    ageMinutes: 4,
    perspectiveKey: 'street',
    contributor: { id: 'u1', displayName: 'Maya', verified: true, trustLabel: 'Trusted nightlife contributor' },
    place: { id: 'p1', name: 'An Thuong' },
    note: "It's filling up fast.",
    compassExplanation: 'Nightlife matches your intent',
  });
  assert.equal(m.id, 'm1');
  assert.equal(m.mediaType, 'video');
  assert.equal(m.observationClass, 'observed');
  assert.equal(m.freshness, 'fresh');
  assert.equal(m.contributor?.displayName, 'Maya');
  assert.equal(m.contributor?.verified, true);
  assert.equal(m.place?.name, 'An Thuong');
  // whyThis falls back to compassExplanation when whyThis is absent.
  assert.equal(m.whyThis, 'Nightlife matches your intent');
});

test('mapMediaProjection defaults every field on garbage input', () => {
  for (const bad of [null, undefined, 42, 'str', [], {}]) {
    const m = mapMediaProjection(bad);
    assert.equal(m.id, '');
    assert.equal(m.mediaType, 'image'); // safe default
    assert.equal(m.observationClass, 'observed');
    assert.equal(m.contributor, null);
    assert.equal(m.place, null);
  }
});

test('mapMediaProjection rejects an unknown observationClass and falls back', () => {
  const m = mapMediaProjection({ id: 'x', observationClass: 'viral' });
  assert.equal(m.observationClass, 'observed');
});

// ── Mapper: city visual zone ──────────────────────────────────────────────────

test('mapCityVisualZone maps an explicit-state zone (fixture shape)', () => {
  const z = mapCityVisualZone({ id: 'z1', name: 'An Thuong', state: 'building', trend: 'rising' });
  assert.equal(z?.name, 'An Thuong');
  assert.equal(z?.state, 'building');
  assert.equal(z?.trend, 'rising');
});

test('mapCityVisualZone NEVER fabricates a state/trend when the server omits them (§46)', () => {
  // Real §43 zone: label + placeId + perspectiveCount, NO state/trend (no live claim).
  const z = mapCityVisualZone({ placeId: 'p1', label: 'Riverside', perspectiveCount: 4, freshness: 'fresh' });
  assert.equal(z?.id, 'p1'); // id ← placeId
  assert.equal(z?.name, 'Riverside'); // name ← label
  assert.equal(z?.state, null); // NOT invented
  assert.equal(z?.trend, null); // NOT invented
  assert.equal(z?.perspectiveCount, 4);
  assert.equal(z?.freshness, 'fresh');
});

test('mapCityVisualZone derives a state ONLY from a gated live crowd label', () => {
  const z = mapCityVisualZone({ placeId: 'p2', label: 'An Thuong', liveCrowdLabel: 'packed' });
  assert.equal(z?.state, 'peak'); // packed → peak
  const z2 = mapCityVisualZone({ placeId: 'p3', label: 'My Khe', liveCrowdLabel: 'wat' });
  assert.equal(z2?.state, null); // unknown crowd label → no fabricated state

  assert.equal(mapCityVisualZone({}), null); // no name → dropped
  assert.equal(mapCityVisualZone(7), null);
});

// ── Mapper: world projection ──────────────────────────────────────────────────

test('mapWorldProjection maps a full dashboard payload', () => {
  const w = mapWorldProjection({
    city: { id: 'c1', name: 'Da Nang', timezone: 'Asia/Ho_Chi_Minh' },
    cityVisualState: [
      { id: 'a', name: 'An Thuong', state: 'building', trend: 'rising' },
      { id: 'b', name: 'Beach Festival', state: 'peak', trend: 'steady' },
      'garbage', // dropped
    ],
    forYouNow: [{ category: 'Nightlife', count: 18, kind: 'fresh_perspectives' }],
    changingNow: [{ id: 'x', title: 'An Thuong', state: 'building', trend: 'rising', freshness: 'fresh' }],
    generatedAt: '2026-08-31T10:00:00Z',
  });
  assert.equal(w.city?.name, 'Da Nang');
  assert.equal(w.cityVisualState.length, 2); // garbage entry dropped
  assert.equal(w.forYouNow[0].category, 'Nightlife');
  assert.equal(w.forYouNow[0].count, 18);
  assert.equal(w.changingNow[0].title, 'An Thuong');
  assert.equal(isWorldProjectionEmpty(w), false);
});

test('mapWorldProjection on {} / null yields an EMPTY (not thrown) projection', () => {
  for (const bad of [null, undefined, {}, 'nope', 123]) {
    const w = mapWorldProjection(bad);
    assert.deepEqual(w.cityVisualState, []);
    assert.deepEqual(w.forYouNow, []);
    assert.deepEqual(w.changingNow, []);
    assert.equal(isWorldProjectionEmpty(w), true);
  }
});

// ── Mapper: place current view ────────────────────────────────────────────────

test('mapPlaceCurrentView maps groups + current picture', () => {
  const p = mapPlaceCurrentView({
    placeId: 'p1',
    placeName: 'An Thuong',
    stateLabel: 'Getting busier',
    currentPicture: { strength: 'strong', ageMinutes: 2, perspectiveCount: 24, contributorCount: 8, sourceCount: 3, trend: 'rising' },
    groups: [
      { key: 'street', label: 'Street', count: 12 },
      { label: 'Entrance', count: 5 }, // key derived from label
      42, // dropped
    ],
  });
  assert.equal(p?.placeName, 'An Thuong');
  assert.equal(p?.currentPicture.strength, 'strong');
  assert.equal(p?.currentPicture.perspectiveCount, 24);
  assert.equal(p?.groups.length, 2);
  assert.equal(p?.groups[1].key, 'entrance');
});

test('mapPlaceCurrentView requires only a placeId; name is nullable (label-only projection)', () => {
  assert.equal(mapPlaceCurrentView({}), null); // no id at all → null
  // A place with an id but no resolved name is valid — the header falls back to
  // the label the caller navigated in with.
  const v = mapPlaceCurrentView({ placeId: 'p1' });
  assert.equal(v?.placeId, 'p1');
  assert.equal(v?.placeName, null);
  assert.equal(v?.currentPicture.perspectiveCount, 0);
});

// ── Mapper: experience + gem ──────────────────────────────────────────────────

test('mapExperienceProjection maps and drops the invalid', () => {
  const e = mapExperienceProjection({
    id: 'e1',
    title: 'Friday Night An Thuong',
    placeIds: ['p1', 'p2', 5],
    currentState: 'peak',
    perspectiveCount: 40,
    freshness: 'fresh',
  });
  assert.equal(e?.title, 'Friday Night An Thuong');
  assert.deepEqual(e?.placeIds, ['p1', 'p2']); // non-string dropped
  assert.equal(e?.currentState, 'peak');
  assert.equal(mapExperienceProjection({ title: 'no id' }), null);
});

test('mapHiddenGemMedia never surfaces precise location and defaults precision to hidden', () => {
  const g = mapHiddenGemMedia({ id: 'g1', title: 'Secret cove', state: 'recently_confirmed', areaLabel: 'North of My Khe' });
  assert.equal(g?.locationPrecision, 'hidden');
  assert.equal(g?.areaLabel, 'North of My Khe');
  assert.equal(g?.state, 'recently_confirmed');
  // No lat/lng fields exist on the projection type at all.
  assert.equal((g as unknown as Record<string, unknown>).lat, undefined);
});

// ── Transport degrade behaviour ───────────────────────────────────────────────

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = impl as unknown as typeof fetch;
  return () => {
    (globalThis as { fetch: typeof fetch }).fetch = original;
  };
}

test('fetchWorld: 404 degrades to empty (not error) — parallel backend PR not deployed', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => new Response('not found', { status: 404 }));
  try {
    const r = await fetchWorld();
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'empty');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchWorld: unwraps { world: {...} } and maps', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () =>
    new Response(
      JSON.stringify({ world: { city: { name: 'Da Nang' }, cityVisualState: [{ name: 'An Thuong', state: 'peak' }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  try {
    const r = await fetchWorld({ lat: 16, lng: 108 });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data.city?.name, 'Da Nang');
    assert.equal(r.ok && r.data.cityVisualState[0].state, 'peak');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchWorld: no token → auth error, never throws', async () => {
  _setTestFreshToken(''); // falsy token
  try {
    const r = await fetchWorld();
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'auth');
  } finally {
    _clearTestFreshToken();
  }
});

test('fetchWorld: network throw is caught and classified, never rethrown', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => {
    throw new TypeError('Network request failed');
  });
  try {
    const r = await fetchWorld();
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'network');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchWorld: 200 with non-JSON body degrades to empty', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => new Response('<html>oops</html>', { status: 200 }));
  try {
    const r = await fetchWorld();
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'empty');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchPlaceView: 500 maps to server error', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => new Response('boom', { status: 500 }));
  try {
    const r = await fetchPlaceView('p1');
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'server');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

// ── REAL §43 server shapes (#278) ─────────────────────────────────────────────
//
// These fixtures mirror the actual response shapes of the shipped projection
// endpoints (MediaProjectionService / MediaExperienceResolver). They are the
// load-bearing tests that this client is wired to the LIVE contract, not the
// earlier speculative shape.

/** A single media object exactly as the server projects it (flat, coarse). */
function serverMedia(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    mediaType: 'image',
    url: 'https://cdn/x.jpg',
    thumbnailUrl: 'https://cdn/x_t.jpg',
    width: 1080,
    height: 1080,
    durationSeconds: null,
    capturedAt: '2026-08-31T09:58:00Z',
    placeId: 'p1',
    placeLabel: 'An Thuong',
    neighborhood: null,
    city: 'Da Nang',
    country: 'VN',
    category: 'nightlife',
    freshness: 'fresh',
    contributor: { id: 'u1', username: 'maya', name: 'Maya', avatarUrl: null, verified: true, isOfficial: false },
    ...over,
  };
}

test('mapMediaProjection reads the REAL flat server shape', () => {
  const m = mapMediaProjection(serverMedia({ durationSeconds: 12, mediaType: 'video' }));
  assert.equal(m.id, 'm1');
  assert.equal(m.mediaType, 'video');
  assert.equal(m.durationMs, 12000); // seconds → ms
  assert.equal(m.freshness, 'fresh');
  assert.equal(m.perspectiveKey, 'nightlife'); // derived from category
  assert.equal(m.category, 'nightlife');
  assert.equal(m.contributor?.displayName, 'Maya'); // ← contributor.name
  assert.equal(m.contributor?.verified, true);
  assert.equal(m.place?.id, 'p1'); // ← flat placeId
  assert.equal(m.place?.name, 'An Thuong'); // ← flat placeLabel
});

test('mapMediaProjection surfaces an official contributor as a trust label', () => {
  const m = mapMediaProjection(serverMedia({ contributor: { id: 'u2', username: 'gov', isOfficial: true } }));
  assert.equal(m.contributor?.trustLabel, 'Official');
});

test('mapWorldProjection maps the REAL world payload (city string, label zones, no fabricated state)', () => {
  const w = mapWorldProjection({
    city: 'Da Nang',
    generatedAt: '2026-08-31T10:00:00Z',
    cityVisualState: [
      { placeId: 'a', label: 'An Thuong', perspectiveCount: 24, freshness: 'fresh', liveClaims: [], liveCrowdLabel: null },
      { placeId: 'b', label: 'Beach Festival', perspectiveCount: 61, freshness: 'recent', liveClaims: [{}], liveCrowdLabel: 'packed' },
    ],
    forYouNow: [
      { category: 'nightlife', label: 'Nightlife', freshPerspectives: 18, totalPerspectives: 40 },
      { category: 'hidden_gems', label: 'Hidden Gems', freshPerspectives: 6, totalPerspectives: 6 },
    ],
    changingNow: [
      { placeId: 'b', label: 'Beach Festival', perspectiveCount: 61, freshness: 'recent', liveClaims: [{}], liveCrowdLabel: 'packed' },
    ],
    totalPerspectives: 85,
  });
  assert.equal(w.city?.name, 'Da Nang'); // string → { name }
  assert.equal(w.cityVisualState.length, 2);
  assert.equal(w.cityVisualState[0].name, 'An Thuong');
  assert.equal(w.cityVisualState[0].state, null); // no live claim → no fabricated state
  assert.equal(w.cityVisualState[1].state, 'peak'); // packed → peak (gated live)
  assert.equal(w.forYouNow[0].category, 'Nightlife'); // ← label
  assert.equal(w.forYouNow[0].count, 18); // ← freshPerspectives
  assert.equal(w.forYouNow[1].lens, 'gems'); // Hidden Gems → gems lens
  assert.equal(w.changingNow[0].title, 'Beach Festival'); // ← label
  assert.equal(w.changingNow[0].state, 'peak');
  assert.equal(w.changingNow[0].subtitle, 'packed'); // honest live crowd text
  assert.equal(isWorldProjectionEmpty(w), false);
});

test('mapPlaceCurrentView maps the REAL PlaceProjection (perspectives → current picture)', () => {
  const now = Date.parse('2026-08-31T10:00:00Z');
  const v = mapPlaceCurrentView(
    {
      placeId: 'p1',
      generatedAt: '2026-08-31T10:00:00Z',
      place: { id: 'p1', name: 'An Thuong', city: 'Da Nang', country: 'VN', neighborhood: 'An Thuong' },
      currentState: { live: false, claims: [], crowdLabel: null },
      perspectives: {
        totalPerspectives: 24,
        freshPerspectives: 12,
        contributorCount: 8,
        independentSourceCount: 3,
        freshness: 'fresh',
        groups: [
          { key: 'nightlife', label: 'Nightlife', perspectiveCount: 12, freshCount: 6, freshness: 'fresh', contributorCount: 5, media: [serverMedia()] },
          { key: 'food', label: 'Food', perspectiveCount: 12, freshCount: 6, freshness: 'recent', contributorCount: 4, media: [serverMedia({ id: 'm2', category: 'food', capturedAt: '2026-08-31T08:00:00Z' })] },
        ],
      },
      freshness: 'fresh',
    },
    now,
  );
  assert.equal(v?.placeName, 'An Thuong');
  assert.equal(v?.areaName, 'An Thuong'); // neighborhood
  assert.equal(v?.currentPicture.perspectiveCount, 24);
  assert.equal(v?.currentPicture.contributorCount, 8);
  assert.equal(v?.currentPicture.sourceCount, 3);
  assert.equal(v?.currentPicture.strength, 'strong'); // 3 independent sources → strong
  assert.equal(v?.stateLabel, null); // no live crowd claim → no fabricated state
  assert.equal(v?.groups.length, 2);
  assert.equal(v?.groups[0].key, 'nightlife');
  // hero media flattened & each stamped with its group key so the mosaic filter matches
  assert.equal(v?.heroMedia.length, 2);
  assert.equal(v?.heroMedia[0].id, 'm1'); // newest first
  assert.equal(v?.heroMedia[0].perspectiveKey, 'nightlife');
  assert.equal(v?.heroMedia[1].perspectiveKey, 'food');
  assert.equal(isPlaceViewEmpty(v), false);
});

test('mapPlaceCurrentView derives a live state ONLY from a gated crowd claim', () => {
  const v = mapPlaceCurrentView({
    placeId: 'p1',
    place: { id: 'p1', name: 'An Thuong' },
    currentState: { live: true, claims: [{}], crowdLabel: 'busy' },
    perspectives: { totalPerspectives: 2, contributorCount: 1, independentSourceCount: 1, freshness: 'fresh', groups: [{ key: 'nightlife', label: 'Nightlife', perspectiveCount: 2, media: [serverMedia()] }] },
  });
  assert.equal(v?.stateLabel, 'Busy'); // title-cased live crowd label
  assert.equal(v?.currentPicture.strength, 'low'); // 1 source
});

test('isPlaceViewEmpty is true for a real place with zero perspectives', () => {
  const v = mapPlaceCurrentView({
    placeId: 'p9',
    place: { id: 'p9', name: 'Quiet Cove' },
    currentState: { live: false, claims: [], crowdLabel: null },
    perspectives: { totalPerspectives: 0, contributorCount: 0, independentSourceCount: 0, freshness: 'none', groups: [] },
  });
  assert.equal(v !== null, true);
  assert.equal(isPlaceViewEmpty(v), true);
});

test('mapExperienceProjection maps the REAL resolver shape and ignores the live-claim object', () => {
  const e = mapExperienceProjection({
    id: 'e1',
    kind: 'event',
    title: 'Beach Festival',
    placeIds: ['p1', 'p2'],
    eventId: 'e1',
    startedAt: '2026-08-31T18:00:00Z',
    expectedEndAt: null,
    currentState: { live: false, claims: [], crowdLabel: null }, // OBJECT, not a lifecycle enum
    perspectiveCount: 40,
    contributorCount: 8,
    freshness: 'fresh',
    heroMedia: [serverMedia()],
    available: true,
    generatedAt: '2026-08-31T10:00:00Z',
  });
  assert.equal(e?.title, 'Beach Festival');
  assert.deepEqual(e?.placeIds, ['p1', 'p2']);
  assert.equal(e?.currentState, null); // live-claim object never fabricates a lifecycle state
  assert.equal(e?.perspectiveCount, 40);
  assert.equal(e?.heroMedia[0].id, 'm1');
});

test('mapExperienceProjection maps a server "not available" shape to null (empty, not error)', () => {
  const e = mapExperienceProjection({
    id: 'e1',
    kind: null,
    title: null,
    available: false,
    placeIds: [],
    perspectiveCount: 0,
    contributorCount: 0,
    freshness: 'none',
    currentState: { live: false, claims: [], crowdLabel: null },
    heroMedia: [],
    generatedAt: '2026-08-31T10:00:00Z',
  });
  assert.equal(e, null);
});

test('mapExperienceProjection titles an untitled trip/event by kind', () => {
  assert.equal(mapExperienceProjection({ id: 't1', kind: 'trip', freshness: 'none' })?.title, 'Trip');
  assert.equal(mapExperienceProjection({ id: 'e2', kind: 'event', freshness: 'none' })?.title, 'Event');
});

test('buildExperienceChain builds a route from distinct places, or null for <2', () => {
  const single = mapExperienceProjection({ id: 'x', kind: 'trip', freshness: 'fresh', heroMedia: [serverMedia()] });
  assert.equal(buildExperienceChain(single!), null); // one place → not a chain

  const multi = mapExperienceProjection({
    id: 'y',
    kind: 'trip',
    title: 'Friday Night',
    freshness: 'fresh',
    heroMedia: [
      serverMedia({ id: 'a', placeId: 'p1', placeLabel: 'Dinner Spot' }),
      serverMedia({ id: 'b', placeId: 'p2', placeLabel: 'Rooftop' }),
      serverMedia({ id: 'c', placeId: 'p2', placeLabel: 'Rooftop' }),
      serverMedia({ id: 'd', placeId: 'p3', placeLabel: 'Nightclub' }),
    ],
  });
  const chain = buildExperienceChain(multi!);
  assert.equal(chain?.steps.length, 3); // 3 distinct places
  assert.deepEqual(chain?.steps.map((s) => s.label), ['Dinner Spot', 'Rooftop', 'Nightclub']);
  assert.equal(chain?.steps[1].perspectiveCount, 2); // Rooftop had two perspectives
});

test('mapPeopleProjection groups perspectives by contributor (§27)', () => {
  const p = mapPeopleProjection({
    generatedAt: '2026-08-31T10:00:00Z',
    people: [
      { contributor: { id: 'u1', username: 'maya', name: 'Maya', verified: true, isOfficial: false }, perspectiveCount: 3, freshness: 'fresh', media: [serverMedia(), serverMedia({ id: 'm2' })] },
      { contributor: null, perspectiveCount: 1, freshness: 'fresh', media: [serverMedia({ id: 'm3' })] }, // no identity → dropped
      { contributor: { id: 'u3', username: 'sam' }, perspectiveCount: 0, freshness: 'none', media: [] }, // no media → dropped
    ],
    totalPerspectives: 4,
  });
  assert.equal(p.people.length, 1);
  assert.equal(p.people[0].contributor.displayName, 'Maya');
  assert.equal(p.people[0].media.length, 2);
});

test('mapPeopleProjection on garbage yields an empty (not thrown) projection', () => {
  for (const bad of [null, undefined, {}, 7, 'x']) {
    const p = mapPeopleProjection(bad);
    assert.deepEqual(p.people, []);
  }
});

test('mapMyWorldLibrary maps buckets and isMyWorldEmpty reflects true emptiness', () => {
  const lib = mapMyWorldLibrary({
    generatedAt: '2026-08-31T10:00:00Z',
    buckets: [
      { key: 'all', label: 'All', ownerOnly: false, count: 2, media: [serverMedia(), serverMedia({ id: 'm2' })] },
      { key: 'drafts', label: 'Drafts', ownerOnly: true, count: 0, media: [] },
      { key: 'gems', label: 'Hidden Gems', ownerOnly: false, count: 0, media: [] },
    ],
  });
  assert.equal(lib.buckets.length, 3);
  assert.equal(lib.buckets[0].media.length, 2);
  assert.equal(lib.buckets[1].ownerOnly, true);
  assert.equal(isMyWorldEmpty(lib), false);

  const empty = mapMyWorldLibrary({ buckets: [{ key: 'all', label: 'All', count: 0, media: [] }] });
  assert.equal(isMyWorldEmpty(empty), true);
});

// ── Transport wiring for the new fetchers ─────────────────────────────────────

test('fetchPeople maps a real /media/people body', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ generatedAt: 'x', people: [{ contributor: { id: 'u1', name: 'Maya' }, perspectiveCount: 1, freshness: 'fresh', media: [serverMedia()] }], totalPerspectives: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  try {
    const r = await fetchPeople();
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data.people.length, 1);
    assert.equal(r.ok && r.data.people[0].contributor.displayName, 'Maya');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchMyWorld: 404 degrades to empty result (never throws)', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => new Response('nope', { status: 404 }));
  try {
    const r = await fetchMyWorld();
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'empty');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchExperience maps a real single-experience body', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ id: 'e1', kind: 'event', title: 'Beach Festival', placeIds: ['p1'], perspectiveCount: 5, contributorCount: 2, freshness: 'fresh', heroMedia: [], available: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  try {
    const r = await fetchExperience('e1');
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data?.title, 'Beach Festival');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchExperiencesByIds: empty id list resolves to an empty ok list with no request', async () => {
  _setTestFreshToken('tok');
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const r = await fetchExperiencesByIds([]);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data.length, 0);
    assert.equal(calls, 0); // no wasted request
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchExperiencesByIds: drops unavailable ids, keeps resolved ones (degrade-graceful)', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async (url: string) => {
    // e1 resolves; e2 is "not available".
    if (url.includes('e1')) {
      return new Response(JSON.stringify({ id: 'e1', kind: 'event', title: 'Live One', freshness: 'fresh', available: true, heroMedia: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ id: 'e2', available: false, freshness: 'none', heroMedia: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const r = await fetchExperiencesByIds(['e1', 'e2']);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data.length, 1);
    assert.equal(r.ok && r.data[0].title, 'Live One');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchExperiencesByIds: surfaces an error only when EVERY id fails at transport', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => new Response('boom', { status: 500 }));
  try {
    const r = await fetchExperiencesByIds(['e1', 'e2']);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'server');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});
