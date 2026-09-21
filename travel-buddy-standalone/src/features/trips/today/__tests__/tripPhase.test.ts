/**
 * Trips spec §3.2 — the phase decides what the screen leads with, and in two
 * phases what it withholds (census-trips TR38–TR45).
 *
 * Run: node --import tsx/esm --test src/features/trips/today/__tests__/tripPhase.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPERATIONAL_PHASES, isOperationalPhase, phasePresentation, phaseView, phaseSuppresses,
} from '../tripPhase.ts';
import type { TripToday } from '../tripToday.ts';

const base = (over: Partial<TripToday> = {}): TripToday => ({
  projectionSchemaVersion: 1, generatedAt: '2026-09-13T12:00:00.000Z', sourceTripVersion: 9, freshness: 'live',
  tripId: 't1', decisionId: 'd1', stageReading: 'stage 1',
  nowState: { phase: 'FREE_TIME', reason: 'no plan is running', primaryFocus: null },
  health: 'HEALTHY', healthReasons: [],
  currentPlan: { id: 'p1', title: 'Louvre', category: 'activity', status: 'in_progress', startsAt: '2026-09-13T14:00:00Z', endsAt: null, locationName: 'Musée du Louvre' },
  nextCommitment: { id: 'c1', type: 'dinner', arriveBy: '2026-09-13T18:00:00Z', startsAt: null, placeId: null, mustLeaveBy: '2026-09-13T17:30:00Z', windowId: 'w1' },
  freeWindows: [{ id: 'w1', beginsAt: '2026-09-13T12:00:00Z', endsAt: '2026-09-13T17:30:00Z', durationMinutes: 330, certified: false, confidence: 'LOW' }],
  crewSummary: { total: 3, accepted: 2, invited: 1, featureEnabled: true, liveSharing: 1, safeReturnActive: 1, withLocation: 1, detail: null },
  opportunities: { status: 'ok', items: [{ id: 'o1', title: 'Rooftop' }, { id: 'o2', title: 'Market' }] },
  unresolvedActions: [{ kind: 'booking', subjectIds: ['b1'], detail: 'confirm the hotel', severity: 'critical' }],
  attention: { mode: 'NORMAL', priority: ['plans'], suppression: { commercial: false, discovery: false, reason: null, detail: null } },
  sensing: { level: 'idle', intervalSeconds: 900, reasons: [], reading: 'idle' },
  answers: { now: 'nowState', next: 'nextCommitment', who: 'crewSummary', canDo: 'freeWindows', changed: 'health' },
  ...over,
} as TripToday);

const keys = (t: TripToday) => phaseView(t).sections.map((s) => s.key);

describe('§3.2 — the vocabulary is the server\'s', () => {
  it('is exactly the eight phases TripOperationalPhase.ts emits, in its order', () => {
    assert.deepEqual([...OPERATIONAL_PHASES], ['ARRIVAL_DAY', 'FREE_TIME', 'ACTIVE_PLAN', 'TRANSIT', 'NIGHTLIFE', 'REST', 'DEPARTURE_DAY', 'DISRUPTED']);
    for (const p of OPERATIONAL_PHASES) assert.ok(isOperationalPhase(p), p);
    for (const notAPhase of ['LEAVE_BY_WINDOW', 'AT_RISK', 'arrival_day', '', null, 7]) {
      assert.equal(isOperationalPhase(notAPhase), false, String(notAPhase));
    }
  });
  it('every phase carries §3.2\'s second column and a lead order', () => {
    for (const p of OPERATIONAL_PHASES) {
      const pres = phasePresentation(p)!;
      assert.ok(pres.focus.length > 20, p);
      assert.ok(pres.lead.length > 0, p);
      assert.equal(new Set(pres.lead).size, pres.lead.length, `${p} leads with a duplicate`);
      for (const k of pres.suppress) assert.ok(!pres.lead.includes(k), `${p} both leads with and suppresses ${k}`);
    }
  });
});

describe('§3.2 — each phase leads with its own thing', () => {
  it('FREE_TIME leads with the windows, then what could be done, then who is around', () => {
    assert.deepEqual(keys(base()), ['windows', 'opportunities', 'crew']);
  });
  it('ACTIVE_PLAN leads with the plan and the next constraint', () => {
    assert.deepEqual(keys(base({ nowState: { phase: 'ACTIVE_PLAN', reason: 'r', primaryFocus: null } })), ['plan', 'commitment', 'crew']);
  });
  it('TRANSIT leads with the destination and the group, not the free windows', () => {
    const k = keys(base({ nowState: { phase: 'TRANSIT', reason: 'r', primaryFocus: null } }));
    assert.deepEqual(k, ['commitment', 'crew', 'plan']);
    assert.ok(!k.includes('windows'));
  });
  it('NIGHTLIFE leads with the crew — crew state and safe return are the point', () => {
    assert.deepEqual(keys(base({ nowState: { phase: 'NIGHTLIFE', reason: 'r', primaryFocus: null } })), ['crew', 'opportunities', 'commitment']);
  });
  it('ARRIVAL_DAY and DEPARTURE_DAY lead with what has to be sorted out, not with ideas', () => {
    assert.deepEqual(keys(base({ nowState: { phase: 'ARRIVAL_DAY', reason: 'r', primaryFocus: null } })), ['actions', 'crew', 'commitment']);
    assert.deepEqual(keys(base({ nowState: { phase: 'DEPARTURE_DAY', reason: 'r', primaryFocus: null } })), ['commitment', 'actions', 'opportunities']);
  });
  it('an unknown or absent phase leads with nothing: §11.2\'s five answers are the fallback order', () => {
    for (const p of ['LEAVE_BY_WINDOW', null, undefined, 'anything']) {
      const v = phaseView(base({ nowState: { phase: p as any, reason: 'r', primaryFocus: null } }));
      assert.equal(v.phase, null); assert.deepEqual(v.sections, []); assert.deepEqual(v.withheld, []);
    }
  });
});

describe('§3.2 — REST and DISRUPTED withhold, and say so', () => {
  it('REST suppresses the opportunities and the windows, and names the reason rather than dropping them silently', () => {
    const t = base({ nowState: { phase: 'REST', reason: 'r', primaryFocus: null } });
    assert.deepEqual(keys(t), ['health', 'actions'].filter((k) => k !== 'health' || t.healthReasons.length > 0 || t.health !== 'HEALTHY'));
    const v = phaseView(t);
    assert.deepEqual(v.withheld.map((w) => w.key).sort(), ['opportunities', 'windows']);
    for (const w of v.withheld) assert.match(w.reason, /low-value interruptions/);
    assert.equal(phaseSuppresses(t, 'opportunities'), true);
    assert.equal(phaseSuppresses(t, 'crew'), false, 'resting does not hide the crew');
  });
  it('DISRUPTED is recovery-first: state and what is open lead, and the commercial surface is deprioritised by name', () => {
    const t = base({ nowState: { phase: 'DISRUPTED', reason: 'r', primaryFocus: null }, health: 'CRITICAL', healthReasons: [{ code: 'X', level: 'critical', subjectIds: [], detail: 'flight cancelled' }] });
    assert.deepEqual(keys(t), ['health', 'actions', 'commitment']);
    assert.equal(phaseView(t).withheld[0]?.key, 'opportunities');
    assert.match(phaseView(t).withheld[0]!.reason, /Recovery first|recovery first/);
  });
  it('a suppressed section with NOTHING in it is not reported as withheld — there was nothing to withhold', () => {
    const t = base({ nowState: { phase: 'REST', reason: 'r', primaryFocus: null }, opportunities: { status: 'ok', items: [] }, freeWindows: [] });
    assert.deepEqual(phaseView(t).withheld, []);
  });
});

describe('§17.2 outranks §3.2', () => {
  it('a switch that suppressed discovery withholds the opportunities in every phase that would have led with them, in the server\'s words', () => {
    for (const phase of ['FREE_TIME', 'NIGHTLIFE', 'DEPARTURE_DAY'] as const) {
      const t = base({
        nowState: { phase, reason: 'r', primaryFocus: null },
        attention: { mode: 'SAFETY_EVENT', priority: ['safety'], suppression: { commercial: true, discovery: true, reason: 'SAFETY_EVENT', detail: 'Discovery is paused while a safety event is open' } },
      });
      assert.ok(!keys(t).includes('opportunities'), phase);
      const w = phaseView(t).withheld.find((x) => x.key === 'opportunities');
      assert.ok(w, `${phase} must SAY it withheld them`);
      assert.equal(w!.reason, 'Discovery is paused while a safety event is open');
      assert.equal(phaseSuppresses(t, 'opportunities'), true);
    }
  });
  it('the switch does not touch anything else: the crew, the plan and the next constraint still lead', () => {
    const t = base({
      nowState: { phase: 'ACTIVE_PLAN', reason: 'r', primaryFocus: null },
      attention: { mode: 'SAFETY_EVENT', priority: ['safety'], suppression: { commercial: true, discovery: true, reason: 'SAFETY_EVENT', detail: null } },
    });
    assert.deepEqual(keys(t), ['plan', 'commitment', 'crew']);
  });
});

describe('§3.2 — the sections are the projection, never invented', () => {
  it('a section with no data does not render, and the rest keep their order', () => {
    const t = base({ nowState: { phase: 'ACTIVE_PLAN', reason: 'r', primaryFocus: null }, currentPlan: null });
    assert.deepEqual(keys(t), ['commitment', 'crew']);
  });
  it('a crew the feature has not enabled is not a crew of zero', () => {
    const t = base({ nowState: { phase: 'NIGHTLIFE', reason: 'r', primaryFocus: null }, crewSummary: { ...base().crewSummary, featureEnabled: false } });
    assert.ok(!keys(t).includes('crew'));
  });
  it('the server\'s own primaryFocus wins over this client\'s copy of the column', () => {
    const v = phaseView(base({ nowState: { phase: 'FREE_TIME', reason: 'r', primaryFocus: 'the server said this' } }));
    assert.equal(v.focus, 'the server said this');
    assert.equal(phaseView(base()).focus, phasePresentation('FREE_TIME')!.focus, 'and the column stands in when it did not');
  });
});
