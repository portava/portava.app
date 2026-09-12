/**
 * §20.3 on the client — the questions read, the answer posted. census-trips TR390, TR385.
 * Run: node --import tsx/esm --test src/features/trips/closeout/__tests__/tripCloseout.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Mod = typeof import('../tripCloseout.ts');
let mod: Mod;
let calls: { url: string; init?: RequestInit }[] = [];
let respond: (url: string, init?: RequestInit) => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return Promise.resolve(respond(String(url), init)); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const closeout = (over: Record<string, unknown> = {}) => ({
  tripId: 'trip-1', tripStatus: 'completed', performedAt: '2026-09-15T10:00:00Z',
  steps: [
    { step: 'stop_temporary_presence', status: 'not_applicable', detail: 'none' },
    { step: 'reconcile_uncertain_plan_outcomes', status: 'actionable', ids: ['p1'], detail: '1 plan(s)' },
    { step: 'project_passport_memory_candidates', status: 'deferred', detail: 'kernel off' },
  ],
  questions: [{ planId: 'p1', question: 'Did you make it to Hoi An?', answers: ['completed', 'skipped'] }],
  unread: [],
  ...over,
});

describe('fetchTripCloseout / answerCloseoutQuestion', () => {
  before(async () => { mod = await import('../tripCloseout.ts'); const { _setTestToken } = await import('../../shared/auth.ts'); _setTestToken(async () => 'tok'); });
  beforeEach(() => { calls = []; });

  it('reads the closeout plan with its questions in the spec\'s words, and summarises the steps', async () => {
    respond = () => new Response(JSON.stringify(closeout()), { status: 200 });
    const r = await mod.fetchTripCloseout('trip-1');
    assert.equal(r.state, 'ok');
    if (r.state !== 'ok') return;
    assert.equal(r.closeout.questions[0]!.question, 'Did you make it to Hoi An?');
    assert.equal(mod.closeoutSummary(r.closeout), '1 step(s) would act on completion · 1 deferred here');
    assert.equal(mod.closeoutSummary(closeout({ steps: [{ step: 'x', status: 'performed', detail: '' }, { step: 'y', status: 'failed', detail: '' }], unread: ['trip_plan_items'] }) as any), '1 step(s) performed · 1 failed · 1 input(s) not read');
    assert.equal(mod.closeoutSummary(closeout({ steps: [] }) as any), 'Nothing to do at closeout');
  });
  it('an answer is POSTed as { planId, answer } with the bearer token, and a 201 with the kernel receipt is "recorded"', async () => {
    respond = () => new Response(JSON.stringify({ ok: true, planId: 'p1', answer: 'completed', kernel: { version: 3, eventId: 'e1', duplicate: false } }), { status: 201 });
    const r = await mod.answerCloseoutQuestion('trip-1', 'p1', 'completed');
    assert.deepEqual(r, { state: 'recorded', planId: 'p1', answer: 'completed', duplicate: false });
    assert.equal(calls[0]!.url, 'http://api.test/api/trips/trip-1/closeout/answers');
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { planId: 'p1', answer: 'completed' });
    assert.equal((calls[0]!.init?.headers as any).Authorization, 'Bearer tok');
  });
  it('the server\'s refusal is carried by name — TRIP_KERNEL_UNAVAILABLE means the answer was NOT recorded — and a network failure is unavailable', async () => {
    respond = () => new Response(JSON.stringify({ ok: false, error: 'degraded_unavailable', reason: 'TRIP_KERNEL_UNAVAILABLE', detail: 'trip_kernel_enabled is off' }), { status: 503 });
    const r = await mod.answerCloseoutQuestion('trip-1', 'p1', 'skipped');
    assert.deepEqual(r, { state: 'refused', reason: 'TRIP_KERNEL_UNAVAILABLE', detail: 'trip_kernel_enabled is off' });
    respond = () => { throw new Error('offline'); };
    const n = await mod.answerCloseoutQuestion('trip-1', 'p1', 'skipped');
    assert.equal(n.state, 'unavailable');
  });
  it('a closeout that cannot be read is unavailable, and feature_disabled is off', async () => {
    respond = () => new Response(JSON.stringify({ error: 'forbidden', message: 'not crew' }), { status: 403 });
    const u = await mod.fetchTripCloseout('trip-1');
    assert.equal(u.state, 'unavailable'); if (u.state === 'unavailable') assert.equal(u.detail, 'not crew');
    respond = () => new Response(JSON.stringify({ error: 'feature_disabled' }), { status: 404 });
    assert.equal((await mod.fetchTripCloseout('trip-1')).state, 'off');
  });
});
