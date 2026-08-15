/**
 * fsqPhotoLookup.concurrentDedup.test.ts
 *
 * Confirms that two concurrent lookupFsqPhoto() calls for the same
 * name/lat/lng only dispatch one fetch to Foursquare — not two.
 * Without the in-flight dedup Map both calls race past the empty cache and
 * each fires its own Foursquare request, double-billing API quota.
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
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test.invalid';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

// ── concurrent dedup ──────────────────────────────────────────────────────────

describe('lookupFsqPhoto — concurrent dedup', () => {
  it('fires only one fetch when two calls for the same venue are made concurrently', async () => {
    const body = {
      photoUrl: 'https://fastly.4sqi.net/img/general/original/venue.jpg',
    };
    const { fetch: mockFetch, captured } = makeFetch(200, body);
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
      `Expected exactly 1 fetch but got ${captured.length} — in-flight dedup is not working`,
    );
    assert.equal(url1, 'https://fastly.4sqi.net/img/general/original/venue.jpg');
    assert.equal(url2, 'https://fastly.4sqi.net/img/general/original/venue.jpg');
  });

  it('both concurrent callers receive the same resolved photo URL', async () => {
    const body = {
      photoUrl: 'https://fastly.4sqi.net/img/general/original/eiffel.jpg',
    };
    const { fetch: mockFetch } = makeFetch(200, body);
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');

    const name = uniqueName();
    const results = await Promise.all([
      lookupFsqPhoto(name, 48.858, 2.294),
      lookupFsqPhoto(name, 48.858, 2.294),
    ]);

    const expected = 'https://fastly.4sqi.net/img/general/original/eiffel.jpg';
    for (const result of results) {
      assert.equal(result, expected, 'each caller must receive the resolved URL');
    }
  });

  it('both concurrent callers receive null on a non-ok response — only one fetch', async () => {
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
      `Expected exactly 1 fetch on error path but got ${captured.length}`,
    );
    assert.equal(r1, null);
    assert.equal(r2, null);
  });

  it('two calls for DIFFERENT venues still each fire their own fetch', async () => {
    const body = {
      photoUrl: 'https://fastly.4sqi.net/img/general/original/x.jpg',
    };
    const { fetch: mockFetch, captured } = makeFetch(200, body);
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');

    await Promise.all([
      lookupFsqPhoto(uniqueName(), 48.858, 2.294),
      lookupFsqPhoto(uniqueName(), 48.858, 2.294),
    ]);

    assert.equal(
      captured.length,
      2,
      'different venues must each dispatch their own fetch',
    );
  });
});

// ── cache hit after first call ────────────────────────────────────────────────

describe('lookupFsqPhoto — cache hit after resolution', () => {
  it('a sequential second call for the same venue hits the cache — no second fetch', async () => {
    const body = {
      photoUrl: 'https://fastly.4sqi.net/img/general/original/cached.jpg',
    };
    const { fetch: mockFetch, captured } = makeFetch(200, body);
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');

    const name = uniqueName();
    const first = await lookupFsqPhoto(name, 1.0, 1.0);
    const second = await lookupFsqPhoto(name, 1.0, 1.0);

    assert.equal(captured.length, 1, 'cache must absorb the sequential second call');
    assert.equal(first, 'https://fastly.4sqi.net/img/general/original/cached.jpg');
    assert.equal(second, 'https://fastly.4sqi.net/img/general/original/cached.jpg');
  });
});
