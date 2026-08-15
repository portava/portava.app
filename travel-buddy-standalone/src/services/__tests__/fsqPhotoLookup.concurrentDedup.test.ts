/**
 * fsqPhotoLookup.concurrentDedup.test.ts
 *
 * Confirms that two concurrent lookupFsqPhoto() calls for the same
 * name/lat/lng only dispatch one request to the api-server proxy — not two.
 * Without the in-flight dedup Map both calls race past the empty cache and
 * each fires its own proxy request, double-billing the Foursquare API quota
 * that the server holds.
 *
 * The client now calls GET /api/places/fsq-photo (the api-server proxy) instead
 * of hitting Foursquare directly, which fixes the CORS failure on the web build.
 *
 * Run:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/fsqPhotoLookup.concurrentDedup.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── helpers ───────────────────────────────────────────────────────────────────

type CapturedRequest = { url: string };

function makeFetch(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const mockFetch = async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    captured.push({ url: String(input) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  };
  return { fetch: mockFetch as typeof globalThis.fetch, captured };
}

// Counter so each describe block uses a fresh name that bypasses any
// in-memory cache entries left by earlier tests.
let nameCounter = 0;
function uniqueName(): string {
  return `FsqDedupVenue_${++nameCounter}_${Math.random().toString(36).slice(2)}`;
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

// ── concurrent dedup ──────────────────────────────────────────────────────────

describe('lookupFsqPhoto — concurrent dedup', () => {
  it('fires only one proxy request when two calls for the same venue are made concurrently', async () => {
    const photoUrl = 'https://fastly.4sqi.net/img/general/original/venue.jpg';
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl });
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');

    const name = uniqueName();
    const [url1, url2] = await Promise.all([
      lookupFsqPhoto(name, 48.858, 2.294),
      lookupFsqPhoto(name, 48.858, 2.294),
    ]);

    assert.equal(
      captured.length,
      1,
      `Expected exactly 1 proxy request but got ${captured.length} — in-flight dedup is not working`,
    );
    // Confirm the request went to the proxy, not directly to Foursquare.
    assert.match(
      captured[0].url,
      /\/api\/places\/fsq-photo/,
      'proxy URL must contain /api/places/fsq-photo',
    );
    assert.equal(url1, photoUrl);
    assert.equal(url2, photoUrl);
  });

  it('both concurrent callers receive the same resolved photo URL', async () => {
    const photoUrl = 'https://fastly.4sqi.net/img/general/original/eiffel.jpg';
    const { fetch: mockFetch } = makeFetch(200, { photoUrl });
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');

    const name = uniqueName();
    const results = await Promise.all([
      lookupFsqPhoto(name, 48.858, 2.294),
      lookupFsqPhoto(name, 48.858, 2.294),
    ]);

    for (const result of results) {
      assert.equal(result, photoUrl, 'each caller must receive the resolved URL');
    }
  });

  it('both concurrent callers receive null on a non-ok response — only one proxy request', async () => {
    const { fetch: mockFetch, captured } = makeFetch(500, {});
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');

    const name = uniqueName();
    const [r1, r2] = await Promise.all([
      lookupFsqPhoto(name, 10.0, 20.0),
      lookupFsqPhoto(name, 10.0, 20.0),
    ]);

    assert.equal(
      captured.length,
      1,
      `Expected exactly 1 proxy request on error path but got ${captured.length}`,
    );
    assert.equal(r1, null);
    assert.equal(r2, null);
  });

  it('two calls for DIFFERENT venues still each fire their own proxy request', async () => {
    const photoUrl = 'https://fastly.4sqi.net/img/general/original/x.jpg';
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl });
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');

    await Promise.all([
      lookupFsqPhoto(uniqueName(), 48.858, 2.294),
      lookupFsqPhoto(uniqueName(), 48.858, 2.294),
    ]);

    assert.equal(
      captured.length,
      2,
      'different venues must each dispatch their own proxy request',
    );
  });
});

// ── cache hit after first call ────────────────────────────────────────────────

describe('lookupFsqPhoto — cache hit after resolution', () => {
  it('a sequential second call for the same venue hits the cache — no second proxy request', async () => {
    const photoUrl = 'https://fastly.4sqi.net/img/general/original/cached.jpg';
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl });
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');

    const name = uniqueName();
    const first = await lookupFsqPhoto(name, 1.0, 1.0);
    const second = await lookupFsqPhoto(name, 1.0, 1.0);

    assert.equal(captured.length, 1, 'cache must absorb the sequential second call');
    assert.equal(first, photoUrl);
    assert.equal(second, photoUrl);
  });
});
