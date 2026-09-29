/**
 * census-discovery §105 (DV-83 round 9, register D-W11X2-60): the output-kinds rail's
 * service branches on the Discovery refusal envelope's `coverage`.
 *
 * The route speaks `11` §9 status codes, but a 200 body that carries a refusal is
 * a failed read too (the Trail read routes send one beside their body since §105).
 * `nothing` is `unavailable`, never an empty page; `partial` keeps its rows and says
 * so (`partial: true`), so the rail can print the browse list's partial line.
 *
 *   RR1  a 200 with refusal coverage `nothing` → unavailable
 *   RR2  a 200 with refusal coverage `partial` → ok, rows kept, partial: true
 *   RR3  CONTROL: a 200 with no refusal → ok, no `partial` key
 *   RR4  (§107, CM1) a refusal with a MISSING or UNKNOWN coverage → unavailable, never a complete page
 *   RR5  (§107, D-W11X2-69) 503 `stop_unreadable` (the Discovery stop could not be read) → unavailable, never `disabled`
 *
 * Run: node --import tsx --test src/services/__tests__/discoveryRecommendationsRefusal.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getOutputKindRecommendations, _setOutputKindsTokenSourceForTests } from '../discoveryRecommendations.ts';

const realFetch = globalThis.fetch;
function answer(status: number, body: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}
beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; _setOutputKindsTokenSourceForTests(async () => 'tok-1'); });
afterEach(() => { globalThis.fetch = realFetch; _setOutputKindsTokenSourceForTests(null); });

const refusal = (coverage: 'nothing' | 'partial') => ({ class: 'transient_db', code: 'trail_member_sources_unread', route: 'r', coverage, failedSources: ['trail_member_sources'] });
const trail = { id: 't1', title: 'Beach mornings', destination: 'miami' };

describe('getOutputKindRecommendations branches on refusal coverage (§105)', () => {
  it('RR1 a 200 carrying a `nothing` refusal is a failed read, never an empty page', async () => {
    answer(200, { kind: 'trails', rankedBy: 'pde', items: [], cursor: null, refusal: refusal('nothing') });
    assert.deepEqual(await getOutputKindRecommendations('trails'), { ok: false, reason: 'unavailable' });
  });

  it('RR2 a 200 carrying a `partial` refusal keeps its rows and says it is partial', async () => {
    answer(200, { kind: 'trails', rankedBy: 'pde', items: [trail], cursor: null, refusal: refusal('partial') });
    const r = await getOutputKindRecommendations('trails');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.items, [trail]);
    assert.equal(r.partial, true);
  });

  it('RR3 CONTROL: no refusal → a complete page, with no partial key', async () => {
    answer(200, { kind: 'trails', rankedBy: 'pde', items: [trail], cursor: null });
    const r = await getOutputKindRecommendations('trails');
    assert.deepEqual(r, { ok: true, kind: 'trails', rankedBy: 'pde', items: [trail] });
  });

  it('RR4 (§107, CM1) a refusal with a missing or unknown coverage is a failed read, never a complete page', async () => {
    answer(200, { kind: 'trails', rankedBy: 'pde', items: [trail], cursor: null, refusal: { class: 'transient_db', code: 'x', route: 'r' } });
    assert.deepEqual(await getOutputKindRecommendations('trails'), { ok: false, reason: 'unavailable' });
    answer(200, { kind: 'trails', rankedBy: 'pde', items: [trail], cursor: null, refusal: { class: 'transient_db', code: 'x', route: 'r', coverage: 'some_future_value' } });
    assert.deepEqual(await getOutputKindRecommendations('trails'), { ok: false, reason: 'unavailable' });
  });

  it('RR5 (§107, D-W11X2-69) 503 stop_unreadable is a failed read, never the flag-off `disabled`', async () => {
    answer(503, { error: 'degraded_unavailable', message: 'these recommendations could not be checked just now', reason: 'stop_unreadable' });
    assert.deepEqual(await getOutputKindRecommendations('trails'), { ok: false, reason: 'unavailable' });
  });
});
