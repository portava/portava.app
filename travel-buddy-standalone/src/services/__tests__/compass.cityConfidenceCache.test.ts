/**
 * Unit tests for the fetchCityConfidence short-lived per-city cache.
 *
 * Covers:
 *   - repeat calls for the same city within the TTL hit the cache (one fetch)
 *   - different cities each fetch once (keys are per-city, case-insensitive)
 *   - failed fetches are not cached — the next call retries the network
 *   - _clearCityConfidenceCache forces a refetch
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/compass.cityConfidenceCache.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

let fetchCityConfidence: typeof import('../compass.ts')['fetchCityConfidence'];
let _clearCityConfidenceCache: typeof import('../compass.ts')['_clearCityConfidenceCache'];
let _setTestAuthToken: typeof import('../compass.ts')['_setTestAuthToken'];

let fetchCalls: string[] = [];
let failNext = false;

const confidenceBody = (city: string) => ({
  city,
  depthScore: 42,
  tier: 'moderate',
  note: null,
  computedAt: '2026-07-20T00:00:00Z',
});

const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string) => {
  fetchCalls.push(String(url));
  if (failNext) { failNext = false; return Promise.reject(new Error('network down')); }
  const city = new URL(String(url)).searchParams.get('city') ?? '';
  return Promise.resolve(new Response(JSON.stringify(confidenceBody(city)), { status: 200 }));
}) as typeof fetch;

after(() => { globalThis.fetch = realFetch; });

describe('fetchCityConfidence cache', () => {
  before(async () => {
    const mod = await import('../compass.ts');
    fetchCityConfidence = mod.fetchCityConfidence;
    _clearCityConfidenceCache = mod._clearCityConfidenceCache;
    _setTestAuthToken = mod._setTestAuthToken;
  });

  beforeEach(() => {
    fetchCalls = [];
    failNext = false;
    _clearCityConfidenceCache();
    _setTestAuthToken('test-token');
  });

  it('serves a repeat call for the same city from cache — one network fetch', async () => {
    const first = await fetchCityConfidence('Cebu');
    const second = await fetchCityConfidence('Cebu');
    assert.equal(fetchCalls.length, 1);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(second.data, first.data);
  });

  it('cache key is case/whitespace-insensitive', async () => {
    await fetchCityConfidence('Cebu');
    await fetchCityConfidence('  cebu ');
    assert.equal(fetchCalls.length, 1);
  });

  it('different cities fetch independently', async () => {
    await fetchCityConfidence('Cebu');
    await fetchCityConfidence('Manila');
    assert.equal(fetchCalls.length, 2);
    // Repeat visits to each are still cached.
    await fetchCityConfidence('Cebu');
    await fetchCityConfidence('Manila');
    assert.equal(fetchCalls.length, 2);
  });

  it('does not cache failures — next call retries the network', async () => {
    failNext = true;
    const failed = await fetchCityConfidence('Davao');
    assert.equal(failed.ok, false);
    const retried = await fetchCityConfidence('Davao');
    assert.equal(retried.ok, true);
    assert.equal(fetchCalls.length, 2);
  });

  it('clearing the cache forces a refetch', async () => {
    await fetchCityConfidence('Cebu');
    _clearCityConfidenceCache();
    await fetchCityConfidence('Cebu');
    assert.equal(fetchCalls.length, 2);
  });
});
