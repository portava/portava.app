/**
 * Unit tests for batchSignMedia.ts
 *
 * Covers:
 *   - cache hit returns without fetching
 *   - cache miss fires POST to /api/media/sign
 *   - error falls back to original URL silently
 *   - 429 response falls back to original URL
 *   - the request carries a bearer token (without it the server 401s and every
 *     media surface in the app renders blank — see the media-blank diagnosis)
 *   - no session short-circuits without any network call
 *   - batches are capped at ≤50 URLs per request
 *   - cache does not grow past MAX_CACHE_SIZE (LRU eviction)
 *   - LRU: the least-recently-used entry is evicted first
 *   - cache TTL derived from server ttlSeconds minus 5-minute safety buffer
 *   - URL near actual expiry (within safety buffer) triggers re-sign
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  batchSignUrls,
  _resetBatchSignCache,
  _getCacheSize,
  _setTestSignTokenProvider,
} from '../batchSignMedia.ts';

const TOKEN = 'test-access-token';

const API_BASE = 'http://localhost:9999';
const URL_A = 'https://abc.supabase.co/storage/v1/object/public/media/a.jpg';
const URL_B = 'https://abc.supabase.co/storage/v1/object/public/media/b.jpg';
const SIGNED_A = 'https://abc.supabase.co/storage/v1/object/sign/media/a.jpg?token=xxx';
const SIGNED_B = 'https://abc.supabase.co/storage/v1/object/sign/media/b.jpg?token=yyy';

let _origFetch: typeof globalThis.fetch;
let _origApiBase: string | undefined;
let _origDateNow: () => number;

// Build the server's object-map response: { signed: { [url]: signedUrl } }
function makeSignedMap(urls: string[]): Record<string, string> {
  const signed: Record<string, string> = {};
  for (const u of urls) {
    signed[u] = u === URL_A ? SIGNED_A : u === URL_B ? SIGNED_B : u;
  }
  return signed;
}

function stubFlagFetch(flagOn: boolean, onSign?: (body: any) => Record<string, string | null>) {
  (globalThis as any).fetch = async (url: string, opts?: any) => {
    if (url.includes('/api/feature-flags')) {
      return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: flagOn } }) };
    }
    if (url.includes('/api/media/sign')) {
      const body = opts?.body ? JSON.parse(opts.body) : { urls: [] };
      // Server response: { signed: { [url]: string | null }, ttlSeconds: number }
      const signed = onSign ? onSign(body) : makeSignedMap(body.urls);
      return { ok: true, json: async () => ({ signed, ttlSeconds: 3600 }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

function stubFetchError() {
  (globalThis as any).fetch = async (url: string) => {
    if (url.includes('/api/feature-flags')) {
      return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
    }
    throw new Error('network error');
  };
}

function stub429() {
  (globalThis as any).fetch = async (url: string) => {
    if (url.includes('/api/feature-flags')) {
      return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
    }
    return { ok: false, status: 429, json: async () => ({}) };
  };
}

describe('batchSignUrls', () => {
  beforeEach(() => {
    _origFetch = globalThis.fetch;
    _origApiBase = process.env.EXPO_PUBLIC_API_BASE_URL;
    _origDateNow = Date.now;
    process.env.EXPO_PUBLIC_API_BASE_URL = API_BASE;
    _resetBatchSignCache();
    _setTestSignTokenProvider(async () => TOKEN);
  });

  afterEach(() => {
    globalThis.fetch = _origFetch;
    process.env.EXPO_PUBLIC_API_BASE_URL = _origApiBase;
    Date.now = _origDateNow;
    _resetBatchSignCache();
    _setTestSignTokenProvider(null);
  });

  it('sends the bearer token — the whole point of the call', async () => {
    let seenAuth: string | undefined;
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      if (url.includes('/api/media/sign')) {
        seenAuth = opts?.headers?.Authorization;
        const body = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ signed: makeSignedMap(body.urls), ttlSeconds: 3600 }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const result = await batchSignUrls([URL_A]);
    assert.equal(seenAuth, `Bearer ${TOKEN}`, 'sign request must be authenticated');
    assert.equal(result.get(URL_A), SIGNED_A);
  });

  it('no session: returns originals without calling the sign endpoint', async () => {
    _setTestSignTokenProvider(async () => null);
    let signCalled = false;
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('/api/media/sign')) signCalled = true;
      throw new Error('unexpected');
    };
    const result = await batchSignUrls([URL_A, URL_B]);
    assert.equal(signCalled, false, 'sign endpoint should not be called without a token');
    assert.equal(result.get(URL_A), URL_A);
    assert.equal(result.get(URL_B), URL_B);
  });

  it('cache miss fires POST and returns signed URLs', async () => {
    stubFlagFetch(true);
    const result = await batchSignUrls([URL_A, URL_B]);
    assert.equal(result.get(URL_A), SIGNED_A);
    assert.equal(result.get(URL_B), SIGNED_B);
  });

  it('cache hit returns without fetching the sign endpoint again', async () => {
    let signCallCount = 0;
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      if (url.includes('/api/feature-flags')) {
        return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
      }
      if (url.includes('/api/media/sign')) {
        signCallCount++;
        const body = JSON.parse(opts.body);
        // Server response: object map { [url]: signedUrl }
        const signed: Record<string, string> = {};
        for (const u of body.urls) signed[u] = SIGNED_A;
        return { ok: true, json: async () => ({ signed, ttlSeconds: 3600 }) };
      }
      throw new Error('unexpected');
    };
    // First call — cache miss
    await batchSignUrls([URL_A]);
    // Second call — should hit cache
    await batchSignUrls([URL_A]);
    assert.equal(signCallCount, 1, 'sign endpoint should only be called once for a cache hit');
  });

  it('error falls back to original URL silently', async () => {
    stubFetchError();
    const result = await batchSignUrls([URL_A]);
    assert.equal(result.get(URL_A), URL_A, 'should fall back to original URL on error');
  });

  it('429 response falls back to original URL silently', async () => {
    stub429();
    const result = await batchSignUrls([URL_A]);
    assert.equal(result.get(URL_A), URL_A, 'should fall back to original URL on 429');
  });

  it('empty input returns empty map without any fetch', async () => {
    let fetchCalled = false;
    (globalThis as any).fetch = async () => { fetchCalled = true; return {}; };
    const result = await batchSignUrls([]);
    assert.equal(fetchCalled, false);
    assert.equal(result.size, 0);
  });

  it('cache does not grow past 500 entries after inserting many URLs', async () => {
    // Stub: flag ON, sign endpoint echoes each URL back as its own "signed" form
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      if (url.includes('/api/feature-flags')) {
        return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
      }
      if (url.includes('/api/media/sign')) {
        const body = JSON.parse(opts.body);
        const signed: Record<string, string> = {};
        for (const u of body.urls) signed[u] = `${u}?signed=1`;
        return { ok: true, json: async () => ({ signed, ttlSeconds: 3600 }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    // Insert 600 unique URLs in batches of 50 (the function's internal batch size)
    const TOTAL = 600;
    for (let i = 0; i < TOTAL; i += 50) {
      const batch = Array.from({ length: Math.min(50, TOTAL - i) }, (_, j) =>
        `https://abc.supabase.co/storage/v1/object/public/media/img-${i + j}.jpg`
      );
      await batchSignUrls(batch);
    }

    const size = _getCacheSize();
    assert.ok(
      size <= 500,
      `Cache size should not exceed 500 but was ${size}`
    );
    assert.ok(size > 0, 'Cache should contain entries after inserts');
  });

  it('expired cache entry triggers a fresh sign request — not served stale', async () => {
    const FIXED_NOW = 1_000_000_000;
    // Server returns ttlSeconds=3600; cache TTL = (3600 - 300) * 1000 = 55 min
    const SERVER_TTL_S = 3600;
    const SAFETY_BUFFER_S = 5 * 60;
    const CACHE_TTL_MS = (SERVER_TTL_S - SAFETY_BUFFER_S) * 1000; // 55 minutes
    let signCallCount = 0;

    // Fix time at FIXED_NOW and prime the cache
    Date.now = () => FIXED_NOW;
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      if (url.includes('/api/feature-flags')) {
        return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
      }
      if (url.includes('/api/media/sign')) {
        signCallCount++;
        const body = JSON.parse(opts.body);
        const signed: Record<string, string> = {};
        for (const u of body.urls) signed[u] = `${u}?token=old`;
        return { ok: true, json: async () => ({ signed, ttlSeconds: SERVER_TTL_S }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const first = await batchSignUrls([URL_A]);
    assert.equal(first.get(URL_A), `${URL_A}?token=old`, 'initial sign should return old token');
    assert.equal(signCallCount, 1, 'sign endpoint called once on first miss');

    // Advance time past the cache TTL so the cached entry is expired
    Date.now = () => FIXED_NOW + CACHE_TTL_MS + 1;
    // Update stub to return a distinct "new" token so we can distinguish fresh vs stale
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      if (url.includes('/api/feature-flags')) {
        return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
      }
      if (url.includes('/api/media/sign')) {
        signCallCount++;
        const body = JSON.parse(opts.body);
        const signed: Record<string, string> = {};
        for (const u of body.urls) signed[u] = `${u}?token=new`;
        return { ok: true, json: async () => ({ signed, ttlSeconds: SERVER_TTL_S }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const second = await batchSignUrls([URL_A]);
    assert.equal(signCallCount, 2, 'sign endpoint should be called again after TTL expiry (cache miss)');
    assert.equal(
      second.get(URL_A),
      `${URL_A}?token=new`,
      'should return the freshly signed URL, not the stale cached one'
    );
  });

  it('near-expiry safety buffer: re-signs before server token expires', async () => {
    // The server issues tokens with a 3600s lifetime.
    // The cache should evict at (3600 - 300)s = 3300s so the client re-signs
    // while the token still has ~5 minutes of life left — preventing mid-session 403s.
    const FIXED_NOW = 2_000_000_000;
    const SERVER_TTL_S = 3600;
    const SAFETY_BUFFER_S = 5 * 60; // 300 s
    const CACHE_TTL_MS = (SERVER_TTL_S - SAFETY_BUFFER_S) * 1000; // 3300 s
    let signCallCount = 0;

    Date.now = () => FIXED_NOW;
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      if (url.includes('/api/feature-flags')) {
        return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
      }
      if (url.includes('/api/media/sign')) {
        signCallCount++;
        const body = JSON.parse(opts.body);
        const signed: Record<string, string> = {};
        for (const u of body.urls) signed[u] = `${u}?token=first`;
        return { ok: true, json: async () => ({ signed, ttlSeconds: SERVER_TTL_S }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    // Prime the cache
    await batchSignUrls([URL_A]);
    assert.equal(signCallCount, 1);

    // Advance to just before cache expiry — should still be a hit
    Date.now = () => FIXED_NOW + CACHE_TTL_MS - 1;
    signCallCount = 0;
    const hitResult = await batchSignUrls([URL_A]);
    assert.equal(signCallCount, 0, 'should be a cache hit just before safety-buffer expiry');
    assert.equal(hitResult.get(URL_A), `${URL_A}?token=first`);

    // Advance to just after cache expiry but still within the server token's 3600s window
    // (safety buffer kicks in: 3300s elapsed < 3600s server TTL)
    Date.now = () => FIXED_NOW + CACHE_TTL_MS + 1;
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      if (url.includes('/api/feature-flags')) {
        return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
      }
      if (url.includes('/api/media/sign')) {
        signCallCount++;
        const body = JSON.parse(opts.body);
        const signed: Record<string, string> = {};
        for (const u of body.urls) signed[u] = `${u}?token=refreshed`;
        return { ok: true, json: async () => ({ signed, ttlSeconds: SERVER_TTL_S }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const refreshResult = await batchSignUrls([URL_A]);
    assert.equal(
      signCallCount,
      1,
      'safety buffer should evict the entry before the actual token expires, triggering a re-sign'
    );
    assert.equal(
      refreshResult.get(URL_A),
      `${URL_A}?token=refreshed`,
      'should return the freshly re-signed URL, not the near-expiry stale one'
    );
  });

  it('LRU: the least-recently-used entry is evicted when the cap is reached', async () => {
    // Stub: flag ON, sign endpoint echoes URLs
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      if (url.includes('/api/feature-flags')) {
        return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
      }
      if (url.includes('/api/media/sign')) {
        const body = JSON.parse(opts.body);
        const signed: Record<string, string> = {};
        for (const u of body.urls) signed[u] = `${u}?signed=1`;
        return { ok: true, json: async () => ({ signed, ttlSeconds: 3600 }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    // Fill cache to exactly 500 entries
    for (let i = 0; i < 500; i += 50) {
      const batch = Array.from({ length: 50 }, (_, j) =>
        `https://abc.supabase.co/storage/v1/object/public/media/img-${i + j}.jpg`
      );
      await batchSignUrls(batch);
    }
    assert.equal(_getCacheSize(), 500);

    // Access the very first URL to promote it from LRU head to MRU tail
    const firstUrl = 'https://abc.supabase.co/storage/v1/object/public/media/img-0.jpg';
    let signCallCount = 0;
    const baseFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      if (url.includes('/api/media/sign')) signCallCount++;
      return baseFetch(url, opts);
    };
    await batchSignUrls([firstUrl]); // cache hit — promotes firstUrl to MRU tail
    assert.equal(signCallCount, 0, 'firstUrl should be served from cache');

    // Now insert one more URL to trigger eviction — img-0 should NOT be evicted
    // because it was just promoted; img-1 (next-oldest) should be evicted instead.
    const newUrl = 'https://abc.supabase.co/storage/v1/object/public/media/img-500.jpg';
    await batchSignUrls([newUrl]);
    assert.equal(_getCacheSize(), 500, 'cache size should remain capped at 500');

    // firstUrl (promoted) must still be in the cache — a second lookup should not call sign
    signCallCount = 0;
    await batchSignUrls([firstUrl]);
    assert.equal(signCallCount, 0, 'recently-promoted entry should still be in cache after eviction');
  });
});

// ── 2026-10-23: Supabase's image transform answers 400 for a video ───────────────
// Production edge log: GET /storage/v1/render/image/sign/post-media/<owner>/1792727980484.mov → 400, again and again.
// A transform is asked for stills only; a video in the same call is signed plainly.
describe('batchSignUrls — videos are never sent to the image transform', () => {
  const VIDEO = 'post-media/u-1/1792727980484.mov';
  const PHOTO = 'post-media/u-1/1792727701590.jpg';
  beforeEach(() => {
    _origFetch = globalThis.fetch;
    _origApiBase = process.env.EXPO_PUBLIC_API_BASE_URL;
    process.env.EXPO_PUBLIC_API_BASE_URL = API_BASE;
    _resetBatchSignCache();
    _setTestSignTokenProvider(async () => TOKEN);
  });
  afterEach(() => {
    globalThis.fetch = _origFetch;
    process.env.EXPO_PUBLIC_API_BASE_URL = _origApiBase;
    _resetBatchSignCache();
    _setTestSignTokenProvider(null);
  });

  it('one call with a video and a photo: the photo carries the transform, the video does not', async () => {
    const bodies: any[] = [];
    stubFlagFetch(true, (body) => { bodies.push(body); return Object.fromEntries(body.urls.map((u: string) => [u, `${u}?signed`])); });
    const out = await batchSignUrls([VIDEO, PHOTO], { width: 400, quality: 80 });
    assert.equal(out.get(VIDEO), `${VIDEO}?signed`);
    assert.equal(out.get(PHOTO), `${PHOTO}?signed`);
    const forVideo = bodies.find((b) => b.urls.includes(VIDEO));
    const forPhoto = bodies.find((b) => b.urls.includes(PHOTO));
    assert.ok(forVideo && forPhoto, JSON.stringify(bodies));
    assert.equal('transform' in forVideo, false, `a video must not be transformed: ${JSON.stringify(forVideo)}`);
    assert.deepEqual(forPhoto.transform, { width: 400, quality: 80 });
    assert.equal(forPhoto.urls.includes(VIDEO), false);
  });

  it('without a transform, nothing changes: one request for everything', async () => {
    const bodies: any[] = [];
    stubFlagFetch(true, (body) => { bodies.push(body); return Object.fromEntries(body.urls.map((u: string) => [u, u])); });
    await batchSignUrls([VIDEO, PHOTO]);
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].urls.sort(), [PHOTO, VIDEO].sort());
  });
});


// 2026-10-25, PR #808 verdict finding 4: an identical sign already in flight is joined, not repeated. Every request that
// goes out is still the one authenticated POST /api/media/sign; a joined answer is only ever the same session's.
describe('batchSignUrls — in-flight identical requests are coalesced', () => {
  let tokenNow = TOKEN;
  beforeEach(() => {
    _origFetch = globalThis.fetch;
    _origApiBase = process.env.EXPO_PUBLIC_API_BASE_URL;
    process.env.EXPO_PUBLIC_API_BASE_URL = API_BASE;
    _resetBatchSignCache();
    tokenNow = TOKEN;
    _setTestSignTokenProvider(async () => tokenNow);
  });
  afterEach(() => {
    globalThis.fetch = _origFetch;
    process.env.EXPO_PUBLIC_API_BASE_URL = _origApiBase;
    _resetBatchSignCache();
    _setTestSignTokenProvider(null);
  });

  function stubSign(answer: (u: string) => string | null = (u) => makeSignedMap([u])[u]!) {
    const bodies: Array<{ urls: string[]; auth: string }> = [];
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      if (!url.includes('/api/media/sign')) throw new Error(`Unexpected fetch: ${url}`);
      const body = JSON.parse(opts.body);
      bodies.push({ urls: body.urls, auth: opts.headers.Authorization });
      await new Promise((r) => setTimeout(r, 5)); // the request is in flight while the second caller arrives
      return { ok: true, json: async () => ({ signed: Object.fromEntries(body.urls.map((u: string) => [u, answer(u)])), ttlSeconds: 3600 }) };
    };
    return bodies;
  }

  it('CO1 two surfaces asking for the same URL at once: one request, both get its answer', async () => {
    const bodies = stubSign();
    const [a, b] = await Promise.all([batchSignUrls([URL_A]), batchSignUrls([URL_A])]);
    assert.equal(bodies.length, 1, JSON.stringify(bodies));
    assert.equal(a.get(URL_A), SIGNED_A);
    assert.equal(b.get(URL_A), SIGNED_A);
  });

  it('CO2 an overlapping batch sends only what is not already in flight', async () => {
    const bodies = stubSign();
    const [a, ab] = await Promise.all([batchSignUrls([URL_A]), batchSignUrls([URL_A, URL_B])]);
    assert.deepEqual(bodies.map((b) => b.urls), [[URL_A], [URL_B]]);
    assert.equal(a.get(URL_A), SIGNED_A);
    assert.equal(ab.get(URL_A), SIGNED_A);
    assert.equal(ab.get(URL_B), SIGNED_B);
  });

  it('CO3 another session never joins: a different bearer token sends its own request', async () => {
    const bodies = stubSign();
    tokenNow = 'session-one';
    const first = batchSignUrls([URL_A]);
    tokenNow = 'session-two';
    const second = batchSignUrls([URL_A]);
    await Promise.all([first, second]);
    assert.equal(bodies.length, 2, JSON.stringify(bodies));
  });

  it('CO4 a refusal is shared with the joined caller, then forgotten: the next ask goes to the server again', async () => {
    const bodies = stubSign(() => null);
    const [a, b] = await Promise.all([batchSignUrls([URL_A]), batchSignUrls([URL_A])]);
    assert.equal(bodies.length, 1);
    assert.equal(a.get(URL_A), URL_A, 'refused: the original, as before');
    assert.equal(b.get(URL_A), URL_A);
    await batchSignUrls([URL_A]);
    assert.equal(bodies.length, 2, 'nothing refused is cached or kept in flight');
  });

  it('CO5 the same URL at another size is another request', async () => {
    const bodies = stubSign();
    await Promise.all([batchSignUrls([URL_A], { width: 400 }), batchSignUrls([URL_A], { width: 800 })]);
    assert.equal(bodies.length, 2);
  });
});
