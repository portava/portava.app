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
  mapExperienceProjection,
  mapHiddenGemMedia,
  fetchWorld,
  fetchPlaceView,
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

test('mapCityVisualZone maps a zone and defaults trend/state', () => {
  const z = mapCityVisualZone({ id: 'z1', name: 'An Thuong', state: 'building', trend: 'rising' });
  assert.equal(z?.name, 'An Thuong');
  assert.equal(z?.state, 'building');
  assert.equal(z?.trend, 'rising');

  const z2 = mapCityVisualZone({ name: 'Riverside' }); // id defaults to name
  assert.equal(z2?.id, 'Riverside');
  assert.equal(z2?.state, 'moderate');
  assert.equal(z2?.trend, 'steady');

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

test('mapPlaceCurrentView returns null without id+name', () => {
  assert.equal(mapPlaceCurrentView({}), null);
  assert.equal(mapPlaceCurrentView({ placeId: 'p1' }), null);
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
