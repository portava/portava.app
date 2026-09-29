/**
 * services/discovery.ts — the client cache key IS the query the request sends.
 * census-discovery §103 (DV-83, W11-X2 round 7; register D-W11X2-47).
 *
 * §102.11 finding 1: `_discoveryCacheKey` held only destination, category,
 * radius, page and intent mode. The age filter, custom ages, open-now, minimum
 * rating, sort, context and the coordinates all change what GET /discovery
 * answers, yet a page fetched under one of them was replayed for another, and a
 * failed read for the new filter was drawn over the old filter's rows.
 *
 * WHAT IS PINNED
 *   K1. The entry is stored under the key of the query that was SENT: exactly
 *       one entry, whose key is the key of the fetched URL's own parameters.
 *       If a parameter ever reaches the URL without reaching the key, this fails.
 *   K2. Every parameter the request can carry changes the key — enumerated from
 *       the URL itself, not from a list in this file, so a NEW parameter is
 *       covered the day it is added.
 *   K3. The readers, given the same arguments as the request, find the page;
 *       given any one server-affecting argument changed, they find nothing.
 *   C1. Controls: `ageFilter: 'any'` and no age filter are one query (the URL is
 *       the same); the destination's case and spacing do not split the cache.
 *
 * THE CLIENT IS REAL. Only `fetch` and the token source are replaced.
 * Run: node --import tsx/esm --test src/services/__tests__/discovery.cacheKey.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  getDiscoveryPlaces,
  getCachedDiscoveryPlaces,
  isDiscoveryCacheFresh,
  _resetDiscoveryClientCache,
  _setDiscoveryTokenSourceForTests,
  _discoveryCacheKeyForTests,
  _discoveryClientCacheKeysForTests,
  type DiscoveryFilters,
  type DiscoveryCacheQuery,
} from '../discovery.ts';
import { _resetDiscoveryViewerScopeForTests } from '../discoveryViewerScope.ts';
import { discoveryQueryOf, discoveryQueryIdentity } from '../discoveryQueryStamp.ts';

const API = 'http://api.test';
let urls: string[] = [];
let fail = false;
const realFetch = globalThis.fetch;
before(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = API;
  _setDiscoveryTokenSourceForTests(async () => null);
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    if (fail) throw new TypeError('Network request failed');
    return new Response(JSON.stringify({ places: [{ id: 'node/1', name: 'One' }], total: 1, destination: 'Lisbon', cached: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; _setDiscoveryTokenSourceForTests(null); });
beforeEach(() => { urls = []; fail = false; _resetDiscoveryViewerScopeForTests(); _resetDiscoveryClientCache(); });

/** Every argument getDiscoveryPlaces takes, set; `custom` so both custom ages are sent. */
const FULL = {
  destination: 'Lisbon',
  filters: { radiusKm: 25, openNow: true, minRating: 4, sortBy: 'nearest', intentMode: 'quiet' } as DiscoveryFilters,
  rest: { openNow: true, minRating: 4, sortBy: 'nearest', contextMode: 'near_me', ageFilter: 'custom', customMinAge: 21, customMaxAge: 35, lat: 38.72, lng: -9.14, userLat: 38.7, userLng: -9.1 } as DiscoveryCacheQuery,
};
const fetchFull = (over: Partial<DiscoveryCacheQuery> = {}, filters: Partial<DiscoveryFilters> = {}) => {
  const r = { ...FULL.rest, ...over };
  return getDiscoveryPlaces(FULL.destination, 'food', { ...FULL.filters, ...filters }, 1, r.contextMode, r.ageFilter, r.customMinAge, r.customMaxAge, r.lat, r.lng, r.userLat, r.userLng);
};
const readFull = (over: Partial<DiscoveryCacheQuery> = {}, radiusKm = 25, intentMode: 'quiet' | null = 'quiet') =>
  getCachedDiscoveryPlaces(FULL.destination, 'food', radiusKm, 1, intentMode, { ...FULL.rest, ...over });

describe('§103 the client cache key is the query the request sends (D-W11X2-47)', () => {
  it('K1 the entry is stored under the key of the URL that was actually fetched', async () => {
    const res = await fetchFull();
    assert.equal(res.ok, true);
    assert.equal(urls.length, 1);
    const sent = new URL(urls[0]).searchParams;
    assert.deepEqual(_discoveryClientCacheKeysForTests(), [_discoveryCacheKeyForTests(sent)]);
  });

  it('K2 every parameter the request carries changes the key (enumerated from the URL, so a new one is covered)', async () => {
    await fetchFull();
    const sent = new URL(urls[0]).searchParams;
    const names = [...new Set([...sent.keys()])];
    assert.ok(names.length >= 16, `the full call sends every parameter: ${names.join(',')}`);
    const base = _discoveryCacheKeyForTests(sent);
    for (const name of names) {
      const changed = new URLSearchParams(sent);
      changed.set(name, `${sent.get(name)}-changed`);
      assert.notEqual(_discoveryCacheKeyForTests(changed), base, `${name} must enter the cache key`);
    }
  });

  it('K3 the reader finds the page for the same query, and nothing when any one server-affecting argument differs', async () => {
    await fetchFull();
    assert.deepEqual(readFull()?.places.map((p) => p.id), ['node/1']);
    assert.equal(isDiscoveryCacheFresh(FULL.destination, 'food', 25, 1, 'quiet', FULL.rest), true);
    const variants: Array<[string, () => unknown]> = [
      ['openNow', () => readFull({ openNow: false })],
      ['minRating', () => readFull({ minRating: 3 })],
      ['sortBy', () => readFull({ sortBy: 'rating' })],
      ['contextMode', () => readFull({ contextMode: 'in_city' })],
      ['ageFilter', () => readFull({ ageFilter: '21_plus' })],
      ['customMinAge', () => readFull({ customMinAge: 22 })],
      ['customMaxAge', () => readFull({ customMaxAge: 36 })],
      ['lat', () => readFull({ lat: 38.73 })],
      ['lng', () => readFull({ lng: -9.15 })],
      ['userLat', () => readFull({ userLat: 38.71 })],
      ['userLng', () => readFull({ userLng: -9.11 })],
      ['radiusKm', () => readFull({}, 10)],
      ['intentMode', () => readFull({}, 25, null)],
    ];
    for (const [name, read] of variants) assert.equal(read(), null, `a page fetched for another ${name} is not this query's page`);
  });

  it('K4 (the verifier\'s V6-K1 shape, at the service) a page fetched with no age filter is not the 21_plus page', async () => {
    await getDiscoveryPlaces('Paris', 'places', { radiusKm: 10, openNow: false, minRating: null }, 1, null, 'any');
    assert.ok(getCachedDiscoveryPlaces('Paris', 'places', 10, 1, null, { ageFilter: 'any' }));
    assert.equal(getCachedDiscoveryPlaces('Paris', 'places', 10, 1, null, { ageFilter: '21_plus' }), null);
    assert.equal(getCachedDiscoveryPlaces('Paris', 'places', 10, 1, null, { openNow: true }), null);
  });

  it('K5 the page, and a failed read, carry the identity of the query that was sent', async () => {
    const ok = await fetchFull();
    assert.equal(ok.ok, true);
    const id = discoveryQueryIdentity(new URL(urls[0]).searchParams);
    assert.equal(discoveryQueryOf(ok.ok ? ok.data : null), id);
    assert.equal(discoveryQueryOf(readFull()), id, 'the cached page keeps its stamp');
    fail = true;
    const bad = await fetchFull({ ageFilter: '21_plus' });
    assert.equal(bad.ok, false);
    assert.equal(discoveryQueryOf(bad), discoveryQueryIdentity(new URL(urls[1]).searchParams));
    assert.notEqual(discoveryQueryOf(bad), id);
  });

  it('C1 CONTROL: ageFilter "any" and none are one query; the destination\'s case and spacing do not split the cache', async () => {
    await getDiscoveryPlaces('Lisbon', 'food', { radiusKm: 10, openNow: false, minRating: null }, 1, null, 'any');
    assert.equal(urls[0], `${API}/api/discovery?destination=Lisbon&category=food&radiusKm=10&page=1`, 'the no-filter URL is byte-identical to the one sent before');
    assert.ok(getCachedDiscoveryPlaces('Lisbon', 'food', 10, 1));
    assert.ok(getCachedDiscoveryPlaces('  lisbon ', 'food', 10, 1));
    assert.ok(getCachedDiscoveryPlaces('Lisbon', 'food', 10, 1, null, { ageFilter: 'any' }));
  });

  it('K6 the rows\' identity leaves out only the page and the user\'s own position (it measures distances; it does not choose rows)', () => {
    const base = new URLSearchParams('destination=Lisbon&category=food&radiusKm=10&page=1&sortBy=nearest&lat=38.72&lng=-9.14&userLat=38.7&userLng=-9.1');
    const moved = new URLSearchParams(base); moved.set('userLat', '38.7004'); moved.set('userLng', '-9.1003'); moved.set('page', '2');
    assert.equal(discoveryQueryIdentity(moved), discoveryQueryIdentity(base));
    assert.notEqual(_discoveryCacheKeyForTests(moved), _discoveryCacheKeyForTests(base), 'the cache key keeps the position: it changes the answer\'s distances');
    for (const [k, v] of [['sortBy', 'rating'], ['lat', '38.73'], ['ageFilter', '21_plus'], ['openNow', '1'], ['destination', 'Porto']] as const) {
      const other = new URLSearchParams(base); other.set(k, v);
      assert.notEqual(discoveryQueryIdentity(other), discoveryQueryIdentity(base), `${k} decides which rows, or their order`);
    }
  });
});

