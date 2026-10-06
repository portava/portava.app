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
 *   5. Different place coordinates produce a different cache key — two
 *      same-named places never share an entry (lead ruling D-67).
 *   6. Blank name short-circuits to null without fetching.
 *   7. The place's own coordinates ride on the request as lat/lng — the
 *      server's identity anchor (D-67) — and are left off, not invented,
 *      when the place has none.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_API_BASE_URL = 'http://test.local';
process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'http://supabase.test.local';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';

// Loaded lazily (in `before`) — the CJS transform used by the node:test
// runner rejects top-level await.
let getPlaceLiveStatusCached: typeof import('../discovery.ts')['getPlaceLiveStatusCached'];
let getPlaceLiveStatus: typeof import('../discovery.ts')['getPlaceLiveStatus'];

// The place's own coordinates (Cebu), and a second same-named place 2 km north.
const CEBU = { lat: 10.3157, lng: 123.8854 };
const NORTH = { lat: 10.3337, lng: 123.8854 };

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
    ({ getPlaceLiveStatusCached, getPlaceLiveStatus } = await import('../discovery.ts'));
  });

  beforeEach(() => {
    fetchCalls = [];
    concurrent = 0;
    maxConcurrent = 0;
    fetchImpl = async () => okBody(true);
  });

  it('caches a successful lookup — second call makes no new fetch', async () => {
    const name = unique();
    const first = await getPlaceLiveStatusCached(name, CEBU);
    assert.equal(first?.available, true);
    assert.equal(first?.openNow, true);
    assert.equal(fetchCalls.length, 1);

    const second = await getPlaceLiveStatusCached(name, CEBU);
    assert.equal(second?.openNow, true);
    assert.equal(fetchCalls.length, 1, 'cached result must not refetch');
  });

  it('dedupes identical concurrent lookups into one request', async () => {
    const name = unique();
    const [a, b, c] = await Promise.all([
      getPlaceLiveStatusCached(name, CEBU),
      getPlaceLiveStatusCached(name, CEBU),
      getPlaceLiveStatusCached(name, CEBU),
    ]);
    assert.equal(fetchCalls.length, 1);
    assert.equal(a?.openNow, true);
    assert.equal(b?.openNow, true);
    assert.equal(c?.openNow, true);
  });

  it('limits concurrency to 3 across distinct places', async () => {
    const names = Array.from({ length: 8 }, () => unique());
    const results = await Promise.all(
      names.map((name) => getPlaceLiveStatusCached(name, CEBU)),
    );
    assert.equal(fetchCalls.length, 8);
    assert.ok(maxConcurrent <= 3, `max concurrent was ${maxConcurrent}, expected <= 3`);
    for (const r of results) assert.equal(r?.available, true);
  });

  it('caches a failed lookup as null — no immediate retry storm', async () => {
    fetchImpl = async () => { throw new Error('network down'); };
    const name = unique();
    const first = await getPlaceLiveStatusCached(name, CEBU);
    assert.equal(first, null);
    assert.equal(fetchCalls.length, 1);

    const second = await getPlaceLiveStatusCached(name, CEBU);
    assert.equal(second, null);
    assert.equal(fetchCalls.length, 1, 'failure must be cached, not retried immediately');
  });

  it('a same-named place at different coordinates is a different cache entry (D-67)', async () => {
    const name = unique();
    fetchImpl = async () => okBody(true);
    const here = await getPlaceLiveStatusCached(name, CEBU);
    fetchImpl = async () => okBody(false);
    const there = await getPlaceLiveStatusCached(name, NORTH);
    assert.equal(fetchCalls.length, 2, 'the second place is not served the first place\'s entry');
    assert.equal(here?.openNow, true);
    assert.equal(there?.openNow, false);
  });

  it('blank name short-circuits without fetching', async () => {
    const result = await getPlaceLiveStatusCached('   ', CEBU);
    assert.equal(result, null);
    assert.equal(fetchCalls.length, 0);
  });

  it('sends the place\'s own coordinates as lat/lng (D-67)', async () => {
    const name = unique();
    await getPlaceLiveStatusCached(name, CEBU);
    const u = new URL(fetchCalls[0]!.url);
    assert.equal(u.pathname, '/api/places/live-status');
    assert.equal(u.searchParams.get('name'), name);
    assert.equal(u.searchParams.get('lat'), String(CEBU.lat));
    assert.equal(u.searchParams.get('lng'), String(CEBU.lng));
  });

  it('getPlaceLiveStatus sends the coordinates too, and none it does not have', async () => {
    await getPlaceLiveStatus('Cafe Uno', CEBU);
    const sent = new URL(fetchCalls[0]!.url);
    assert.equal(sent.searchParams.get('lat'), String(CEBU.lat));
    assert.equal(sent.searchParams.get('lng'), String(CEBU.lng));
    await getPlaceLiveStatus('Cafe Uno', { lat: null, lng: CEBU.lng });
    const partial = new URL(fetchCalls[1]!.url);
    assert.equal(partial.searchParams.get('lat'), null, 'half a coordinate pair is no anchor');
    assert.equal(partial.searchParams.get('lng'), null);
    await getPlaceLiveStatus('Cafe Uno', null);
    const none = new URL(fetchCalls[2]!.url);
    assert.equal(none.searchParams.get('lat'), null);
    assert.equal(none.searchParams.get('lng'), null);
  });
});
