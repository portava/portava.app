/**
 * services/discoveryRecommendations.ts — the client call to
 * GET /v1/discovery/recommendations/:kind (census-discovery §94, lane W11-X2;
 * §91.7 item 2; DC-01).
 *
 * THE CLIENT IS REAL. Only `fetch` and the token source are replaced.
 *
 *   S1  the request: /api/v1/discovery/recommendations/<kind>, the destination
 *       as a query parameter, the viewer's bearer token
 *   S2  200: the ranked page, in the server's order, recommendation ids kept
 *   S3  no token: `signed_out`, and NO request leaves the device
 *   S4  404 → disabled, 401 → signed_out, 400 → invalid: kept apart
 *   S5  503 → unavailable: a failed read is never an empty list
 *   S6  a thrown fetch → network; an unparseable or shapeless body → unavailable
 *   S7  the labels a card prints, per kind
 *
 * Run: node --import tsx --test src/services/__tests__/discoveryRecommendations.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getOutputKindRecommendations,
  outputKindItemLabel,
  outputKindItemId,
  _setOutputKindsTokenSourceForTests,
} from '../discoveryRecommendations.ts';

const API = 'http://api.test';
const realFetch = globalThis.fetch;
let calls: Array<{ url: string; auth: string | null }> = [];

function answer(status: number, body: unknown) {
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? null });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = API;
  _setOutputKindsTokenSourceForTests(async () => 'tok-1');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  _setOutputKindsTokenSourceForTests(null);
});

describe('getOutputKindRecommendations (§94)', () => {
  it('S1 asks the one route, with the destination and the viewer token', async () => {
    answer(200, { kind: 'trails', rankedBy: 'pde', items: [], cursor: null });
    await getOutputKindRecommendations('trails', { destination: 'Miami' });
    assert.deepEqual(calls, [{ url: `${API}/api/v1/discovery/recommendations/trails?destination=Miami`, auth: 'Bearer tok-1' }]);
    calls = [];
    await getOutputKindRecommendations('shared_moments');
    assert.equal(calls[0]?.url, `${API}/api/v1/discovery/recommendations/shared_moments`);
  });

  it("S2 200: the server's page in the server's order, recommendation ids kept", async () => {
    const items = [{ id: 't2', title: 'Rooftops', destination: 'miami', recommendationId: 'r0' }, { id: 't1', title: 'Beaches', destination: 'miami', recommendationId: 'r1' }];
    answer(200, { kind: 'trails', rankedBy: 'pde', items, cursor: null });
    const r = await getOutputKindRecommendations('trails', { destination: 'Miami' });
    assert.deepEqual(r, { ok: true, kind: 'trails', rankedBy: 'pde', items });
  });

  it('S3 no token: signed_out, and no request is sent', async () => {
    _setOutputKindsTokenSourceForTests(async () => null);
    answer(200, { items: [] });
    assert.deepEqual(await getOutputKindRecommendations('trails'), { ok: false, reason: 'signed_out' });
    assert.equal(calls.length, 0);
  });

  it('S4 404 → disabled, 401 → signed_out, 400 → invalid', async () => {
    answer(404, { error: 'feature_disabled' });
    assert.deepEqual(await getOutputKindRecommendations('trails'), { ok: false, reason: 'disabled' });
    answer(401, { error: 'unauthorized' });
    assert.deepEqual(await getOutputKindRecommendations('trails'), { ok: false, reason: 'signed_out' });
    answer(400, { error: 'invalid_payload' });
    assert.deepEqual(await getOutputKindRecommendations('emerging_discoveries'), { ok: false, reason: 'invalid' });
  });

  it('S5 503: unavailable — a failed read is never an empty list', async () => {
    answer(503, { error: 'degraded_unavailable', reason: 'trails' });
    assert.deepEqual(await getOutputKindRecommendations('trails'), { ok: false, reason: 'unavailable' });
  });

  it('S6 a thrown fetch is network; an unparseable or shapeless body is unavailable', async () => {
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.deepEqual(await getOutputKindRecommendations('trails'), { ok: false, reason: 'network' });
    answer(200, 'not json');
    assert.deepEqual(await getOutputKindRecommendations('trails'), { ok: false, reason: 'unavailable' });
    answer(200, { kind: 'trails' });
    assert.deepEqual(await getOutputKindRecommendations('trails'), { ok: false, reason: 'unavailable' });
  });

  it('S7 what a card prints, per kind', () => {
    assert.equal(outputKindItemLabel('trails', { id: 't', title: 'Rooftops', destination: null }), 'Rooftops');
    assert.equal(outputKindItemLabel('shared_moments', { id: 'm', title: 'Sunset', city: null }), 'Sunset');
    assert.equal(outputKindItemLabel('emerging_discoveries', { place: { id: 'db/1', name: 'Café Luna' }, trendState: 'emerging' }), 'Café Luna');
    assert.equal(outputKindItemId('emerging_discoveries', { place: { id: 'db/1', name: 'x' }, trendState: 'emerging' }), 'db/1');
    assert.equal(outputKindItemId('trails', { id: 't9', title: null, destination: null }), 't9');
  });
});
