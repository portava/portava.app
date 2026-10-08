/**
 * Discovery Trails on the client — the read/write contract every Trails screen
 * stands on (owner decision 2026-10-04: Trails are a user-facing feature).
 *
 * SHOWN RED FIRST: on `2e46835263` no client module called /v1/discovery/trails
 * (the file does not load). Mutants, each applied alone and restored:
 *   • listTrails accepting a body without `trails[]` as an empty list → A2.
 *   • followAfter trusting a 'done' with no `following` field         → B2.
 *   • proposeTrail dropping the §6 suggested parent on a 409          → C2.
 *   • hrefForItem guessing a route for an `itinerary`                 → D1.
 *
 * Run: node --import tsx/esm --test src/features/discovery/trails/__tests__/trailsApi.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Api = typeof import('../trailsApi.ts');
type Model = typeof import('../trailModel.ts');
let api: Api;
let model: Model;
let calls: { url: string; init?: RequestInit }[] = [];
let respond: (url: string, init?: RequestInit) => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return Promise.resolve(respond(String(url), init)); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const T = { id: 't1', slug: 'bangkok-after-dark', title: 'Bangkok After Dark', description: null, destination: 'bangkok', parentTrailId: null, lifecycle: 'active', createdAt: '2026-09-01T00:00:00Z' };

before(async () => {
  api = await import('../trailsApi.ts');
  model = await import('../trailModel.ts');
  const { _setTestToken } = await import('../../../trips/shared/auth.ts');
  _setTestToken(async () => 'tok');
});
beforeEach(() => { calls = []; });

describe('A. reading Trails', () => {
  it('A1. the list carries the query and destination it was asked for', async () => {
    respond = () => json({ trails: [T] });
    const r = await api.listTrails({ q: ' night ', destination: 'Bangkok' });
    assert.deepEqual(r, { state: 'ok', data: [T] });
    assert.equal(calls[0]!.url, 'http://api.test/api/v1/discovery/trails?q=night&destination=Bangkok');
  });

  it('A2. THE POINT: a failed or unreadable list is never "no Trails"', async () => {
    respond = () => json({ error: 'degraded_unavailable', message: 'trails are not available in this deployment' }, 503);
    const down = await api.listTrails();
    assert.equal(down.state, 'unavailable');
    respond = () => json({ notTrails: [] });
    assert.equal((await api.listTrails()).state, 'unavailable');
    respond = () => json({ error: 'feature_disabled' }, 404);
    assert.equal((await api.listTrails()).state, 'off');
  });

  it('A3. detail, modules, related and follow read their own routes and shapes', async () => {
    respond = (u) => u.endsWith('/modules') ? json({ modules: [{ key: 'trending_now', objective: 'momentum', horizonMs: null, items: [{ id: 'c1', sourceType: 'place', sourceId: 'p1' }], moreFromThisPlace: {}, explorationSlots: null }] })
      : u.endsWith('/related') ? json({ related: [{ trail: T, edgeType: 'child', direction: 'out' }] })
      : u.endsWith('/follow') ? json({ following: true })
      : json({ trail: T, status: 'healthy', memberCount: 4 });
    assert.equal((await api.getTrail('t1')).state, 'ok');
    const m = await api.getTrailModules('t1');
    assert.equal(m.state === 'ok' && m.data[0]!.items[0]!.sourceId, 'p1');
    const rel = await api.getRelatedTrails('t1');
    assert.equal(rel.state === 'ok' && rel.data[0]!.edgeType, 'child');
    assert.deepEqual(await api.getTrailFollow('t1'), { state: 'ok', data: true });
  });
});

describe('B. writing', () => {
  it('B1. follow is PUT, unfollow is DELETE, report POSTs one of the five reasons', async () => {
    respond = () => json({ following: true });
    await api.setTrailFollow('t1', true);
    assert.equal(calls[0]!.init?.method, 'PUT');
    respond = () => json({ following: false });
    await api.setTrailFollow('t1', false);
    assert.equal(calls[1]!.init?.method, 'DELETE');
    respond = () => json({ reported: true }, 202);
    const rep = await api.reportTrail('t1', 'stale');
    assert.equal(rep.state, 'done');
    assert.equal(calls[2]!.init?.body, JSON.stringify({ reason: 'stale' }));
  });

  it('B2. the follow state after a write is the server\'s word, or nothing', async () => {
    assert.equal(api.followAfter({ state: 'done', status: 200, data: { following: true } }), true);
    assert.equal(api.followAfter({ state: 'done', status: 200, data: {} }), null);
    assert.equal(api.followAfter({ state: 'unavailable', detail: 'x' }), null);
  });
});

describe('C. proposing a Trail', () => {
  it('C1. 201 is created, with the Trail the server made', async () => {
    respond = () => json({ trail: T }, 201);
    const r = await api.proposeTrail({ title: ' Bangkok After Dark ', destination: 'Bangkok' });
    assert.deepEqual(r, { state: 'created', trail: T });
    assert.equal(JSON.parse(String(calls[0]!.init?.body)).title, 'Bangkok After Dark');
  });

  it('C2. THE POINT: a §5 refusal carries its checks and §6\'s suggested parent', async () => {
    respond = () => json({ error: 'canonicalization_refused', refusals: [{ check: 'semantic_overlap', conflictsWith: 't9' }], suggestedParentTrailId: 't9' }, 409);
    assert.deepEqual(await api.proposeTrail({ title: 'Bangkok nightlife' }), {
      state: 'canonicalization_refused', checks: [{ check: 'semantic_overlap', conflictsWith: 't9' }], suggestedParentTrailId: 't9',
    });
  });

  it('C3. a 400 is refused with its words; a 503 or an unreadable answer is unavailable — never "created"', async () => {
    respond = () => json({ error: 'invalid_payload', message: 'title is required' }, 400);
    assert.deepEqual(await api.proposeTrail({ title: 'x' }), { state: 'refused', detail: 'title is required' });
    respond = () => json({ error: 'degraded_unavailable', message: 'trails are not available in this deployment' }, 503);
    assert.equal((await api.proposeTrail({ title: 'Kyoto temples' })).state, 'unavailable');
    respond = () => json({ notATrail: true }, 201);
    assert.equal((await api.proposeTrail({ title: 'Kyoto temples' })).state, 'unavailable');
  });
});

describe('D. presentation', () => {
  it('D1. a member links to the screen this app has for it, and to nothing when there is none', () => {
    assert.equal(model.hrefForItem({ sourceType: 'place', sourceId: 'p 1' }), '/place/p%201');
    assert.equal(model.hrefForItem({ sourceType: 'post', sourceId: 'x' }), '/post/x');
    assert.equal(model.hrefForItem({ sourceType: 'event', sourceId: 'x' }), '/event/x');
    assert.equal(model.hrefForItem({ sourceType: 'itinerary', sourceId: 'x' }), null);
  });

  it('D2. module and check names read as words', () => {
    assert.equal(model.moduleLabel('trending_now'), 'Trending now');
    assert.equal(model.moduleLabel('new_kind'), 'New kind');
    assert.match(model.canonicalCheckCopy('semantic_overlap'), /overlaps/);
    assert.match(model.canonicalCheckCopy('something_else'), /something_else/);
  });
});
