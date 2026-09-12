/**
 * §7.3 conflicts read from the timeline projection — census-trips TR130.
 * Run: node --import tsx/esm --test src/features/trips/timeline/__tests__/tripTimeline.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Mod = typeof import('../tripTimeline.ts');
let mod: Mod;
let respond: () => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.resolve(respond())) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });
const NOW = Date.parse('2026-09-13T12:00:00Z');

function timeline(over: Record<string, unknown> = {}) {
  return {
    projectionSchemaVersion: 1, generatedAt: new Date(NOW).toISOString(), sourceTripVersion: 4, freshness: 'live',
    tripId: 'trip-1', tripStartDate: '2026-09-12', tripEndDate: '2026-09-14', canEdit: true, itemCount: 3,
    days: [
      { iso: '2026-09-12', dateLabel: 'Sat 12 Sep', dateSub: 'Day 1', items: [{ id: 'a', title: 'Arrive' }], conflictIds: [] },
      { iso: '2026-09-13', dateLabel: 'Sun 13 Sep', dateSub: 'Day 2', items: [{ id: 'b', title: 'Louvre' }, { id: 'c', title: 'Lunch' }], conflictIds: ['b', 'c'] },
    ],
    undated: [], tripDayCount: 2, tripTimezone: 'Europe/Paris', stages: [], stageZoneReading: 'x',
    conflicts: [{ reason: 'TRIP_TEMPORAL_CONFLICT', kind: 'PLAN_OVERLAP', commitmentIds: [], planIds: ['b', 'c'], shortfallMinutes: 30, overridden: false, detail: 'Louvre and Lunch overlap by 30 min' }],
    atRiskPlanIds: ['b', 'c'], atRiskReading: 'AT_RISK is derived',
    ...over,
  };
}

describe('fetchTripTimeline and conflictedDays', () => {
  before(async () => { mod = await import('../tripTimeline.ts'); const { _setTestToken } = await import('../../shared/auth.ts'); _setTestToken(async () => 'tok'); });
  beforeEach(() => { respond = () => new Response(JSON.stringify(timeline()), { status: 200 }); });

  it('the days that carry a conflict, with their plans and the §7.3 kind; a clean day is not listed', async () => {
    const r = await mod.fetchTripTimeline('trip-1', { now: NOW });
    assert.equal(r.state, 'ok');
    if (r.state !== 'ok') return;
    const days = mod.conflictedDays(r.timeline);
    assert.deepEqual(days, [{ iso: '2026-09-13', dateLabel: 'Sun 13 Sep', dateSub: 'Day 2', plans: [{ id: 'b', title: 'Louvre' }, { id: 'c', title: 'Lunch' }], kinds: ['PLAN_OVERLAP'] }]);
    assert.equal(mod.conflictKindLabel('PLAN_OVERLAP'), 'Two plans overlap in time');
    assert.equal(mod.conflictKindLabel('NO_TIME_TO_TRAVEL'), 'Not enough time to travel between them');
    assert.equal(mod.conflictKindLabel('SOMETHING_NEW'), 'something new');
  });
  it('a clean timeline has no conflicted day — measured, not assumed', async () => {
    respond = () => new Response(JSON.stringify(timeline({ conflicts: [], atRiskPlanIds: [], days: [{ iso: '2026-09-12', dateLabel: 'Sat 12 Sep', dateSub: 'Day 1', items: [{ id: 'a', title: 'Arrive' }], conflictIds: [] }] })), { status: 200 });
    const r = await mod.fetchTripTimeline('trip-1', { now: NOW });
    assert.equal(r.state, 'ok'); if (r.state === 'ok') assert.deepEqual(mod.conflictedDays(r.timeline), []);
  });
  it('stale or foreign-schema projections are refused by name; a failed read is unavailable, never clean', async () => {
    respond = () => new Response(JSON.stringify(timeline({ freshness: 'stale' })), { status: 200 });
    const s = await mod.fetchTripTimeline('trip-1', { now: NOW });
    assert.equal(s.state, 'unavailable'); if (s.state === 'unavailable') assert.equal(s.reason, 'TRIP_PROJECTION_STALE');
    respond = () => new Response(JSON.stringify({ error: 'degraded_unavailable', reason: 'TRIP_PROJECTION_UNAVAILABLE', message: 'no dates' }), { status: 503 });
    const u = await mod.fetchTripTimeline('trip-1');
    assert.equal(u.state, 'unavailable'); if (u.state === 'unavailable') assert.equal(u.detail, 'no dates');
    respond = () => new Response(JSON.stringify({ projectionSchemaVersion: 1, generatedAt: new Date(NOW).toISOString(), sourceTripVersion: 1, freshness: 'live', tripId: 'trip-1', days: 'nope' }), { status: 200 });
    const b = await mod.fetchTripTimeline('trip-1', { now: NOW });
    assert.equal(b.state, 'unavailable');
  });
});
