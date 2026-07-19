/**
 * useActiveLocation.homeCascade.test.ts
 *
 * Unit tests for the Tier-3 location cascade: when GPS is denied and no
 * server-persisted session exists, the app should resolve the user's profile
 * home city with `source: 'home'`.
 *
 * Also tests the home→GPS transition: when the user later grants GPS,
 * `buildGpsState` must replace the home-city Place entirely (not merge it),
 * advancing to source:'gps_fresh'.
 *
 * Exercises:
 *   - `_loadHomeFromProfile` from `activeLocation.homeProfile.ts`
 *   - `buildGpsState` from `activeLocation.state.ts`
 * Both are pure helpers; no React renderer is needed.
 *
 * Coverage:
 *   1. Happy path: profile returns homeCity → state is source:'home', city matches
 *   2. Happy path: homeCountry present → displayName includes country
 *   3. Happy path: homeCountry absent → displayName is just the city
 *   4. Edge case: profile returns no homeCity → returns null (source stays 'none')
 *   5. Edge case: profile homeCity is empty string → returns null
 *   6. Edge case: /api/me/profile returns non-ok status → returns null
 *   7. Edge case: fetch throws → returns null (no crash)
 *   8. Edge case: token is null → returns null (no fetch made)
 *   9. Edge case: isConfigured is false → returns null immediately
 *  10. place.id is derived from homeCity, lowercased and slugified
 *  11. GPS grant after home fallback: source advances to 'gps_fresh', place is replaced
 *  12. GPS cached fix after home fallback: source becomes 'gps_cached'
 *  13. Home place city is NOT present in the GPS place (full replacement, not merge)
 *  14. Cached GPS fix starting from source:'home': source='gps_cached', freshness='recent',
 *      place.city matches geocoded result, place.id no longer the home-city id
 *
 * Run (auto-discovered by scripts/run-node-tests.mjs):
 *   node --import tsx/esm --test src/hooks/__tests__/useActiveLocation.homeCascade.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _loadHomeFromProfile } from '../activeLocation.homeProfile.ts';
import { buildGpsState } from '../activeLocation.state.ts';
import type { ActiveLocationState } from '../useActiveLocation.ts';
import type { Place } from '../../lib/location/placeTypes.ts';

// ── Fake fetch helpers ────────────────────────────────────────────────────────

function makeFetch(status: number, body: unknown): typeof fetch {
  return async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const json = JSON.stringify(body);
    return new Response(json, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function throwingFetch(msg: string): typeof fetch {
  return async () => { throw new Error(msg); };
}

// ── Shared deps (token + base always valid) ───────────────────────────────────

const TOKEN = 'test-bearer-token';
const BASE  = 'https://api.example.com';

function deps(fetchFn: typeof fetch, isConfigured = true) {
  return {
    fetchFn,
    isConfigured,
    getToken: async () => TOKEN,
    getBase:  async () => BASE,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('_loadHomeFromProfile — happy path', () => {
  it('returns source:"home" with the correct city when profile has homeCity', async () => {
    const fetch = makeFetch(200, { homeCity: 'Tokyo', homeCountry: 'Japan' });
    const result = await _loadHomeFromProfile('denied', deps(fetch));

    assert.ok(result !== null, 'should return a state, not null');
    assert.equal(result.source, 'home');
    assert.equal(result.ok, true);
    assert.equal(result.place.city, 'Tokyo');
    assert.equal(result.freshness, 'stale');
    assert.equal(result.coords, null);
    assert.equal(result.permissionStatus, 'denied');
  });

  it('includes country in displayName when homeCountry is present', async () => {
    const fetch = makeFetch(200, { homeCity: 'Tokyo', homeCountry: 'Japan' });
    const result = await _loadHomeFromProfile('denied', deps(fetch));

    assert.ok(result !== null);
    assert.equal(result.place.displayName, 'Tokyo, Japan');
    assert.equal(result.place.country, 'Japan');
  });

  it('uses only the city as displayName when homeCountry is absent', async () => {
    const fetch = makeFetch(200, { homeCity: 'Berlin' });
    const result = await _loadHomeFromProfile('denied', deps(fetch));

    assert.ok(result !== null);
    assert.equal(result.place.displayName, 'Berlin');
    assert.equal(result.place.country, null);
  });

  it('slugifies the place.id from homeCity (lowercase, spaces → hyphens)', async () => {
    const fetch = makeFetch(200, { homeCity: 'New York' });
    const result = await _loadHomeFromProfile('denied', deps(fetch));

    assert.ok(result !== null);
    assert.equal(result.place.id, 'home-new-york');
  });

  it('preserves the permissionStatus passed in', async () => {
    const fetch = makeFetch(200, { homeCity: 'Seoul' });
    const result = await _loadHomeFromProfile('unavailable', deps(fetch));

    assert.ok(result !== null);
    assert.equal(result.permissionStatus, 'unavailable');
  });
});

describe('_loadHomeFromProfile — edge cases (returns null)', () => {
  it('returns null when profile has no homeCity field', async () => {
    const fetch = makeFetch(200, { displayName: 'Alice' });
    const result = await _loadHomeFromProfile('denied', deps(fetch));
    assert.equal(result, null, 'null homeCity → should return null');
  });

  it('returns null when homeCity is an empty string', async () => {
    const fetch = makeFetch(200, { homeCity: '' });
    const result = await _loadHomeFromProfile('denied', deps(fetch));
    assert.equal(result, null, 'empty homeCity is falsy → should return null');
  });

  it('returns null when /api/me/profile responds with a non-ok status', async () => {
    const fetch = makeFetch(404, { error: 'not found' });
    const result = await _loadHomeFromProfile('denied', deps(fetch));
    assert.equal(result, null, '404 → should return null');
  });

  it('returns null and does not throw when fetch rejects', async () => {
    const fetch = throwingFetch('network timeout');
    await assert.doesNotReject(async () => {
      const result = await _loadHomeFromProfile('denied', deps(fetch));
      assert.equal(result, null, 'fetch error → should return null, not throw');
    });
  });

  it('returns null when the auth token is null — no fetch is attempted', async () => {
    let fetched = false;
    const fakeFetch: typeof fetch = async () => {
      fetched = true;
      return new Response('{}', { status: 200 });
    };
    const result = await _loadHomeFromProfile('denied', {
      fetchFn: fakeFetch,
      isConfigured: true,
      getToken: async () => null,
      getBase:  async () => BASE,
    });
    assert.equal(result, null, 'null token → should return null');
    assert.equal(fetched, false, 'null token → fetch must not be called');
  });

  it('returns null immediately when isConfigured is false', async () => {
    let fetched = false;
    const fakeFetch: typeof fetch = async () => {
      fetched = true;
      return new Response('{}', { status: 200 });
    };
    const result = await _loadHomeFromProfile('denied', deps(fakeFetch, false));
    assert.equal(result, null, 'isConfigured=false → should return null');
    assert.equal(fetched, false, 'isConfigured=false → fetch must not be called');
  });
});

// ── buildGpsState: home → GPS transition ──────────────────────────────────────

const HOME_PLACE: Place = {
  id: 'home-tokyo',
  type: 'city',
  name: 'Tokyo',
  displayName: 'Tokyo, Japan',
  country: 'Japan',
  countryCode: 'JP',
  region: null,
  city: 'Tokyo',
  district: null,
  lat: null,
  lng: null,
  timezone: null,
  source: 'manual',
};

const HOME_STATE: ActiveLocationState = {
  ok: true,
  permissionStatus: 'denied',
  source: 'home',
  freshness: 'stale',
  coords: null,
  place: HOME_PLACE,
  lastUpdatedAt: null,
  userMessage: null,
};

const GPS_PLACE: Place = {
  id: 'gps-osaka',
  type: 'city',
  name: 'Osaka',
  displayName: 'Osaka, Japan',
  country: 'Japan',
  countryCode: 'JP',
  region: null,
  city: 'Osaka',
  district: null,
  lat: 34.6937,
  lng: 135.5022,
  timezone: 'Asia/Tokyo',
  source: 'gps',
};

const NOW_ISO = '2026-07-19T10:00:00.000Z';

describe('buildGpsState — home-city cleared when GPS is granted', () => {
  it('source advances to gps_fresh when GPS gives a live fix', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, false, GPS_PLACE, NOW_ISO);
    assert.equal(next.source, 'gps_fresh');
  });

  it('source becomes gps_cached for a cached fix', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, true, GPS_PLACE, NOW_ISO);
    assert.equal(next.source, 'gps_cached');
  });

  it('place.city matches the geocoded result — not the home city', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, false, GPS_PLACE, NOW_ISO);
    assert.equal(next.place.city, 'Osaka');
    assert.notEqual(next.place.city, HOME_STATE.place.city,
      'GPS city must not match the home city that was active before');
  });

  it('home-city place.id is gone — place is fully replaced, not merged', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, false, GPS_PLACE, NOW_ISO);
    assert.notEqual(next.place.id, HOME_PLACE.id,
      'the GPS state must not carry the old home-city place.id');
    assert.equal(next.place.id, GPS_PLACE.id);
  });

  it('ok is true and permissionStatus is granted', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, false, GPS_PLACE, NOW_ISO);
    assert.equal(next.ok, true);
    assert.equal(next.permissionStatus, 'granted');
  });

  it('coords are populated with the GPS lat/lng', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, false, GPS_PLACE, NOW_ISO);
    assert.ok(next.coords !== null, 'coords must not be null after a GPS fix');
    assert.equal(next.coords!.lat, 34.6937);
    assert.equal(next.coords!.lng, 135.5022);
    assert.equal(next.coords!.accuracyMeters, 20);
  });

  it('freshness is live for a fresh fix', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, false, GPS_PLACE, NOW_ISO);
    assert.equal(next.freshness, 'live');
  });

  it('freshness is recent for a cached fix', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, true, GPS_PLACE, NOW_ISO);
    assert.equal(next.freshness, 'recent');
  });

  it('place.lat and place.lng are pinned to the GPS coords', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, false, GPS_PLACE, NOW_ISO);
    assert.equal(next.place.lat, 34.6937);
    assert.equal(next.place.lng, 135.5022);
  });

  it('userMessage is null when the geocoded place has a city (live fix)', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, false, GPS_PLACE, NOW_ISO);
    assert.equal(next.userMessage, null);
  });

  it('userMessage mentions the city for a cached fix', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, true, GPS_PLACE, NOW_ISO);
    assert.ok(
      typeof next.userMessage === 'string' && next.userMessage.includes('Osaka'),
      'cached fix userMessage should reference the geocoded city',
    );
  });
});

// ── Focused: cached GPS fix replaces home-city fallback ───────────────────────

describe('buildGpsState — cached fix (gps_cached) clears home-city fallback', () => {
  // Simulate the transition: user was on source:'home' (HOME_STATE), then
  // getLastKnownPositionAsync returned a cached fix (isCached=true).
  // buildGpsState must produce a fully-replaced state — no home-city remnants.

  it('source is gps_cached — not home or gps_fresh', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, true, GPS_PLACE, NOW_ISO);
    assert.equal(next.source, 'gps_cached',
      'a cached GPS fix starting from home must yield source:gps_cached');
    assert.notEqual(next.source, 'home');
    assert.notEqual(next.source, 'gps_fresh');
  });

  it('freshness is recent — not stale (home) or live (gps_fresh)', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, true, GPS_PLACE, NOW_ISO);
    assert.equal(next.freshness, 'recent',
      'isCached=true must set freshness:recent regardless of prior home-city state');
    assert.notEqual(next.freshness, 'stale',
      'the home-city stale freshness must not carry over');
  });

  it('place.city matches the geocoded city — not the home city', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, true, GPS_PLACE, NOW_ISO);
    assert.equal(next.place.city, GPS_PLACE.city,
      'geocoded city must be present in the result');
    assert.notEqual(next.place.city, HOME_PLACE.city,
      'home city must not survive the cached GPS fix');
  });

  it('place.id is the GPS place id — home-city id is gone', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, true, GPS_PLACE, NOW_ISO);
    assert.equal(next.place.id, GPS_PLACE.id,
      'GPS place id must be used');
    assert.notEqual(next.place.id, HOME_PLACE.id,
      `home-city id '${HOME_PLACE.id}' must not appear in the cached GPS state`);
  });

  it('ok is true and permissionStatus is granted', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, true, GPS_PLACE, NOW_ISO);
    assert.equal(next.ok, true);
    assert.equal(next.permissionStatus, 'granted');
  });

  it('coords are populated from the GPS fix', () => {
    const next = buildGpsState(34.6937, 135.5022, 20, true, GPS_PLACE, NOW_ISO);
    assert.ok(next.coords !== null, 'coords must not be null after a cached GPS fix');
    assert.equal(next.coords!.lat, 34.6937);
    assert.equal(next.coords!.lng, 135.5022);
    assert.equal(next.coords!.accuracyMeters, 20);
  });
});
