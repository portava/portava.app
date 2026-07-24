/**
 * getCanonicalPlace() — unit tests
 *
 * Verifies fail-soft behaviour:
 *  1. Flag OFF / 404 → returns null
 *  2. Network error → returns null
 *  3. HTTP 200 with valid body → returns parsed CanonicalPlace envelope
 *
 * Run with:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/places.getCanonicalPlace.test.ts
 */
import { describe, it, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_API_BASE_URL    = 'http://test.local';
process.env.EXPO_PUBLIC_SUPABASE_URL  ??= 'http://supabase.test.local';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';

// ── Shared fake-token seam ─────────────────────────────────────────────────────

let tokenOverride: string | null = 'test-token';

(globalThis as any).__fakeTokenOverride = () => tokenOverride;

// Loaded lazily in before() — avoids top-level await in the CJS transform.
let getCanonicalPlace: (id: string) => Promise<unknown>;

// ── Fetch mock ────────────────────────────────────────────────────────────────

interface FetchCall { url: string; init?: RequestInit }
let fetchCalls: FetchCall[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>;

(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  fetchCalls.push({ url, init });
  return fetchImpl(url, init);
};

function okResponse(body: unknown) {
  return {
    ok:   true,
    status: 200,
    // Server wraps the canonical place in a { place: ... } envelope.
    json: async () => ({ place: body }),
  };
}

function errResponse(status: number) {
  return {
    ok:   false,
    status,
    json: async () => ({}),
  };
}

const SAMPLE_PLACE = {
  id:           'place-abc',
  name:         'Test Café',
  category:     'food',
  coordinates:  { lat: 14.5, lng: 121.0 },
  address:      '123 Main St',
  city:         'Manila',
  neighborhood: 'Makati',
  countryCode:  'PH',
  status:       'active',
  detailRoute:  '/place/place-abc',
  attribution:  ['© OpenStreetMap contributors', '© Foursquare'],
  sources:      [{ provider: 'osm', externalId: 'osm-1' }],
  fieldFreshness: {},
};

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  // The service reads freshToken from apiToken.ts. We need to stub the supabase
  // client so freshToken returns our token override without hitting real Supabase.
  const { _setTestSupabase } = await import('../apiToken.ts');
  const fakeSupabase = {
    auth: {
      getSession: async () => ({
        data: {
          session: tokenOverride
            ? { access_token: tokenOverride, expires_at: Math.floor(Date.now() / 1000) + 3600 }
            : null,
        },
      }),
      refreshSession: async () => ({ data: { session: null } }),
    },
  };
  _setTestSupabase(fakeSupabase as any);

  ({ getCanonicalPlace } = await import('../places.ts'));
});

beforeEach(() => {
  fetchCalls = [];
  tokenOverride = 'test-token';
  fetchImpl = async () => errResponse(500);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getCanonicalPlace() — flag OFF / 404', () => {
  it('returns null when the server responds 404 (place not found)', async () => {
    fetchImpl = async () => errResponse(404);
    const result = await getCanonicalPlace('unknown-id');
    assert.strictEqual(result, null);
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.includes('/api/places/canonical/unknown-id'));
  });

  it('returns null when the server responds 403 (flag OFF)', async () => {
    fetchImpl = async () => errResponse(403);
    const result = await getCanonicalPlace('place-abc');
    assert.strictEqual(result, null);
  });

  it('returns null when the server responds 500', async () => {
    fetchImpl = async () => errResponse(500);
    const result = await getCanonicalPlace('place-abc');
    assert.strictEqual(result, null);
  });
});

describe('getCanonicalPlace() — network error', () => {
  it('returns null on a network error — never throws', async () => {
    fetchImpl = async () => { throw new Error('Network down'); };
    const result = await getCanonicalPlace('place-abc');
    assert.strictEqual(result, null);
  });

  it('returns null when JSON.parse throws', async () => {
    fetchImpl = async () => ({
      ok:   true,
      status: 200,
      json: async () => { throw new SyntaxError('bad json'); },
    });
    const result = await getCanonicalPlace('place-abc');
    assert.strictEqual(result, null);
  });

  it('returns null when the envelope is missing the place field (malformed response)', async () => {
    // Server returns 200 but without the expected { place: ... } wrapper.
    fetchImpl = async () => ({
      ok:   true,
      status: 200,
      json: async () => ({ error: 'unexpected shape' }),
    });
    const result = await getCanonicalPlace('place-abc');
    assert.strictEqual(result, null);
  });

  it('returns null when the place field is not an object (malformed response)', async () => {
    fetchImpl = async () => ({
      ok:   true,
      status: 200,
      json: async () => ({ place: 'not-an-object' }),
    });
    const result = await getCanonicalPlace('place-abc');
    assert.strictEqual(result, null);
  });

  it('returns null when the place object is missing required name field', async () => {
    fetchImpl = async () => ({
      ok:   true,
      status: 200,
      json: async () => ({
        place: { ...SAMPLE_PLACE, name: undefined },
      }),
    });
    const result = await getCanonicalPlace('place-abc');
    assert.strictEqual(result, null);
  });

  it('returns null when coordinates.lat is not a finite number', async () => {
    fetchImpl = async () => ({
      ok:   true,
      status: 200,
      json: async () => ({
        place: { ...SAMPLE_PLACE, coordinates: { lat: 'not-a-number', lng: 121.0 } },
      }),
    });
    const result = await getCanonicalPlace('place-abc');
    assert.strictEqual(result, null);
  });

  it('returns null when attribution is not an array', async () => {
    fetchImpl = async () => ({
      ok:   true,
      status: 200,
      json: async () => ({
        place: { ...SAMPLE_PLACE, attribution: 'single string' },
      }),
    });
    const result = await getCanonicalPlace('place-abc');
    assert.strictEqual(result, null);
  });

  it('returns null when the place object is completely empty {}', async () => {
    fetchImpl = async () => ({
      ok:   true,
      status: 200,
      json: async () => ({ place: {} }),
    });
    const result = await getCanonicalPlace('place-abc');
    assert.strictEqual(result, null);
  });

  it('returns null when status is not a known PlaceStatus value', async () => {
    fetchImpl = async () => ({
      ok:   true,
      status: 200,
      json: async () => ({
        place: { ...SAMPLE_PLACE, status: 'unknown_status' },
      }),
    });
    const result = await getCanonicalPlace('place-abc');
    assert.strictEqual(result, null, 'unknown status enum value must fail validation');
  });

  it('returns null when an attribution entry is not a string', async () => {
    fetchImpl = async () => ({
      ok:   true,
      status: 200,
      json: async () => ({
        place: { ...SAMPLE_PLACE, attribution: ['© OSM', 42] },
      }),
    });
    const result = await getCanonicalPlace('place-abc');
    assert.strictEqual(result, null, 'non-string attribution entry must fail validation');
  });

  it('accepts an empty attribution array as valid', async () => {
    fetchImpl = async () => ({
      ok:   true,
      status: 200,
      json: async () => ({
        place: { ...SAMPLE_PLACE, attribution: [] },
      }),
    });
    const result = await getCanonicalPlace('place-abc') as any;
    assert.ok(result !== null, 'empty attribution array should be valid');
    assert.deepEqual(result.attribution, []);
  });
});

describe('getCanonicalPlace() — success', () => {
  it('returns the parsed CanonicalPlace envelope on HTTP 200', async () => {
    fetchImpl = async () => okResponse(SAMPLE_PLACE);
    const result = await getCanonicalPlace('place-abc') as any;
    assert.ok(result !== null, 'expected a result, got null');
    assert.equal(result.id,       SAMPLE_PLACE.id);
    assert.equal(result.name,     SAMPLE_PLACE.name);
    assert.equal(result.category, SAMPLE_PLACE.category);
    assert.deepEqual(result.attribution, SAMPLE_PLACE.attribution);
    assert.deepEqual(result.coordinates, SAMPLE_PLACE.coordinates);
    assert.equal(fetchCalls.length, 1);
  });

  it('sends the Authorization header with the bearer token', async () => {
    fetchImpl = async () => okResponse(SAMPLE_PLACE);
    await getCanonicalPlace('place-abc');
    const authHeader = (fetchCalls[0].init as any)?.headers?.Authorization;
    assert.ok(typeof authHeader === 'string' && authHeader.startsWith('Bearer '),
      `Expected Bearer token, got: ${authHeader}`);
  });

  it('URL-encodes the place ID', async () => {
    fetchImpl = async () => okResponse(SAMPLE_PLACE);
    await getCanonicalPlace('place with spaces');
    assert.ok(
      fetchCalls[0].url.includes('place%20with%20spaces'),
      `Expected encoded ID in URL, got: ${fetchCalls[0].url}`,
    );
  });
});
