/**
 * useActiveLocation.homeCascade.test.ts
 *
 * Unit tests for the Tier-3 location cascade: when GPS is denied and no
 * server-persisted session exists, the app should resolve the user's profile
 * home city with `source: 'home'`.
 *
 * Exercises `_loadHomeFromProfile` from `activeLocation.homeProfile.ts`
 * directly (no React renderer needed) using injected dependencies so the
 * test never touches the network or Supabase.
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
 *
 * Run (auto-discovered by scripts/run-node-tests.mjs):
 *   node --import tsx/esm --test src/hooks/__tests__/useActiveLocation.homeCascade.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _loadHomeFromProfile } from '../activeLocation.homeProfile.ts';

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
