/**
 * getVenueInfoByCoords() — client-side cache tests
 *
 * Verifies that the module-level venue cache prevents redundant FSQ network
 * calls when the same (lat, lng, name) is requested more than once within
 * the TTL window, and that null/not-found results are also cached.
 *
 * Each test uses unique coordinates so module-level cache entries don't
 * bleed across test cases.
 *
 * Run: pnpm test:component (jest-expo)
 */

// NOTE: exhaustive by design — freshToken is the only export used by
// getVenueInfoByCoords; spreading requireActual would execute the Supabase
// session logic which requires network access and fails in CI.
jest.mock('../apiToken.ts', () => ({ freshToken: jest.fn().mockResolvedValue('test-token') }));
// NOTE: exhaustive by design — only isSupabaseConfigured is read by the guard
// inside getVenueInfoByCoords; the real module initialises a Supabase client
// on import which fails without env vars in the test environment.
jest.mock('../../lib/supabase.ts', () => ({ isSupabaseConfigured: true }));

import { getVenueInfoByCoords } from '../places.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, ok = true) {
  (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    json: jest.fn().mockResolvedValue(body),
  });
}

function venueBody(overrides: Record<string, unknown> = {}) {
  return {
    venue: {
      name: 'Test Bar',
      phone: '+1-555-0100',
      website: 'https://testbar.example',
      openingHours: [{ day: 'Mon', open: '09:00', close: '22:00' }],
      ...overrides,
    },
  };
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('getVenueInfoByCoords() — cache hit on re-navigation', () => {
  test('second call with same coords+name hits cache — no second fetch', async () => {
    mockFetch(venueBody());

    const first = await getVenueInfoByCoords(10.1, 20.1, 'Cache Hit Bar');
    expect(first).not.toBeNull();
    expect(first!.name).toBe('Test Bar');
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);

    // Replace fetch with one that throws — a cache miss would blow up the test.
    (global.fetch as jest.Mock) = jest.fn().mockRejectedValue(new Error('should not be called'));

    const second = await getVenueInfoByCoords(10.1, 20.1, 'Cache Hit Bar');
    expect(second).not.toBeNull();
    expect(second!.name).toBe('Test Bar');
    // Fetch was replaced but never called — the cache served the result.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(0);
  });

  test('null result (404) is also cached — not-found venue is not re-fetched', async () => {
    mockFetch({}, false);

    const first = await getVenueInfoByCoords(10.2, 20.2, 'Ghost Bar');
    expect(first).toBeNull();
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);

    (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue(venueBody()) });

    const second = await getVenueInfoByCoords(10.2, 20.2, 'Ghost Bar');
    expect(second).toBeNull();
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(0);
  });

  test('different coordinates produce separate cache entries', async () => {
    (global.fetch as jest.Mock) = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue(venueBody({ name: 'Venue A' })) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue(venueBody({ name: 'Venue B' })) });

    const a = await getVenueInfoByCoords(10.3, 20.3, 'Venue');
    const b = await getVenueInfoByCoords(10.4, 20.4, 'Venue');

    expect(a!.name).toBe('Venue A');
    expect(b!.name).toBe('Venue B');
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
  });

  test('different names produce separate cache entries', async () => {
    (global.fetch as jest.Mock) = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue(venueBody({ name: 'Alpha' })) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue(venueBody({ name: 'Beta' })) });

    const a = await getVenueInfoByCoords(10.5, 20.5, 'Alpha');
    const b = await getVenueInfoByCoords(10.5, 20.5, 'Beta');

    expect(a!.name).toBe('Alpha');
    expect(b!.name).toBe('Beta');
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
  });

  test('null name and undefined name share the same cache key', async () => {
    mockFetch(venueBody({ name: 'Nameless' }));

    await getVenueInfoByCoords(10.6, 20.6, null);
    const fetchAfterFirst = (global.fetch as jest.Mock).mock.calls.length;

    (global.fetch as jest.Mock) = jest.fn().mockRejectedValue(new Error('should not be called'));
    const result = await getVenueInfoByCoords(10.6, 20.6, undefined);

    expect(result!.name).toBe('Nameless');
    expect(fetchAfterFirst).toBe(1);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(0);
  });
});

describe('getVenueInfoByCoords() — response field mapping', () => {
  test('returns all venue fields on HTTP 200', async () => {
    mockFetch(venueBody());

    const result = await getVenueInfoByCoords(10.7, 20.7, 'Fields Bar');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Test Bar');
    expect(result!.phone).toBe('+1-555-0100');
    expect(result!.website).toBe('https://testbar.example');
    expect(Array.isArray(result!.openingHours)).toBe(true);
  });

  test('returns null for phone/website/openingHours when absent', async () => {
    mockFetch(venueBody({ phone: null, website: '', openingHours: [] }));

    const result = await getVenueInfoByCoords(10.8, 20.8, 'Sparse Bar');
    expect(result).not.toBeNull();
    expect(result!.phone).toBeNull();
    expect(result!.website).toBeNull();
    expect(result!.openingHours).toBeNull();
  });

  test('returns null on network error — never throws', async () => {
    (global.fetch as jest.Mock) = jest.fn().mockRejectedValue(new Error('network down'));

    const result = await getVenueInfoByCoords(10.9, 20.9, 'Error Bar');
    expect(result).toBeNull();
  });
});
