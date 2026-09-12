/**
 * §11 Today on the client — the read and the five answers in order.
 * census-trips TR193, TR317, TR319, TR172.
 *
 * Run: node --import tsx/esm --test src/features/trips/today/__tests__/tripToday.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Mod = typeof import('../tripToday.ts');
let mod: Mod;
let calls: { url: string; init?: RequestInit }[] = [];
let respond: () => Response | Promise<Response> = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return Promise.resolve(respond()); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const NOW = Date.parse('2026-09-13T12:00:00Z');

function today(over: Record<string, unknown> = {}) {
  return {
    projectionSchemaVersion: 1, generatedAt: new Date(NOW - 5_000).toISOString(), sourceTripVersion: 9, freshness: 'live',
    tripId: 'trip-1', decisionId: 'd1', stageReading: 'stage 1', stageId: null,
    nowState: { phase: 'FREE_TIME', reason: 'no plan is running and the next commitment is 3 h away', primaryFocus: null },
    health: 'HEALTHY', healthReasons: [],
    currentPlan: null,
    nextCommitment: { id: 'c1', type: 'event', arriveBy: '2026-09-13T16:00:00Z', startsAt: '2026-09-13T16:00:00Z', placeId: 'p1', mustLeaveBy: '2026-09-13T15:20:00Z', windowId: 'w1' },
    freeWindows: [{ id: 'w1', beginsAt: '2026-09-13T12:00:00Z', endsAt: '2026-09-13T15:20:00Z', durationMinutes: 200, certified: false, confidence: 'LOW' }],
    crewSummary: { total: 3, accepted: 3, invited: 0, featureEnabled: true, liveSharing: 1, safeReturnActive: 0, withLocation: 1, detail: null },
    opportunities: { status: 'ok', items: [{ id: 'x1', title: 'Museum' }] },
    unresolvedActions: [], risks: [], riskTriggers: [], pulseSignals: { status: 'no_source', reason: 'none' },
    attention: { mode: 'NORMAL', priority: ['plans', 'discovery'], suppression: { commercial: false, discovery: false, reason: null, detail: null } },
    sensing: { level: 'idle', intervalSeconds: 900, reasons: [], reading: 'idle' },
    answers: { now: 'nowState', next: 'nextCommitment', who: 'crewSummary', canDo: 'freeWindows', changed: 'health' },
    ...over,
  };
}

describe('fetchTripToday', () => {
  before(async () => { mod = await import('../tripToday.ts'); const { _setTestToken } = await import('../../shared/auth.ts'); _setTestToken(async () => 'tok'); });
  beforeEach(() => { calls = []; });

  it('reads /today with the bearer token and accepts a live projection under the envelope', async () => {
    respond = () => new Response(JSON.stringify(today()), { status: 200 });
    const r = await mod.fetchTripToday('trip-1', { now: NOW });
    assert.equal(r.state, 'ok');
    if (r.state === 'ok') { assert.equal(r.today.tripId, 'trip-1'); assert.equal(r.lagSeconds, 5); }
    assert.equal(calls[0]!.url, 'http://api.test/api/trips/trip-1/today');
    assert.equal((calls[0]!.init?.headers as any).Authorization, 'Bearer tok');
  });
  it('a stale projection, or one of another schema, is refused with Appendix B\'s reason and is unavailable, never a quiet day', async () => {
    respond = () => new Response(JSON.stringify(today({ freshness: 'stale' })), { status: 200 });
    const stale = await mod.fetchTripToday('trip-1', { now: NOW });
    assert.equal(stale.state, 'unavailable'); if (stale.state === 'unavailable') assert.equal(stale.reason, 'TRIP_PROJECTION_STALE');
    respond = () => new Response(JSON.stringify(today({ projectionSchemaVersion: 2 })), { status: 200 });
    const other = await mod.fetchTripToday('trip-1', { now: NOW });
    assert.equal(other.state, 'unavailable'); if (other.state === 'unavailable') assert.equal(other.reason, 'TRIP_PROJECTION_SCHEMA_MISMATCH');
  });
  it('feature_disabled is off; any other refusal is unavailable with the server\'s reason; a network failure is unavailable', async () => {
    respond = () => new Response(JSON.stringify({ error: 'feature_disabled', message: 'off' }), { status: 404 });
    assert.equal((await mod.fetchTripToday('trip-1')).state, 'off');
    respond = () => new Response(JSON.stringify({ error: 'degraded_unavailable', reason: 'TRIP_PROJECTION_UNAVAILABLE', message: 'could not read' }), { status: 503 });
    const u = await mod.fetchTripToday('trip-1');
    assert.equal(u.state, 'unavailable'); if (u.state === 'unavailable') { assert.equal(u.reason, 'TRIP_PROJECTION_UNAVAILABLE'); assert.equal(u.detail, 'could not read'); }
    respond = () => { throw new Error('network down'); };
    const n = await mod.fetchTripToday('trip-1');
    assert.equal(n.state, 'unavailable'); if (n.state === 'unavailable') assert.match(n.detail, /network down/);
  });
  it('a body without the shape of Today is unreadable, not a day', async () => {
    respond = () => new Response(JSON.stringify({ projectionSchemaVersion: 1, generatedAt: new Date(NOW).toISOString(), sourceTripVersion: 1, freshness: 'live', tripId: 'trip-1' }), { status: 200 });
    const r = await mod.fetchTripToday('trip-1', { now: NOW });
    assert.equal(r.state, 'unavailable'); if (r.state === 'unavailable') assert.equal(r.detail, 'unreadable response');
  });
});

describe('the five answers, in §11.2\'s order', () => {
  before(async () => { mod = await import('../tripToday.ts'); });
  it('now, next, who, canDo, changed — each from the field the projection names', () => {
    const a = mod.todayAnswers(today() as any);
    assert.deepEqual(a.map((x) => x.key), ['now', 'next', 'who', 'canDo', 'changed']);
    assert.match(a[0]!.answer, /^Free time\. no plan is running/);
    assert.equal(a[1]!.answer, 'event, arrive by 16:00 — leave by 15:20');
    assert.equal(a[2]!.answer, '3 on the crew, 1 sharing live');
    assert.equal(a[3]!.answer, '200 min free until 15:20 (not certified) — 1 thing(s) you could do');
    assert.equal(a[4]!.answer, 'Nothing has changed');
  });
  it('a running plan is "now"; no next commitment and no window are said as such; health and unresolved actions are "changed"', () => {
    const a = mod.todayAnswers(today({
      nowState: { phase: 'ACTIVE_PLAN', reason: 'a plan is in progress', primaryFocus: 'plan' },
      currentPlan: { id: 'p1', title: 'Louvre', category: 'activity', status: 'in_progress', startsAt: null, endsAt: null, locationName: 'Paris' },
      nextCommitment: null, freeWindows: [], health: 'ATTENTION', healthReasons: [{ code: 'RISK_OPEN', level: 'ATTENTION', subjectIds: ['r1'], detail: 'one open risk' }],
      unresolvedActions: [{ kind: 'review_risk', subjectIds: ['r1'], detail: 'review the risk', severity: 'normal' }],
    }) as any);
    assert.equal(a[0]!.answer, 'On a plan — Louvre at Paris');
    assert.equal(a[1]!.answer, 'Nothing scheduled next');
    assert.equal(a[3]!.answer, 'No free window right now');
    assert.equal(a[4]!.answer, 'ATTENTION: one open risk · 1 thing(s) need a decision');
  });
  it('when the §17.2 switch suppresses discovery, "what can I do" is the server\'s suppression sentence and the banner names the priority', () => {
    const t = today({ attention: { mode: 'SAFETY_EVENT', priority: ['safety', 'official help', 'location coordination'], suppression: { commercial: true, discovery: true, reason: 'TRIP_DISRUPTION_SUPPRESSED', detail: 'Discovery is paused while a safety event is open' } } }) as any;
    const a = mod.todayAnswers(t);
    assert.equal(a[3]!.answer, 'Discovery is paused while a safety event is open');
    assert.deepEqual(mod.attentionBanner(t), { title: 'Safety first', detail: 'safety → official help → location coordination. Discovery is paused while a safety event is open' });
    assert.equal(mod.attentionBanner(today() as any), null);
    const atRisk = mod.attentionBanner(today({ attention: { mode: 'AT_RISK_MODE', priority: ['logistics', 'affected commitments', 'recovery'], suppression: { commercial: true, discovery: false, reason: null, detail: null } } }) as any);
    assert.deepEqual(atRisk, { title: 'This trip needs attention', detail: 'logistics → affected commitments → recovery' });
  });
  it('the headline is the phase in words, or "not in progress"; crew without the map feature says so; the sensing line is the server\'s interval', () => {
    assert.equal(mod.todayHeadline(today() as any), 'Free time');
    assert.equal(mod.todayHeadline(today({ nowState: { phase: null, reason: 'the trip has not started', primaryFocus: null } }) as any), 'Not in progress today');
    const a = mod.todayAnswers(today({ crewSummary: { total: 4, accepted: 3, invited: 1, featureEnabled: false, liveSharing: null, safeReturnActive: null, withLocation: null, detail: 'off' } }) as any);
    assert.equal(a[2]!.answer, '3 of 4 on the crew; where they are is not shared here');
    assert.equal(mod.sensingLine(today() as any), 'Checking location every 15 min (idle)');
    assert.equal(mod.sensingLine(today({ sensing: { level: 'safety', intervalSeconds: 30, reasons: ['SAFE_RETURN_ACTIVE'], reading: 'x' } }) as any), 'Checking location every 30 s (safety) — SAFE_RETURN_ACTIVE');
  });
});
