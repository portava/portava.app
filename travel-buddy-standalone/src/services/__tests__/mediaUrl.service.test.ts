/**
 * Unit tests for hydrateMediaUrls (mediaUrl.ts service layer).
 *
 * Covers:
 *   - non-private-bucket URLs pass through unchanged without a sign request
 *   - private-bucket (post-media) URLs are sent to /api/media/sign
 *   - chunk boundary: 51 private-bucket URLs fire two POST requests
 *   - cache hit (second call) returns without a network call
 *   - expired entry re-fetches on the next call
 *   - server returns null for a URL → hydrateMediaUrls returns null for that key
 *   - flag OFF → private-bucket URLs returned unchanged, no sign call
 *
 * Run with: node --import tsx/esm --test src/services/__tests__/mediaUrl.service.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { hydrateMediaUrls } from '../mediaUrl.ts';
import { _resetBatchSignCache } from '../../lib/batchSignMedia.ts';
import { _resetMediaFlagCache, _setTestTokenGetter, _resetTestTokenGetter } from '../../lib/mediaSource.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const POST_MEDIA_URL = 'https://abc.supabase.co/storage/v1/object/public/post-media/img.jpg';
const PROFILE_MEDIA_URL = 'https://abc.supabase.co/storage/v1/object/public/profile-media/avatar.jpg';
const STAMP_ART_URL = 'https://abc.supabase.co/storage/v1/object/public/stamp-artwork/cat.png';
const CDN_URL = 'https://cdn.example.com/image.jpg';

const SIGNED_POST = `${POST_MEDIA_URL}?token=signed1`;

// ── fetch stubs ───────────────────────────────────────────────────────────────

type SignHandler = (body: { urls: string[] }) => Record<string, string | null>;

let _origFetch: typeof globalThis.fetch;
let _origDateNow: () => number;

function stubFetch(flagOn: boolean, onSign?: SignHandler) {
  (globalThis as any).fetch = async (url: string, opts?: any) => {
    if (url.includes('/api/feature-flags')) {
      return {
        ok: true,
        json: async () => ({ flags: { media_private_buckets_enabled: flagOn } }),
      };
    }
    if (url.includes('/api/media/sign')) {
      const body = opts?.body ? JSON.parse(opts.body) : { urls: [] };
      const signed = onSign
        ? onSign(body)
        : Object.fromEntries((body.urls as string[]).map((u: string) => [u, `${u}?token=signed`]));
      return { ok: true, json: async () => ({ signed, ttlSeconds: 3600 }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  _origFetch = globalThis.fetch;
  _origDateNow = Date.now;
  _resetBatchSignCache();
  _resetMediaFlagCache();
  _setTestTokenGetter(async () => 'test-token');
});

afterEach(() => {
  globalThis.fetch = _origFetch;
  Date.now = _origDateNow;
  _resetBatchSignCache();
  _resetMediaFlagCache();
  _resetTestTokenGetter();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('hydrateMediaUrls', () => {
  it('non-private-bucket URLs pass through unchanged — no call to /api/media/sign', async () => {
    let signCalled = false;
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('/api/feature-flags')) {
        return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
      }
      if (url.includes('/api/media/sign')) { signCalled = true; }
      throw new Error(`unexpected: ${url}`);
    };

    const result = await hydrateMediaUrls([STAMP_ART_URL, CDN_URL]);

    assert.equal(signCalled, false, '/api/media/sign must not be called for non-private buckets');
    assert.equal(result[STAMP_ART_URL], STAMP_ART_URL, 'stamp-artwork URL returned unchanged');
    assert.equal(result[CDN_URL], CDN_URL, 'CDN URL returned unchanged');
  });

  it('private-bucket (post-media) URLs are signed; non-private pass through', async () => {
    stubFetch(true, ({ urls }) => Object.fromEntries(urls.map((u) => [u, `${u}?token=ok`])));

    const result = await hydrateMediaUrls([POST_MEDIA_URL, STAMP_ART_URL, CDN_URL]);

    assert.equal(result[POST_MEDIA_URL], `${POST_MEDIA_URL}?token=ok`, 'post-media URL should be signed');
    assert.equal(result[STAMP_ART_URL], STAMP_ART_URL, 'stamp-artwork URL returned unchanged');
    assert.equal(result[CDN_URL], CDN_URL, 'CDN URL returned unchanged');
  });

  it('51 private-bucket URLs fire exactly two POST requests to /api/media/sign', async () => {
    let signCallCount = 0;
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      if (url.includes('/api/feature-flags')) {
        return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
      }
      if (url.includes('/api/media/sign')) {
        signCallCount++;
        const body = JSON.parse(opts.body);
        const signed: Record<string, string> = {};
        for (const u of body.urls) signed[u] = `${u}?token=signed`;
        return { ok: true, json: async () => ({ signed, ttlSeconds: 3600 }) };
      }
      throw new Error(`unexpected: ${url}`);
    };

    const urls = Array.from({ length: 51 }, (_, i) =>
      `https://abc.supabase.co/storage/v1/object/public/post-media/img-${i}.jpg`,
    );

    const result = await hydrateMediaUrls(urls);

    assert.equal(signCallCount, 2, 'two batched POST requests expected (50 + 1)');
    // All 51 URLs should be signed
    for (const u of urls) {
      assert.equal(result[u], `${u}?token=signed`, `signed URL expected for ${u}`);
    }
  });

  it('cache hit: second call with the same URL returns without a sign request', async () => {
    let signCallCount = 0;
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      if (url.includes('/api/feature-flags')) {
        return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
      }
      if (url.includes('/api/media/sign')) {
        signCallCount++;
        const body = JSON.parse(opts.body);
        const signed: Record<string, string> = {};
        for (const u of body.urls) signed[u] = SIGNED_POST;
        return { ok: true, json: async () => ({ signed, ttlSeconds: 3600 }) };
      }
      throw new Error(`unexpected: ${url}`);
    };

    // First call — cache miss
    const first = await hydrateMediaUrls([POST_MEDIA_URL]);
    assert.equal(first[POST_MEDIA_URL], SIGNED_POST, 'first call should return signed URL');
    assert.equal(signCallCount, 1, 'sign called once on cache miss');

    // Second call — cache hit
    const second = await hydrateMediaUrls([POST_MEDIA_URL]);
    assert.equal(second[POST_MEDIA_URL], SIGNED_POST, 'second call should return cached signed URL');
    assert.equal(signCallCount, 1, 'sign endpoint must NOT be called again on cache hit');
  });

  it('expired cache entry triggers a fresh sign request on the next call', async () => {
    const FIXED_NOW = 1_000_000_000_000;
    const TTL_MS = 45 * 60 * 1000; // must match CACHE_TTL_MS in batchSignMedia.ts

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
        const tag = signCallCount === 1 ? 'old' : 'new';
        for (const u of body.urls) signed[u] = `${u}?token=${tag}`;
        return { ok: true, json: async () => ({ signed, ttlSeconds: 3600 }) };
      }
      throw new Error(`unexpected: ${url}`);
    };

    // First call — cache miss
    const first = await hydrateMediaUrls([POST_MEDIA_URL]);
    assert.equal(first[POST_MEDIA_URL], `${POST_MEDIA_URL}?token=old`, 'first: old token');
    assert.equal(signCallCount, 1);

    // Advance time past the TTL so the cached entry is stale
    Date.now = () => FIXED_NOW + TTL_MS + 1;

    // Second call — cache expired → re-fetch
    const second = await hydrateMediaUrls([POST_MEDIA_URL]);
    assert.equal(signCallCount, 2, 'sign endpoint must be called again after TTL expiry');
    assert.equal(second[POST_MEDIA_URL], `${POST_MEDIA_URL}?token=new`, 'second: fresh token');
  });

  it('server returns null for a URL → hydrateMediaUrls returns null for that key', async () => {
    stubFetch(true, ({ urls }) => Object.fromEntries(urls.map((u) => [u, null])));

    const result = await hydrateMediaUrls([POST_MEDIA_URL]);

    assert.equal(
      result[POST_MEDIA_URL],
      null,
      'null server response must propagate as null (not the raw URL)',
    );
  });

  it('flag OFF → private-bucket URLs returned unchanged, no call to /api/media/sign', async () => {
    let signCalled = false;
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('/api/feature-flags')) {
        return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: false } }) };
      }
      if (url.includes('/api/media/sign')) { signCalled = true; }
      throw new Error(`unexpected: ${url}`);
    };

    const result = await hydrateMediaUrls([POST_MEDIA_URL, PROFILE_MEDIA_URL]);

    assert.equal(signCalled, false, 'sign endpoint must NOT be called when flag is OFF');
    assert.equal(result[POST_MEDIA_URL], POST_MEDIA_URL, 'post-media returned unchanged when flag OFF');
    assert.equal(result[PROFILE_MEDIA_URL], PROFILE_MEDIA_URL, 'profile-media returned unchanged when flag OFF');
  });

  it('empty input returns empty record without any fetch', async () => {
    let fetchCalled = false;
    (globalThis as any).fetch = async () => { fetchCalled = true; return {}; };

    const result = await hydrateMediaUrls([]);

    assert.equal(fetchCalled, false, 'no fetch calls for empty input');
    assert.equal(Object.keys(result).length, 0);
  });
});
