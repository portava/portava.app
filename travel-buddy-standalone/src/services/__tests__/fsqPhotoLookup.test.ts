/**
 * fsqPhotoLookup.test.ts
 *
 * Unit tests for lookupFsqPhoto() — verifies the proxy URL, query params,
 * response parsing, null propagation, and in-memory caching.
 *
 * The function now calls the api-server proxy (GET /api/places/fsq-photo)
 * instead of the Foursquare API directly, which removes the CORS failure
 * on the web build. The proxy holds FOURSQUARE_API_KEY server-side — the
 * client no longer needs the key at all.
 *
 * Run:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/fsqPhotoLookup.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { lookupFsqPhoto } from '../fsqPhotoLookup.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

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
  return `TestPlace_${++nameCounter}_${Math.random().toString(36).slice(2)}`;
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

// ── lookupFsqPhoto — request URL ──────────────────────────────────────────────

describe('lookupFsqPhoto — request URL', () => {
  it('sends to the api-server fsq-photo proxy endpoint', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupFsqPhoto(uniqueName(), 1.23, 4.56);

    assert.ok(captured.length > 0, 'fetch was not called');
    assert.match(
      captured[0].url,
      /\/api\/places\/fsq-photo/,
      'URL must contain the proxy path /api/places/fsq-photo',
    );
  });

  it('includes the place name as the "name" query param', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    const name = uniqueName();
    await lookupFsqPhoto(name, null, null);

    assert.ok(captured.length > 0, 'fetch was not called');
    const url = new URL(captured[0].url);
    assert.equal(url.searchParams.get('name'), name.trim());
  });

  it('includes lat and lng as query params when both are provided', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupFsqPhoto(uniqueName(), 48.858, 2.294);

    assert.ok(captured.length > 0, 'fetch was not called');
    const url = new URL(captured[0].url);
    assert.equal(url.searchParams.get('lat'), '48.858');
    assert.equal(url.searchParams.get('lng'), '2.294');
  });

  it('omits lat and lng when both are null', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupFsqPhoto(uniqueName(), null, null);

    assert.ok(captured.length > 0, 'fetch was not called');
    const url = new URL(captured[0].url);
    assert.equal(url.searchParams.get('lat'), null, 'lat must be absent when null');
    assert.equal(url.searchParams.get('lng'), null, 'lng must be absent when null');
  });

  it('does not send Authorization or Foursquare-specific headers — those are server-side', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupFsqPhoto(uniqueName(), 1.0, 2.0);

    assert.ok(captured.length > 0, 'fetch was not called');
    // The client proxy call carries no API key headers; auth is on the server.
    const headers = captured[0].init?.headers as Record<string, string> | undefined;
    if (headers) {
      assert.equal(headers['Authorization'], undefined, 'client must not send Authorization header');
      assert.equal(headers['X-Places-Api-Version'], undefined, 'client must not send X-Places-Api-Version header');
    }
  });
});

// ── lookupFsqPhoto — response parsing ─────────────────────────────────────────

describe('lookupFsqPhoto — response parsing', () => {
  it('returns the photoUrl string from the proxy response', async () => {
    const expected = 'https://fastly.4sqi.net/img/general/original/photo.jpg';
    const { fetch: mockFetch } = makeFetch(200, { photoUrl: expected });
    globalThis.fetch = mockFetch;

    const result = await lookupFsqPhoto(uniqueName(), 10.0, 20.0);

    assert.equal(result, expected);
  });

  it('returns null when the proxy responds with photoUrl: null', async () => {
    const { fetch: mockFetch } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    const result = await lookupFsqPhoto(uniqueName(), 10.0, 20.0);

    assert.equal(result, null);
  });

  it('returns null when the proxy responds with a non-ok status', async () => {
    const { fetch: mockFetch } = makeFetch(500, { error: 'internal_error' });
    globalThis.fetch = mockFetch;

    const result = await lookupFsqPhoto(uniqueName(), 10.0, 20.0);

    assert.equal(result, null);
  });

  it('returns null on a 404 response without throwing', async () => {
    const { fetch: mockFetch } = makeFetch(404, {});
    globalThis.fetch = mockFetch;

    const result = await lookupFsqPhoto(uniqueName(), 10.0, 20.0);

    assert.equal(result, null);
  });
});

// ── lookupFsqPhoto — empty name guard ─────────────────────────────────────────

describe('lookupFsqPhoto — empty name guard', () => {
  it('returns null immediately for an empty name without calling fetch', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: 'https://example.com/photo.jpg' });
    globalThis.fetch = mockFetch;

    const result = await lookupFsqPhoto('   ', null, null);

    assert.equal(result, null, 'must return null for whitespace-only names');
    assert.equal(captured.length, 0, 'must not call fetch for empty names');
  });

  it('returns null immediately for an empty string without calling fetch', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: 'https://example.com/photo.jpg' });
    globalThis.fetch = mockFetch;

    const result = await lookupFsqPhoto('', null, null);

    assert.equal(result, null, 'must return null for empty string');
    assert.equal(captured.length, 0, 'must not call fetch for empty string');
  });
});

// ── lookupFsqPhoto — network error ────────────────────────────────────────────

describe('lookupFsqPhoto — network error handling', () => {
  it('returns null and does not throw when fetch throws (e.g. AbortError)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    globalThis.fetch = async () => { throw abortError; };

    const result = await lookupFsqPhoto(uniqueName(), 10.0, 20.0);

    assert.equal(result, null, 'must return null on network error');
  });

  it('does NOT cache a network error — sequential second call retries the proxy', async () => {
    // Transport failures are transient: the proxy might be up on the next mount.
    // Caching them would strand the card on artwork for 24 h even after recovery.
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    let fetchCallCount = 0;
    globalThis.fetch = async () => {
      fetchCallCount++;
      throw abortError;
    };

    const name = uniqueName();
    const lat = 48.0;
    const lng = 2.0;

    const first = await lookupFsqPhoto(name, lat, lng);
    assert.equal(first, null);
    assert.equal(fetchCallCount, 1, 'fetch called once on first request');

    const second = await lookupFsqPhoto(name, lat, lng);
    assert.equal(second, null);
    assert.equal(fetchCallCount, 2, 'fetch must be called again — transport failures are not cached');
  });
});

// ── lookupFsqPhoto — selective client-side caching ────────────────────────────
//
// The server proxy deliberately avoids caching transient outcomes (dead CDN
// links, HEAD-unverified URLs, outages, transport failures) so that subsequent
// requests can retry. The client must honour the same policy: only cache a
// result when the server has confirmed it is durable.
//
// Durable outcomes the client may cache for 24 h:
//   • Verified photo URL  — non-null photoUrl, no `reason` in response.
//   • Confirmed absence   — photoUrl null, reason === "no_photo_found".
//
// Transient outcomes that must NOT be cached (next mount must reach the proxy):
//   • dead_photo_link     — CDN file gone, but might be restored.
//   • head_check_failed   — HEAD liveness check threw; URL unverified.
//   • Any outage reason   — provider down/quota exhausted; will recover.
//   • proxy HTTP error    — proxy itself erroring; may recover.
//   • Network exception   — timeout/abort; may recover.

describe('lookupFsqPhoto — selective caching: durable outcomes are cached', () => {
  it('caches a verified photo URL (non-null photoUrl, no reason) — second call skips proxy', async () => {
    const photoUrl = 'https://fastly.4sqi.net/img/general/original/verified.jpg';
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return { ok: true, status: 200, json: async () => ({ photoUrl }) } as Response;
    };

    const name = uniqueName();
    await lookupFsqPhoto(name, 1.0, 2.0);
    assert.equal(callCount, 1);
    await lookupFsqPhoto(name, 1.0, 2.0);
    assert.equal(callCount, 1, 'verified photo URL must be cached — second call must not fetch');
  });

  it('no_photo_found: second sequential request served from cache (fetch not called again)', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ photoUrl: null, reason: 'no_photo_found' }),
      } as Response;
    };

    const name = uniqueName();
    const first = await lookupFsqPhoto(name, 10.0, 20.0);
    assert.equal(first, null);
    assert.equal(callCount, 1, 'first request must call fetch once');

    const second = await lookupFsqPhoto(name, 10.0, 20.0);
    assert.equal(second, null);
    assert.equal(
      callCount,
      1,
      'no_photo_found is stable absence — second request must be served from cache without fetching',
    );
  });
});

describe('lookupFsqPhoto — selective caching: transient outcomes are NOT cached', () => {
  it('does NOT cache a dead_photo_link result — second call retries', async () => {
    // CDN file gone but may be restored — do not pin the card on artwork for 24 h.
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return { ok: true, status: 200, json: async () => ({ photoUrl: null, reason: 'dead_photo_link' }) } as Response;
    };

    const name = uniqueName();
    await lookupFsqPhoto(name, 1.0, 2.0);
    assert.equal(callCount, 1);
    await lookupFsqPhoto(name, 1.0, 2.0);
    assert.equal(callCount, 2, 'dead_photo_link must NOT be cached — CDN may recover');
  });

  it('does NOT cache a head_check_failed result — second call retries', async () => {
    // Server served the URL optimistically but its CDN HEAD check timed out;
    // the URL is unverified. Caching it would pin the client to a potentially
    // dead image for 24 h; skipping the cache lets the proxy re-verify on next mount.
    const photoUrl = 'https://fastly.4sqi.net/img/general/original/unverified.jpg';
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ photoUrl, reason: 'head_check_failed' }),
      } as Response;
    };

    const name = uniqueName();
    const first = await lookupFsqPhoto(name, 1.0, 2.0);
    assert.equal(first, photoUrl, 'should still return the URL for the current mount');
    assert.equal(callCount, 1);
    await lookupFsqPhoto(name, 1.0, 2.0);
    assert.equal(callCount, 2, 'head_check_failed must NOT be cached — URL is unverified');
  });

  it('foursquare_quota_exhausted: second sequential request fires fetch again', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ photoUrl: null, reason: 'foursquare_quota_exhausted' }),
      } as Response;
    };

    const name = uniqueName();
    await lookupFsqPhoto(name, 10.0, 20.0);
    assert.equal(callCount, 1);
    await lookupFsqPhoto(name, 10.0, 20.0);
    assert.equal(callCount, 2, 'quota-exhausted result must NOT be cached — credits may be restored');
  });

  it('foursquare_auth_error: second sequential request fires fetch again', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ photoUrl: null, reason: 'foursquare_auth_error' }),
      } as Response;
    };

    const name = uniqueName();
    await lookupFsqPhoto(name, 10.0, 20.0);
    assert.equal(callCount, 1);
    await lookupFsqPhoto(name, 10.0, 20.0);
    assert.equal(callCount, 2, 'auth-error result must NOT be cached — second request must call fetch again');
  });

  it('proxy HTTP error (!res.ok): second sequential request fires fetch again', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return { ok: false, status: 502, json: async () => ({}) } as Response;
    };

    const name = uniqueName();
    await lookupFsqPhoto(name, 10.0, 20.0);
    assert.equal(callCount, 1);
    await lookupFsqPhoto(name, 10.0, 20.0);
    assert.equal(callCount, 2, 'proxy HTTP error must NOT be cached — second request must call fetch again');
  });
});
