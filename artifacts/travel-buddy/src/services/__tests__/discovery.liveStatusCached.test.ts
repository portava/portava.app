/**
 * Tests for getPlaceLiveStatusCached — the deduped, cached, concurrency-limited
 * live-status lookup used by Explore list cards.
 *
 * Run with:
 *   node --import tsx/esm --test src/services/__tests__/discovery.liveStatusCached.test.ts
 *
 * ## What is covered
 *   1. A successful lookup is cached — a second call makes no new fetch.
 *   2. Identical concurrent lookups share ONE in-flight request.
 *   3. Distinct places each get their own request, but never more than 3 at once.
 *   4. A failed lookup (network error) resolves null and is cached (no immediate retry).
 *   5. Different city context produces a different cache key.
 *   6. Blank name short-circuits to null without fetching.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_API_BASE_URL = 'http://test.local';
process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'http://supabase.test.local';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';

// Loaded lazily (in `before`) — the CJS transform used by the node:test
// runner rejects top-level await.
let getPlaceLiveStatusCached: typeof import('../discovery.ts')['getPlaceLiveStatusCached'];

interface FetchCall { url: string }
let fetchCalls: FetchCall[] = [];
let concurrent = 0;
let maxConcurrent = 0;
let fetchImpl: (url: string) => Promise<unknown> = async () => okBody(true);

function okBody(openNow: boolean) {
  return {
    ok: true,
    json: async () => ({
      liveStatus: {
        available: true,
        openNow,
        source: 'foursquare',
        checkedAt: new Date(0).toISOString(),
        confidence: { sourceClass: 'verified_live', label: 'Verified live', checkedAt: new Date(0).toISOString() },
      },
    }),
  };
}

(globalThis as { fetch: unknown }).fetch = async (url: string) => {
  fetchCalls.push({ url: String(url) });
  concurrent++;
  maxConcurrent = Math.max(maxConcurrent, concurrent);
  try {
    // Yield so overlapping calls actually overlap.
    await new Promise((r) => setTimeout(r, 10));
    return await fetchImpl(String(url));
  } finally {
    concurrent--;
  }
};

// Unique suffix per test file run so the module-level cache never collides
// across tests (the cache is intentionally not resettable from outside).
let n = 0;
const unique = () => `Place ${Date.now()}-${n++}`;

describe('getPlaceLiveStatusCached', () => {
  before(async () => {
    ({ getPlaceLiveStatusCached } = await import('../discovery.ts'));
  });

  beforeEach(() => {
    fetchCalls = [];
    concurrent = 0;
    maxConcurrent = 0;
    fetchImpl = async () => okBody(true);
  });

  it('caches a successful lookup — second call makes no new fetch', async () => {
    const name = unique();
    const first = await getPlaceLiveStatusCached(name, 'Cebu');
    assert.equal(first?.available, true);
    assert.equal(first?.openNow, true);
    assert.equal(fetchCalls.length, 1);

    const second = await getPlaceLiveStatusCached(name, 'Cebu');
    assert.equal(second?.openNow, true);
    assert.equal(fetchCalls.length, 1, 'cached result must not refetch');
  });

  it('dedupes identical concurrent lookups into one request', async () => {
    const name = unique();
    const [a, b, c] = await Promise.all([
      getPlaceLiveStatusCached(name, 'Cebu'),
      getPlaceLiveStatusCached(name, 'Cebu'),
      getPlaceLiveStatusCached(name, 'Cebu'),
    ]);
    assert.equal(fetchCalls.length, 1);
    assert.equal(a?.openNow, true);
    assert.equal(b?.openNow, true);
    assert.equal(c?.openNow, true);
  });

  it('limits concurrency to 3 across distinct places', async () => {
    const names = Array.from({ length: 8 }, () => unique());
    const results = await Promise.all(
      names.map((name) => getPlaceLiveStatusCached(name, 'Cebu')),
    );
    assert.equal(fetchCalls.length, 8);
    assert.ok(maxConcurrent <= 3, `max concurrent was ${maxConcurrent}, expected <= 3`);
    for (const r of results) assert.equal(r?.available, true);
  });

  it('caches a failed lookup as null — no immediate retry storm', async () => {
    fetchImpl = async () => { throw new Error('network down'); };
    const name = unique();
    const first = await getPlaceLiveStatusCached(name, 'Cebu');
    assert.equal(first, null);
    assert.equal(fetchCalls.length, 1);

    const second = await getPlaceLiveStatusCached(name, 'Cebu');
    assert.equal(second, null);
    assert.equal(fetchCalls.length, 1, 'failure must be cached, not retried immediately');
  });

  it('different city context is a different cache entry', async () => {
    const name = unique();
    await getPlaceLiveStatusCached(name, 'Cebu');
    await getPlaceLiveStatusCached(name, 'Manila');
    assert.equal(fetchCalls.length, 2);
  });

  it('blank name short-circuits without fetching', async () => {
    const result = await getPlaceLiveStatusCached('   ', 'Cebu');
    assert.equal(result, null);
    assert.equal(fetchCalls.length, 0);
  });
});
