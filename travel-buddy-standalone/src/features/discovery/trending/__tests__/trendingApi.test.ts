/**
 * Discovery Trending on the client (owner decision 2026-10-04: in scope as a
 * user-facing feature; Q12: k ≥ 15 and protected-zone suppression are the
 * SERVER's, the client never counts).
 *
 * SHOWN RED FIRST: no client of /v1/discovery/trending existed at `2e46835263`.
 * Mutants, each applied alone and restored:
 *   • feature_disabled read as an empty list                    → A2.
 *   • the `unavailable` condition dropped from the parsed list  → A3.
 *   • `valid()` accepting an items-less places body             → A4.
 *
 * Run: node --import tsx/esm --test src/features/discovery/trending/__tests__/trendingApi.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Api = typeof import('../trendingApi.ts');
let api: Api;
let calls: string[] = [];
let respond: (url: string) => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string) => { calls.push(String(url)); return Promise.resolve(respond(String(url))); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const reason = { code: 'gaining_independent_groups', text: 'More separate groups are visiting than before.' };

before(async () => {
  api = await import('../trendingApi.ts');
  const { _setTestToken } = await import('../../../trips/shared/auth.ts');
  _setTestToken(async () => 'tok');
});
beforeEach(() => { calls = []; });

describe('A. the four lists', () => {
  it('A1. places, for-you, emerging and areas each read their own route for the destination', async () => {
    respond = (u) => u.includes('/areas') ? json({ destination: 'lisbon', areas: [{ area: 'Alfama', state: 'trending', reason }], unavailable: null })
      : u.includes('/emerging') ? json({ destination: 'lisbon', items: [{ placeId: 'p1', state: 'emerging', reason }], trails: [{ trailId: 't1', state: 'emerging', reason }], unavailable: null, trailsUnavailable: null, readingProvenance: null })
      : json({ destination: 'lisbon', items: [{ placeId: 'p1', state: 'trending', reason }], unavailable: null, readingProvenance: null, basis: 'affinity' });
    const places = await api.fetchTrending('places', ' Lisbon ');
    assert.equal(calls[0], 'http://api.test/api/v1/discovery/trending/places?destination=Lisbon');
    assert.equal(places.state === 'ok' && places.data.places[0]!.placeId, 'p1');
    const forYou = await api.fetchTrending('for-you', 'Lisbon');
    assert.equal(forYou.state === 'ok' && forYou.data.basis, 'affinity');
    const emerging = await api.fetchTrending('emerging', 'Lisbon');
    assert.equal(emerging.state === 'ok' && emerging.data.trails[0]!.trailId, 't1');
    const areas = await api.fetchTrending('areas', 'Lisbon');
    assert.equal(areas.state === 'ok' && areas.data.areas[0]!.area, 'Alfama');
  });

  it('A2. THE POINT: switched off is `off`, worded as not available — never an empty list', async () => {
    respond = () => json({ error: 'feature_disabled', message: 'trending lists are not enabled' }, 404);
    const r = await api.fetchTrending('places', 'Lisbon');
    assert.equal(r.state, 'off');
    if (r.state === 'ok') return;
    assert.equal(api.trendingReadCopy(r), "Trending isn't available yet.");
  });

  it('A3. THE POINT: a list the run could not produce keeps its stated condition', async () => {
    respond = () => json({ destination: 'lisbon', items: [], unavailable: 'stale_snapshot', readingProvenance: null });
    const r = await api.fetchTrending('places', 'Lisbon');
    assert.equal(r.state === 'ok' && r.data.unavailable, 'stale_snapshot');
    assert.match(api.unavailableCopy('stale_snapshot', 'Lisbon'), /out of date/);
    assert.match(api.unavailableCopy('no_snapshot', 'Lisbon'), /isn't measured/);
  });

  it('A4. a 503, an unreadable body, or no destination is unavailable with words', async () => {
    respond = () => json({ error: 'degraded_unavailable', message: 'the stored trend states could not be read', reason: 'trend_read_failed' }, 503);
    const down = await api.fetchTrending('places', 'Lisbon');
    assert.equal(down.state, 'unavailable');
    respond = () => json({ destination: 'lisbon', unavailable: null });
    assert.equal((await api.fetchTrending('places', 'Lisbon')).state, 'unavailable');
    assert.equal((await api.fetchTrending('places', '  ')).state, 'unavailable');
    assert.equal(calls.length, 2, 'no request for a blank destination');
  });
});
