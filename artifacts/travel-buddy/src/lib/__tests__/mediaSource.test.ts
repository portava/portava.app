/**
 * Unit tests for mediaSource.ts
 *
 * Covers:
 *   - toAppMediaUrl rewrites a Supabase public storage URL correctly
 *   - toAppMediaUrl leaves a non-app URL unchanged
 *   - mediaSource returns { uri } (no headers) when the flag is OFF
 *   - mediaSource returns { uri, headers } with rewritten URL when the flag is ON
 *   - _resolveMediaFlag returns false on fetch error (fail-safe)
 *
 * Uses node:test with global fetch stubbing and the test-seam helpers
 * exported by mediaSource.ts to avoid importing react-native.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  toAppMediaUrl,
  mediaSource,
  _resolveMediaFlag,
  _resetMediaFlagCache,
  _setTestTokenGetter,
  _resetTestTokenGetter,
} from '../mediaSource.ts';

// Fake API base used throughout (no real network calls)
const API_BASE = 'http://localhost:9999';
// A well-formed Supabase public-storage URL
const SUPABASE_URL =
  'https://abc123.supabase.co/storage/v1/object/public/media/posts/img.jpg';
// Expected rewritten URL
const EXPECTED_RELAY = `${API_BASE}/api/media/file/media/posts/img.jpg`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function stubFetch(flagOn: boolean) {
  (globalThis as any).fetch = async (_url: string) =>
    ({ ok: true, json: async () => ({ flags: { media_private_buckets_enabled: flagOn } }) });
}

function stubFetchError() {
  (globalThis as any).fetch = async () => { throw new Error('network error'); };
}

let _origFetch: typeof globalThis.fetch;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('toAppMediaUrl', () => {
  it('rewrites a Supabase public storage URL to the relay endpoint', () => {
    // We test the URL rewriting independent of the API_BASE env var by
    // patching process.env directly; the module reads it at call-time.
    const orig = process.env.EXPO_PUBLIC_API_BASE_URL;
    process.env.EXPO_PUBLIC_API_BASE_URL = API_BASE;
    const result = toAppMediaUrl(SUPABASE_URL);
    process.env.EXPO_PUBLIC_API_BASE_URL = orig;
    assert.equal(result, EXPECTED_RELAY);
  });

  it('strips Supabase transform query params from the rewritten URL', () => {
    const orig = process.env.EXPO_PUBLIC_API_BASE_URL;
    process.env.EXPO_PUBLIC_API_BASE_URL = API_BASE;
    const result = toAppMediaUrl(`${SUPABASE_URL}?width=400&quality=80`);
    process.env.EXPO_PUBLIC_API_BASE_URL = orig;
    assert.equal(result, EXPECTED_RELAY);
  });

  it('leaves a non-app URL unchanged', () => {
    const cdnUrl = 'https://images.unsplash.com/photo-abc?auto=format';
    assert.equal(toAppMediaUrl(cdnUrl), cdnUrl);
  });

  it('leaves an already-signed Supabase URL unchanged', () => {
    const signed =
      'https://abc123.supabase.co/storage/v1/object/sign/media/posts/img.jpg?token=xyz';
    assert.equal(toAppMediaUrl(signed), signed);
  });
});

describe('_resolveMediaFlag', () => {
  beforeEach(() => {
    _origFetch = globalThis.fetch;
    _resetMediaFlagCache();
  });

  afterEach(() => {
    globalThis.fetch = _origFetch;
    _resetMediaFlagCache();
  });

  it('returns false on fetch error (fail-safe)', async () => {
    stubFetchError();
    const result = await _resolveMediaFlag(API_BASE);
    assert.equal(result, false);
  });

  it('returns true when the flag is explicitly enabled', async () => {
    stubFetch(true);
    const result = await _resolveMediaFlag(API_BASE);
    assert.equal(result, true);
  });

  it('returns false when the flag is explicitly disabled', async () => {
    stubFetch(false);
    const result = await _resolveMediaFlag(API_BASE);
    assert.equal(result, false);
  });

  it('returns cached value within TTL without re-fetching', async () => {
    let fetchCount = 0;
    (globalThis as any).fetch = async () => {
      fetchCount++;
      return { ok: true, json: async () => ({ flags: { media_private_buckets_enabled: true } }) };
    };
    const now = Date.now();
    await _resolveMediaFlag(API_BASE, now);
    await _resolveMediaFlag(API_BASE, now + 60_000); // within 5 min TTL
    assert.equal(fetchCount, 1, 'should only fetch once within TTL');
  });
});

describe('mediaSource', () => {
  beforeEach(() => {
    _origFetch = globalThis.fetch;
    _resetMediaFlagCache();
  });

  afterEach(() => {
    globalThis.fetch = _origFetch;
    _resetMediaFlagCache();
    _resetTestTokenGetter();
  });

  it('returns { uri } unchanged when the flag is OFF', async () => {
    stubFetch(false);
    const src = await mediaSource(SUPABASE_URL);
    assert.deepEqual(src, { uri: SUPABASE_URL });
  });

  it('returns { uri: "" } for null input', async () => {
    stubFetch(false);
    const src = await mediaSource(null);
    assert.deepEqual(src, { uri: '' });
  });

  it('returns { uri: "" } for undefined input', async () => {
    stubFetch(false);
    const src = await mediaSource(undefined);
    assert.deepEqual(src, { uri: '' });
  });

  it('returns { uri, headers } with rewritten URL when the flag is ON', async () => {
    stubFetch(true);
    _setTestTokenGetter(async () => 'tok_test123');
    const orig = process.env.EXPO_PUBLIC_API_BASE_URL;
    process.env.EXPO_PUBLIC_API_BASE_URL = API_BASE;
    const src = await mediaSource(SUPABASE_URL);
    process.env.EXPO_PUBLIC_API_BASE_URL = orig;
    assert.equal(src.uri, EXPECTED_RELAY);
    assert.deepEqual(src.headers, { Authorization: 'Bearer tok_test123' });
  });

  it('omits headers when token is null even with flag ON', async () => {
    stubFetch(true);
    _setTestTokenGetter(async () => null);
    const orig = process.env.EXPO_PUBLIC_API_BASE_URL;
    process.env.EXPO_PUBLIC_API_BASE_URL = API_BASE;
    const src = await mediaSource(SUPABASE_URL);
    process.env.EXPO_PUBLIC_API_BASE_URL = orig;
    assert.ok(!src.headers, 'headers should be absent when token is null');
  });

  it('leaves a non-app URL unchanged AND attaches no auth headers — even when flag is ON', async () => {
    stubFetch(true);
    _setTestTokenGetter(async () => 'tok');
    const cdnUrl = 'https://images.unsplash.com/photo-xyz';
    const src = await mediaSource(cdnUrl);
    // URI must pass through unchanged
    assert.equal(src.uri, cdnUrl);
    // Headers must be absent — bearer tokens must never be sent to third-party origins
    assert.ok(!src.headers, 'Authorization header must not be sent to non-app URLs');
  });

  it('also withholds auth headers for already-signed Supabase URLs', async () => {
    stubFetch(true);
    _setTestTokenGetter(async () => 'tok');
    const signedUrl =
      'https://abc123.supabase.co/storage/v1/object/sign/media/posts/img.jpg?token=xyz';
    const src = await mediaSource(signedUrl);
    assert.equal(src.uri, signedUrl);
    assert.ok(!src.headers, 'Already-signed URLs are not relay paths — no auth header');
  });
});
