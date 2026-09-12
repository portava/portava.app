/**
 * §17.3 rescue on the client — the problem named in the server's vocabulary, the plan rendered as given. census-trips TR318.
 * Run: node --import tsx/esm --test src/features/trips/disruption/__tests__/tripRescue.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Mod = typeof import('../tripRescue.ts');
let mod: Mod;
let calls: { url: string; init?: RequestInit }[] = [];
let respond: () => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return Promise.resolve(respond()); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const response = (over: Record<string, unknown> = {}) => ({
  tripId: 'trip-1',
  plan: { problem: 'missed_transport', severity: 'major', declare: { kind: 'transport', severity: 'major', note: 'missed' },
    steps: [{ order: 1, action: 'Rebook', who: 'traveller', detail: 'next departure' }], escalation: [{ to: 'airline', why: 'rebooking', when: 'now' }],
    compass: { may: ['organise'], mustNot: ['act for the airline'] }, safeReturn: 'offer', explanation: ['x'] },
  declared: { ok: true, disruptionId: 'd1', duplicate: false, reason: null, skipped: null },
  ...over,
});

describe('requestRescue', () => {
  before(async () => { mod = await import('../tripRescue.ts'); const { _setTestToken } = await import('../../shared/auth.ts'); _setTestToken(async () => 'tok'); });
  beforeEach(() => { calls = []; });
  it('POSTs the problem and returns the server\'s plan and declaration', async () => {
    respond = () => new Response(JSON.stringify(response()), { status: 201 });
    const r = await mod.requestRescue('trip-1', 'missed_transport');
    assert.equal(r.state, 'ok'); if (r.state !== 'ok') return;
    assert.equal(calls[0]!.url, 'http://api.test/api/trips/trip-1/rescue');
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { problem: 'missed_transport' });
    assert.equal(r.response.plan.steps[0]!.action, 'Rebook');
    assert.equal(mod.declaredLine(r.response), 'Disruption declared — the trip is now under attention');
  });
  it('the declaration line is the server\'s word: skipped with the kernel off, duplicate, refused', () => {
    assert.equal(mod.declaredLine(response({ declared: { ok: false, disruptionId: null, duplicate: false, reason: null, skipped: 'trip_kernel_enabled is false' } }) as any), 'Disruption not declared: trip_kernel_enabled is false');
    assert.equal(mod.declaredLine(response({ declared: { ok: true, disruptionId: 'd1', duplicate: true, reason: null, skipped: null } }) as any), 'Disruption already declared — the crew is on the same page');
    assert.equal(mod.declaredLine(response({ declared: { ok: false, disruptionId: null, duplicate: false, reason: 'TRIP_AUTH_NOT_CREW', skipped: null } }) as any), 'Disruption not declared: TRIP_AUTH_NOT_CREW');
  });
  it('a refusal is unavailable with the server\'s message; feature_disabled is off; a malformed plan is unreadable', async () => {
    respond = () => new Response(JSON.stringify({ error: 'invalid_payload', message: 'problem must be one of …' }), { status: 400 });
    const u = await mod.requestRescue('trip-1', 'stranded');
    assert.equal(u.state, 'unavailable'); if (u.state === 'unavailable') assert.match(u.detail, /problem must be one of/);
    respond = () => new Response(JSON.stringify({ error: 'feature_disabled' }), { status: 404 });
    assert.equal((await mod.requestRescue('trip-1', 'stranded')).state, 'off');
    respond = () => new Response(JSON.stringify({ tripId: 'trip-1', plan: {} }), { status: 201 });
    assert.equal((await mod.requestRescue('trip-1', 'stranded')).state, 'unavailable');
  });
});
