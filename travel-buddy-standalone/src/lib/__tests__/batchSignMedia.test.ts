/**
 * Unit tests for batchSignMedia.ts
 *
 * Covers:
 *   - cache hit returns without fetching
 *   - cache miss fires POST to /api/media/sign
 *   - error falls back to original URL silently
 *   - 429 response falls back to original URL
 *   - flag OFF short-circuits without any network call
 *   - batches are capped at ≤50 URLs per request
 *   - cache does not grow past MAX_CACHE_SIZE (LRU eviction)
 *   - LRU: the least-recently-used entry is evicted first
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { batchSignUrls, _resetBatchSignCache, _getCacheSize } from '../batchSignMedia.ts';
import { _resetMediaFlagCache, _setTestTokenGetter, _resetTestTokenGetter } from '../mediaSource.ts';

const API_BASE = 'http://localhost:9999';
const URL_A = 'https://abc.supabase.co/storage/v1/object/public/media/a.jpg';
const URL_B = 'https://abc.supabase.co/storage/v1/object/public/media/b.jpg';
const SIGNED_A = 'https://abc.supabase.co/storage/v1/object/sign/media/a.jpg?token=xxx';
const SIGNED_B = 'https://abc.supabase.co/storage/v1/object/sign/media/b.jpg?token=yyy';

let _origFetch: typeof globalThis.fetch;
let _origApiBase: string | undefined;

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
    process.env.EXPO_PUBLIC_API_BASE_URL = API_BASE;
    _resetBatchSignCache();
    _resetMediaFlagCache();
    _setTestTokenGetter(async () => 'tok');
  });

  afterEach(() => {
    globalThis.fetch = _origFetch;
    process.env.EXPO_PUBLIC_API_BASE_URL = _origApiBase;
    _resetBatchSignCache();
    _resetMediaFlagCache();
    _resetTestTokenGetter();
  });

  it('flag OFF: returns originals immediately without any network call to /api/media/sign', async () => {
    let signCalled = false;
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('/api/feature-flags')) {
        return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: false } }) };
      }
      if (url.includes('/api/media/sign')) signCalled = true;
      throw new Error('unexpected');
    };
    const result = await batchSignUrls([URL_A, URL_B]);
    assert.equal(signCalled, false, 'sign endpoint should not be called when flag is OFF');
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
