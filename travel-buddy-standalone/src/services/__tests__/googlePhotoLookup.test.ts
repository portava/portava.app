/**
 * googlePhotoLookup.test.ts
 *
 * Unit tests for lookupGooglePhoto() — verifies the proxy URL, query params,
 * response parsing, null propagation, and in-memory caching.
 *
 * The function calls the api-server proxy (GET /api/places/photo) instead of
 * calling Google Places directly. This keeps the browser CORS-safe: Google's
 * Places API does not emit Access-Control-Allow-Origin headers suitable for
 * cross-origin requests from the web build, and the GOOGLE_MAPS_API_KEY stays
 * server-side rather than being shipped to the client.
 *
 * Run:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/googlePhotoLookup.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { lookupGooglePhoto } from '../googlePhotoLookup.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

type CapturedRequest = { url: string; init?: RequestInit };

function makeFetch(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const mockFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.push({ url: String(input), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  };
  return { fetch: mockFetch as typeof globalThis.fetch, captured };
}

// Counter for unique place names so each test bypasses the in-memory cache.
let nameCounter = 0;
function uniqueName(): string {
  return `GoogleTestPlace_${++nameCounter}_${Math.random().toString(36).slice(2)}`;
}

// ── setup ─────────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
const originalApiBase = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.EXPO_PUBLIC_API_BASE_URL = originalApiBase;
});

// ── lookupGooglePhoto — request URL (CORS-safety assertions) ──────────────────

describe('lookupGooglePhoto — request URL', () => {
  it('sends to the api-server photo proxy endpoint — not to Google directly', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupGooglePhoto(uniqueName(), 1.23, 4.56);

    assert.ok(captured.length > 0, 'fetch was not called');
    assert.match(
      captured[0].url,
      /\/api\/places\/photo/,
      'URL must contain the proxy path /api/places/photo',
    );
  });

  it('does not send to places.googleapis.com — would cause CORS failure on web', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupGooglePhoto(uniqueName(), 1.23, 4.56);

    assert.ok(captured.length > 0, 'fetch was not called');
    assert.doesNotMatch(
      captured[0].url,
      /places\.googleapis\.com/,
      'URL must not reach places.googleapis.com directly — use the server proxy',
    );
  });

  it('includes the place name as the "name" query param', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    const name = uniqueName();
    await lookupGooglePhoto(name, null, null);

    assert.ok(captured.length > 0, 'fetch was not called');
    const url = new URL(captured[0].url);
    assert.equal(url.searchParams.get('name'), name.trim());
  });

  it('includes lat and lng as query params when both are provided', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupGooglePhoto(uniqueName(), 48.858, 2.294);

    assert.ok(captured.length > 0, 'fetch was not called');
    const url = new URL(captured[0].url);
    assert.equal(url.searchParams.get('lat'), '48.858');
    assert.equal(url.searchParams.get('lng'), '2.294');
  });

  it('omits lat and lng when both are null', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupGooglePhoto(uniqueName(), null, null);

    assert.ok(captured.length > 0, 'fetch was not called');
    const url = new URL(captured[0].url);
    assert.equal(url.searchParams.get('lat'), null, 'lat must be absent when null');
    assert.equal(url.searchParams.get('lng'), null, 'lng must be absent when null');
  });

  it('does not send Authorization or Google-API-key headers — those stay server-side', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupGooglePhoto(uniqueName(), 1.0, 2.0);

    assert.ok(captured.length > 0, 'fetch was not called');
    // The client proxy call carries no API key headers; auth is on the server.
    const headers = captured[0].init?.headers as Record<string, string> | undefined;
    if (headers) {
      assert.equal(headers['Authorization'], undefined, 'client must not send Authorization header');
      assert.equal(headers['X-Goog-Api-Key'], undefined, 'client must not send X-Goog-Api-Key header');
    }
  });
});

// ── lookupGooglePhoto — response parsing ──────────────────────────────────────

describe('lookupGooglePhoto — response parsing', () => {
  it('returns the photoUrl string from the proxy response', async () => {
    const expected = 'https://lh3.googleusercontent.com/places/photo.jpg';
    const { fetch: mockFetch } = makeFetch(200, { photoUrl: expected });
    globalThis.fetch = mockFetch;

    const result = await lookupGooglePhoto(uniqueName(), 10.0, 20.0);

    assert.equal(result, expected);
  });

  it('returns null when the proxy responds with photoUrl: null', async () => {
    const { fetch: mockFetch } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    const result = await lookupGooglePhoto(uniqueName(), 10.0, 20.0);

    assert.equal(result, null);
  });

  it('returns null when the proxy responds with a non-ok status', async () => {
    const { fetch: mockFetch } = makeFetch(500, { error: 'internal_error' });
    globalThis.fetch = mockFetch;

    const result = await lookupGooglePhoto(uniqueName(), 10.0, 20.0);

    assert.equal(result, null);
  });

  it('returns null on a 404 response without throwing', async () => {
    const { fetch: mockFetch } = makeFetch(404, {});
    globalThis.fetch = mockFetch;

    const result = await lookupGooglePhoto(uniqueName(), 10.0, 20.0);

    assert.equal(result, null);
  });
});

// ── lookupGooglePhoto — empty name guard ──────────────────────────────────────

describe('lookupGooglePhoto — empty name guard', () => {
  it('returns null immediately for a whitespace-only name without calling fetch', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: 'https://example.com/photo.jpg' });
    globalThis.fetch = mockFetch;

    const result = await lookupGooglePhoto('   ', null, null);

    assert.equal(result, null, 'must return null for whitespace-only names');
    assert.equal(captured.length, 0, 'must not call fetch for empty names');
  });

  it('returns null immediately for an empty string without calling fetch', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: 'https://example.com/photo.jpg' });
    globalThis.fetch = mockFetch;

    const result = await lookupGooglePhoto('', null, null);

    assert.equal(result, null, 'must return null for empty string');
    assert.equal(captured.length, 0, 'must not call fetch for empty string');
  });
});

// ── lookupGooglePhoto — network error handling ────────────────────────────────

describe('lookupGooglePhoto — network error handling', () => {
  it('returns null and does not throw when fetch throws (e.g. AbortError)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    globalThis.fetch = async () => { throw abortError; };

    const result = await lookupGooglePhoto(uniqueName(), 10.0, 20.0);

    assert.equal(result, null, 'must return null on network error');
  });

  it('does NOT cache the null result on network error — a second call retries the fetch', async () => {
    // Network failures are transient; caching them would lock a place into
    // fallback artwork for 24 h even after the connection recovers.
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    let fetchCallCount = 0;
    globalThis.fetch = async () => {
      fetchCallCount++;
      throw abortError;
    };

    const name = uniqueName();
    const lat = 48.0;
    const lng = 2.0;

    const first = await lookupGooglePhoto(name, lat, lng);
    assert.equal(first, null);
    assert.equal(fetchCallCount, 1, 'fetch should be called once on the first request');

    const second = await lookupGooglePhoto(name, lat, lng);
    assert.equal(second, null);
    assert.equal(fetchCallCount, 2, 'fetch must be called again — transient errors must not be cached');
  });
});

// ── lookupGooglePhoto — caching policy: outage vs genuine absence ──────────────
//
// The server returns a machine-readable `reason` on every null-photoUrl path.
// The client must cache only stable results (confirmed photo URL, or confirmed
// absence: no_photo_found). Outage and transient reasons must never be cached
// — they are billing/config/network state that can change without a code
// deploy, and locking in a null for 24 h would keep cards on fallback artwork
// even after the provider recovers.

describe('lookupGooglePhoto — outage reason: NOT cached, second call retries fetch', () => {
  it('google_places_api_new_service_disabled: second sequential request fires fetch again', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async (_input: RequestInfo | URL) => {
      fetchCallCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ photoUrl: null, reason: 'google_places_api_new_service_disabled' }),
      } as Response;
    };

    const name = uniqueName();
    const first = await lookupGooglePhoto(name, 10.0, 20.0);
    assert.equal(first, null);
    assert.equal(fetchCallCount, 1, 'first request must call fetch once');

    const second = await lookupGooglePhoto(name, 10.0, 20.0);
    assert.equal(second, null);
    assert.equal(
      fetchCallCount,
      2,
      'service-disabled result must NOT be cached — second request must call fetch again',
    );
  });

  it('no_google_maps_key: second sequential request fires fetch again', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async (_input: RequestInfo | URL) => {
      fetchCallCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ photoUrl: null, reason: 'no_google_maps_key' }),
      } as Response;
    };

    const name = uniqueName();
    await lookupGooglePhoto(name, 10.0, 20.0);
    assert.equal(fetchCallCount, 1);

    await lookupGooglePhoto(name, 10.0, 20.0);
    assert.equal(
      fetchCallCount,
      2,
      'missing-key result must NOT be cached — second request must call fetch again',
    );
  });

  it('proxy HTTP error (!res.ok): second sequential request fires fetch again', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async (_input: RequestInfo | URL) => {
      fetchCallCount++;
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    };

    const name = uniqueName();
    await lookupGooglePhoto(name, 10.0, 20.0);
    assert.equal(fetchCallCount, 1);

    await lookupGooglePhoto(name, 10.0, 20.0);
    assert.equal(
      fetchCallCount,
      2,
      'proxy HTTP error must NOT be cached — second request must call fetch again',
    );
  });
});

describe('lookupGooglePhoto — no_photo_found: IS cached, second call skips fetch', () => {
  it('no_photo_found: second sequential request served from cache (fetch not called again)', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async (_input: RequestInfo | URL) => {
      fetchCallCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ photoUrl: null, reason: 'no_photo_found' }),
      } as Response;
    };

    const name = uniqueName();
    const first = await lookupGooglePhoto(name, 10.0, 20.0);
    assert.equal(first, null);
    assert.equal(fetchCallCount, 1, 'first request must call fetch once');

    const second = await lookupGooglePhoto(name, 10.0, 20.0);
    assert.equal(second, null);
    assert.equal(
      fetchCallCount,
      1,
      'no_photo_found is stable absence — second request must be served from cache without fetching',
    );
  });
});
