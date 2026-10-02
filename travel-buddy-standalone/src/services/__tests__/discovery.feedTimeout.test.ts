/**
 * services/discovery.ts getDiscoveryFeed — a hung request is bounded
 * (census-discovery §94.10, lane W11-X2 round 2; DV-83; register D-W11X2-12).
 *
 * The "Live from events" rail waits on this one call. With no bound, a request
 * the server never answers left the rail in no state at all, forever. The call
 * now gives up after DISCOVERY_FEED_TIMEOUT_MS and answers the transport-failure
 * shape (`ok: false`), which the rail renders as "couldn't check".
 *
 *   T1  a request still pending at the budget is aborted and answers
 *       `{ ok: false, error: 'timeout' }`
 *   T2  CONTROL: an answer one millisecond inside the budget is served
 *   T3  the budget is 15 s, the Compass section budget (the value is a decision)
 *   T4  CONTROL: a network failure is still the network failure, not a timeout
 *
 * Fake timers (node:test's mock.timers): nothing here waits in real time.
 * Run: node --import tsx --test src/services/__tests__/discovery.feedTimeout.test.ts
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { getDiscoveryFeed, _setDiscoveryTokenSourceForTests, DISCOVERY_FEED_TIMEOUT_MS } from '../discovery.ts';

const API = 'http://api.test';
const realFetch = globalThis.fetch;
const OPTS = { destination: 'Lisbon', includePlaces: false, limit: 15 } as const;
const BODY = { places: [], posts: [], nextCursor: null, total: 0, destination: 'Lisbon', sessionId: 's-1' };

/** A fetch that answers after `ms` fake milliseconds, and honours abort as the platform's does. */
function answerAfter(ms: number) {
  globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response(JSON.stringify(BODY), { status: 200 })), ms);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(t);
      const e = new Error('The operation was aborted.'); e.name = 'AbortError';
      reject(e);
    });
  })) as typeof fetch;
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = API;
  _setDiscoveryTokenSourceForTests(async () => 'tok');
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
  _setDiscoveryTokenSourceForTests(null);
});

/** Let the call reach `fetch` (the token read is a microtask), then advance fake time. */
async function tickAfterStart(ms: number) {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  mock.timers.tick(ms);
}

describe('getDiscoveryFeed — bounded (§94.10)', () => {
  it('T1 a request still pending at the budget answers { ok: false, error: "timeout" }', async () => {
    answerAfter(10 * 60_000);
    const p = getDiscoveryFeed(OPTS);
    await tickAfterStart(DISCOVERY_FEED_TIMEOUT_MS);
    assert.deepEqual(await p, { ok: false, error: 'timeout' });
  });

  it('T2 CONTROL: an answer inside the budget is served', async () => {
    answerAfter(DISCOVERY_FEED_TIMEOUT_MS - 1);
    const p = getDiscoveryFeed(OPTS);
    await tickAfterStart(DISCOVERY_FEED_TIMEOUT_MS - 1);
    const r = await p;
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it('T3 the budget is the Compass section budget, 15 s', () => {
    assert.equal(DISCOVERY_FEED_TIMEOUT_MS, 15_000);
  });

  it('T4 CONTROL: a network failure is still a network failure', async () => {
    globalThis.fetch = (async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
    const r = await getDiscoveryFeed(OPTS);
    assert.deepEqual(r, { ok: false, error: 'Network error — check your connection' });
  });
});
