/**
 * services/discovery.ts — the Discovery client sends the intent mode the user
 * chose, and sends nothing when the user chose none.
 * census-discovery §71 (lane P31), rows A05 and DV-42.
 *
 * SPEC. Sensing §8 (`docs/specs/Portava_Sensing_World_Experience_Intelligence_Upgrade_Architecture_v1.txt:137`):
 * *"Support intent modes using the same shared intelligence: Right Now,
 * Tonight, Explore, Quiet, Social, High Energy, Nearby, Trip."* DSV2-03's
 * criterion: *"UI selection is not merely decorative."* The server already
 * parses `?intentMode=` on `GET /discovery` (lib/intentModes.ts
 * parseIntentMode); until this lane no Discovery client sent it.
 *
 * WHAT IS PINNED
 *   1. No selection ⇒ the request is BYTE-IDENTICAL to the one sent before this
 *      lane: the exact URL literal, whether the field is absent, undefined or
 *      null. This is what keeps today's requests unchanged.
 *   2. A selection ⇒ `intentMode=<mode>` is appended exactly once, and every
 *      other byte of the URL is the no-selection URL.
 *   3. A value outside the eight is never sent.
 *   4. The device cache keeps a mode's page apart from the no-mode page, and
 *      the no-mode cache key is unchanged.
 *
 * THE CLIENT IS REAL. Only `fetch` and the token source are replaced; the
 * lease, the parse and the cache are the production code.
 *
 * Run: node --import tsx/esm --test src/services/__tests__/discovery.intentMode.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  getDiscoveryPlaces,
  getCachedDiscoveryPlaces,
  isDiscoveryCacheFresh,
  _resetDiscoveryClientCache,
  _setDiscoveryTokenSourceForTests,
  DISCOVERY_INTENT_MODES,
  DISCOVERY_INTENT_MODE_LABELS,
  DISCOVERY_LIVE_RANK_FLAG,
  type DiscoveryFilters,
  type DiscoveryIntentMode,
} from '../discovery.ts';
import { _resetDiscoveryViewerScopeForTests } from '../discoveryViewerScope.ts';

const API = 'http://api.test';
const BASE_FILTERS: DiscoveryFilters = { radiusKm: 10, openNow: false, minRating: null };

/** The exact URL `getDiscoveryPlaces('Lisbon', 'food', BASE_FILTERS)` sent before this lane. */
const GOLDEN = `${API}/api/discovery?destination=Lisbon&category=food&radiusKm=10&page=1`;
/** The same call with every optional parameter the screen can pass, as sent before this lane. */
const GOLDEN_FULL =
  `${API}/api/discovery?destination=Lisbon&category=for_you&radiusKm=25&page=1&openNow=1&minRating=4&sortBy=nearest` +
  '&context=near_me&lat=38.72&lng=-9.14&userLat=38.7&userLng=-9.1';

let urls: string[] = [];
let body: unknown = { places: [{ id: 'node/1', name: 'One' }], total: 1, destination: 'Lisbon', cached: false };

const realFetch = globalThis.fetch;
before(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = API;
  _setDiscoveryTokenSourceForTests(async () => null);  // signed out: no token, no Authorization header
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  _setDiscoveryTokenSourceForTests(null);
});
beforeEach(() => {
  urls = [];
  body = { places: [{ id: 'node/1', name: 'One' }], total: 1, destination: 'Lisbon', cached: false };
  _resetDiscoveryViewerScopeForTests();
  _resetDiscoveryClientCache();
});

const fullCall = (filters: DiscoveryFilters) =>
  getDiscoveryPlaces('Lisbon', 'for_you', filters, 1, 'near_me', 'any', null, null, 38.72, -9.14, 38.7, -9.1);
const FULL_FILTERS: DiscoveryFilters = { radiusKm: 25, openNow: true, minRating: 4, sortBy: 'nearest' };

describe('the vocabulary is Sensing §8\'s eight, in its order and words', () => {
  it('DISCOVERY_INTENT_MODES is the eight, in the spec\'s order', () => {
    assert.deepEqual([...DISCOVERY_INTENT_MODES], [
      'right_now', 'tonight', 'explore', 'quiet', 'social', 'high_energy', 'nearby', 'trip',
    ]);
  });
  it('each label is the spec\'s mode name verbatim', () => {
    assert.equal(
      DISCOVERY_INTENT_MODES.map((m) => DISCOVERY_INTENT_MODE_LABELS[m]).join(', '),
      'Right Now, Tonight, Explore, Quiet, Social, High Energy, Nearby, Trip',
    );
  });
  it('the capability flag is migration 2850\'s', () => {
    assert.equal(DISCOVERY_LIVE_RANK_FLAG, 'discovery_live_rank_enabled');
  });
});

describe('no selection: the request is byte-identical to the one sent before', () => {
  it('field absent', async () => {
    await getDiscoveryPlaces('Lisbon', 'food', { ...BASE_FILTERS });
    assert.deepEqual(urls, [GOLDEN]);
  });
  it('field undefined', async () => {
    await getDiscoveryPlaces('Lisbon', 'food', { ...BASE_FILTERS, intentMode: undefined });
    assert.deepEqual(urls, [GOLDEN]);
  });
  it('field null', async () => {
    await getDiscoveryPlaces('Lisbon', 'food', { ...BASE_FILTERS, intentMode: null });
    assert.deepEqual(urls, [GOLDEN]);
  });
  it('every other optional parameter set, and still no intentMode', async () => {
    await fullCall({ ...FULL_FILTERS, intentMode: null });
    assert.deepEqual(urls, [GOLDEN_FULL]);
    assert.ok(!urls[0].includes('intentMode'));
  });
});

describe('a selection is sent, exactly once, and nothing else changes', () => {
  for (const mode of ['right_now', 'tonight', 'explore', 'quiet', 'social', 'high_energy', 'nearby', 'trip'] as const) {
    it(`${mode}: the no-selection URL plus &intentMode=${mode}`, async () => {
      await getDiscoveryPlaces('Lisbon', 'food', { ...BASE_FILTERS, intentMode: mode });
      assert.deepEqual(urls, [`${GOLDEN}&intentMode=${mode}`]);
      assert.deepEqual(new URL(urls[0]).searchParams.getAll('intentMode'), [mode]);
    });
  }
  it('with every other optional parameter set too', async () => {
    await fullCall({ ...FULL_FILTERS, intentMode: 'quiet' });
    assert.deepEqual(urls, [`${GOLDEN_FULL}&intentMode=quiet`]);
  });
});

describe('a value outside the eight is never sent', () => {
  // The Map's own intent kinds (features/map/intent) and near-misses of the eight.
  for (const bad of ['chill', 'party', 'Quiet', 'right now', 'high-energy', '', ' quiet']) {
    it(JSON.stringify(bad), async () => {
      await getDiscoveryPlaces('Lisbon', 'food', { ...BASE_FILTERS, intentMode: bad as unknown as DiscoveryIntentMode });
      assert.deepEqual(urls, [GOLDEN]);
    });
  }
});

describe('the device cache keeps a mode\'s page apart from the no-mode page', () => {
  it('a quiet page is not painted for the no-mode view, and vice versa', async () => {
    body = { places: [{ id: 'node/quiet', name: 'Q' }], total: 1, destination: 'Lisbon', cached: false };
    await getDiscoveryPlaces('Lisbon', 'food', { ...BASE_FILTERS, intentMode: 'quiet' });
    assert.equal(getCachedDiscoveryPlaces('Lisbon', 'food', 10, 1), null, 'the no-mode key must not hold the quiet page');
    assert.equal(isDiscoveryCacheFresh('Lisbon', 'food', 10, 1), false);
    assert.deepEqual(getCachedDiscoveryPlaces('Lisbon', 'food', 10, 1, 'quiet')?.places.map((p) => p.id), ['node/quiet']);
    assert.equal(isDiscoveryCacheFresh('Lisbon', 'food', 10, 1, 'quiet'), true);
    assert.equal(getCachedDiscoveryPlaces('Lisbon', 'food', 10, 1, 'social'), null, 'another mode must not hold it either');

    body = { places: [{ id: 'node/plain', name: 'P' }], total: 1, destination: 'Lisbon', cached: false };
    await getDiscoveryPlaces('Lisbon', 'food', { ...BASE_FILTERS });
    assert.deepEqual(getCachedDiscoveryPlaces('Lisbon', 'food', 10, 1)?.places.map((p) => p.id), ['node/plain']);
    assert.deepEqual(getCachedDiscoveryPlaces('Lisbon', 'food', 10, 1, 'quiet')?.places.map((p) => p.id), ['node/quiet']);
  });
  it('a null mode reads the no-mode key (the key the app used before this lane)', async () => {
    await getDiscoveryPlaces('Lisbon', 'food', { ...BASE_FILTERS });
    assert.ok(getCachedDiscoveryPlaces('Lisbon', 'food', 10, 1, null));
    assert.ok(getCachedDiscoveryPlaces('Lisbon', 'food', 10, 1, undefined));
    assert.ok(getCachedDiscoveryPlaces('Lisbon', 'food', 10, 1));
  });
});
