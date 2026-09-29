/**
 * TM-live (WP-11) TRIP-F21 — free time, "I'm bored", opportunities, replan,
 * simulate, impact preview and Trip Pulse, through the REAL service
 * (tripFreeTime.ts → features/live/liveApi.ts + services/tripProjectionEnvelope.ts).
 * Only `fetch` is faked, answering in server/trips/readRoutes/tripProjections.ts's shapes.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import { TripFreeTimeCard } from '../TripFreeTimeCard.tsx';
import { TripReplanCard } from '../TripReplanCard.tsx';
import { changeOf } from '../tripFreeTime.ts';
import { _setLiveTestToken } from '../../../live/liveApi.ts';

process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://sb.test';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';

const TRIP = '11111111-2222-4333-8444-555555555555';
const ENVELOPE = () => ({ projectionSchemaVersion: 1, generatedAt: new Date().toISOString(), sourceTripVersion: 7, freshness: 'live' });
const W = { id: 'w1', position: 'between', beginsAt: '2026-09-29T13:00:00Z', endsAt: '2026-09-29T17:00:00Z', durationMinutes: 240, origin: null, requiredDestination: { commitmentId: 'c1', arriveBy: '2026-09-29T17:30:00Z' }, participants: [], hardConstraints: [], confidence: 'MEDIUM', certified: false, reservedMinutes: 30, afterCommitmentId: null, beforeCommitmentId: 'c1' };
const EXP = { id: 'w1:saved:3', windowId: 'w1', candidateId: 'saved:3', placeId: null, name: 'Marble Mountains', primitive: 'x', verdict: 'EXECUTABLE', reasonCodes: [], arriveAt: '2026-09-29T13:30:00Z', leaveBy: '2026-09-29T16:30:00Z', stayMinutes: 150, travel: {}, participants: [], servesGoalIds: [], score: 0.8, properties: {}, explanation: ['fits the window with 30 min spare'], source: 'saved' };
const FREEDOM = { status: 200, body: { ...ENVELOPE(), tripId: TRIP, decisionId: 'd', windows: [W], derivedEvents: {}, conflicts: [], commitmentCount: 1, reading: 'one window' } };
const OPPS = (mode = 'NORMAL') => ({ status: 200, body: { ...ENVELOPE(), tripId: TRIP, decisionId: 'd', attention: { mode }, windows: [{ windowId: 'w1', window: {}, executable: [EXP], uncertain: [], notExecutable: [], candidates: 1 }], event: null, notify: {}, recorded: {}, sources: {}, derivedFrom: {}, reading: 'portfolio compiled' } });

type Ans = { status: number; body: unknown };
type Call = { method: string; path: string; body: any };
let calls: Call[] = [];
function serve(route: (method: string, path: string, body: any) => Ans | undefined) {
  (global as any).fetch = jest.fn(async (raw: string, init: RequestInit = {}) => {
    const u = new URL(raw);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body });
    const a = route(method, u.pathname, body) ?? { status: 404, body: { error: 'not_found' } };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  });
}
const base = (over: Record<string, Ans> = {}) => (m: string, p: string): Ans | undefined => {
  const key = `${m} ${p.replace(`/api/trips/${TRIP}`, '')}`;
  if (over[key]) return over[key];
  if (key === 'GET /freedom-windows') return FREEDOM;
  if (key === 'GET /opportunities') return OPPS();
  return undefined;
};

beforeEach(() => { calls = []; _setLiveTestToken(async () => 'tok'); });
afterEach(() => _setLiveTestToken(null));

describe('TRIP-F21 TripFreeTimeCard', () => {
  it('shows the free windows with the options compiled for them; Add to plan goes through the server', async () => {
    serve(base({ [`POST /opportunities/${encodeURIComponent(EXP.id)}/accept`]: { status: 201, body: { ok: true, duplicate: false, version: 8, eventId: 'e', planItem: {}, experienceId: EXP.id } } }));
    const { findByTestId, getByText, getByTestId } = await render(<TripFreeTimeCard tripId={TRIP} />);
    await findByTestId('trip-window-w1');
    expect(getByText('Marble Mountains')).toBeTruthy();
    fireEvent.press(getByTestId(`trip-window-option-${EXP.id}-add`));
    await waitFor(() => expect(getByTestId(`trip-window-option-${EXP.id}-result`).props.children).toBe('Added to your plan (tentative).'));
    expect(calls.some((c) => c.method === 'POST' && c.path === `/api/trips/${TRIP}/opportunities/${encodeURIComponent(EXP.id)}/accept`)).toBe(true);
  });

  it('with the kernel off, Add to plan says nothing was added, by name', async () => {
    serve(base({ [`POST /opportunities/${encodeURIComponent(EXP.id)}/accept`]: { status: 503, body: { ok: false, reason: 'TRIP_KERNEL_UNAVAILABLE', detail: null } } }));
    const { findByTestId, getByTestId } = await render(<TripFreeTimeCard tripId={TRIP} />);
    fireEvent.press(await findByTestId(`trip-window-option-${EXP.id}-add`));
    await waitFor(() => expect(getByTestId(`trip-window-option-${EXP.id}-result`).props.children).toMatch(/^Not added: plan changes are written only through the trip kernel/));
  });

  it('a projection §19.1 refuses (another schema) is a failure, never a free day', async () => {
    serve(base({ 'GET /freedom-windows': { status: 200, body: { ...FREEDOM.body, projectionSchemaVersion: 2 } } }));
    const { findByTestId, queryByTestId } = await render(<TripFreeTimeCard tripId={TRIP} />);
    expect((await findByTestId('trip-free-failed'))).toBeTruthy();
    expect(queryByTestId('trip-free-none')).toBeNull();
  });

  it('under a non-NORMAL switch the options are withheld, in the server\'s words', async () => {
    serve(base({ 'GET /opportunities': OPPS('SAFETY_EVENT') }));
    const { findByTestId, queryByTestId } = await render(<TripFreeTimeCard tripId={TRIP} />);
    expect((await findByTestId('trip-opps-suppressed')).props.children.join('')).toMatch(/held back while the trip is in safety event — portfolio compiled/);
    expect(queryByTestId(`trip-window-option-${EXP.id}`)).toBeNull();
  });

  it("I'm bored: the window containing now and what fits in it; a failed ask is a failure", async () => {
    let ok = false;
    serve((m, p) => {
      if (m === 'GET' && p.endsWith('/bored')) {
        return ok ? { status: 200, body: { tripId: TRIP, now: '', window: { id: 'w1', beginsAt: W.beginsAt, endsAt: W.endsAt, durationMinutes: 240, minutesLeft: 120 }, nextWindow: null, candidates: { windowId: 'w1', executable: [EXP], uncertain: [], notExecutable: 0, suppressed: false }, readings: { window: 'free until 17:00', candidates: '1 executable, 0 uncertain, 0 not executable', touched: 'nothing' }, sourceTripVersion: 7 } }
          : { status: 503, body: { error: 'degraded_unavailable', reason: 'TRIP_PROJECTION_UNAVAILABLE', message: 'freedom read failed' } };
      }
      return base()(m, p);
    });
    const { findByTestId, getByTestId } = await render(<TripFreeTimeCard tripId={TRIP} />);
    fireEvent.press(await findByTestId('trip-bored'));
    expect((await findByTestId('trip-bored-failed')).props.children).toMatch(/^Couldn't load what you could do now — TRIP_PROJECTION_UNAVAILABLE/);
    ok = true;
    fireEvent.press(getByTestId('trip-bored'));
    await findByTestId('trip-bored-answer');
    expect(getByTestId(`trip-bored-option-${EXP.id}`)).toBeTruthy();
    expect(getByTestId('trip-bored-reading').props.children).toBe('1 executable, 0 uncertain, 0 not executable');
  });
});

describe('TRIP-F21 TripReplanCard', () => {
  const PULSE = { status: 200, body: { ...ENVELOPE(), tripId: TRIP, decisionId: 'd', attention: { mode: 'NORMAL' }, signals: [{}, {}], dropped: [{}], sources: [{ name: 'weather', status: 'ok' }, { name: 'transit', status: 'unread' }], transportReliability: [], context: {}, derivedFrom: {}, reading: 'two signals kept' } };
  const ENTRY = { op: 'move', planId: 'p1', title: 'Museum', from: { startsAt: '2026-09-29T14:00:00Z', endsAt: null }, to: { startsAt: '2026-09-29T15:30:00Z', endsAt: '2026-09-29T16:30:00Z' }, reason: 'PLAN_IN_CONFLICT', detail: 'clashes with lunch', sharedMutation: true, impact: null, experienceId: null };
  const REPLAN = (created: unknown[] = [], skipped: string | null = null) => ({ status: 200, body: { tripId: TRIP, sourceTripVersion: 7, unread: [], diff: { day: '2026-09-29', entries: [{ ...ENTRY, op: 'keep' }, ENTRY], counts: {}, proposals: [ENTRY], requiresUserConfirmation: false, summary: '1 move' }, proposals: { created, skipped } } });

  it('pulse names the source it could not read', async () => {
    serve((m, p) => (m === 'GET' && p.endsWith('/pulse') ? PULSE : undefined));
    const { findByTestId, getByTestId } = await render(<TripReplanCard tripId={TRIP} />);
    expect((await findByTestId('trip-pulse-counts')).props.children.join('')).toMatch(/^2 signals that matter to this trip; 1 filtered out\./);
    expect(getByTestId('trip-pulse-unread').props.children.join('')).toMatch(/transit/);
  });

  it('replan shows a diff and changes nothing; simulate and impact read one change; proposals are sent only when asked', async () => {
    serve((m, p, body) => {
      if (m === 'GET' && p.endsWith('/pulse')) return PULSE;
      if (m === 'POST' && p.endsWith('/replan')) return body?.createProposals ? REPLAN([{ entryIndex: 1, proposalId: 'prop-1', duplicate: false, reason: null }]) : REPLAN();
      if (m === 'POST' && p.endsWith('/simulate')) return { status: 200, body: { tripId: TRIP, sourceTripVersion: 7, unread: [], simulation: { change: 'move', feasibility: 'FEASIBLE', reasonCode: null, conflicts: [], impact: { summary: 'moves Museum' }, windowAfter: null, explanation: ['fits 15:30–16:30'] } } };
      if (m === 'POST' && p.endsWith('/proposals/preview')) return { status: 200, body: { tripId: TRIP, sourceTripVersion: 7, unread: [], preview: { summary: 'Moves Museum; 2 people affected', changesConfirmedPlan: false, affectedParticipants: ['a', 'b'], bookingSideEffects: { bookingsAtRisk: [] }, governance: { suggestedDecisionRule: 'majority' } } } };
      return undefined;
    });
    const { findByTestId, getByTestId, queryByTestId } = await render(<TripReplanCard tripId={TRIP} />);
    fireEvent.press(await findByTestId('trip-replan'));
    await findByTestId('trip-replan-diff');
    expect(queryByTestId('trip-replan-entry-0')).toBeNull(); // `keep` is not a change
    expect(calls.find((c) => c.path.endsWith('/replan'))!.body).toEqual({});
    fireEvent.press(getByTestId('trip-replan-entry-1-simulate'));
    await waitFor(() => expect(getByTestId('trip-replan-entry-1-simulation').props.children).toBe('Feasible. fits 15:30–16:30'));
    expect(calls.find((c) => c.path.endsWith('/simulate'))!.body).toEqual({ change: { kind: 'move_plan', targetId: 'p1', startsAt: '2026-09-29T15:30:00Z', endsAt: '2026-09-29T16:30:00Z' } });
    fireEvent.press(getByTestId('trip-replan-entry-1-impact'));
    await waitFor(() => expect(getByTestId('trip-replan-entry-1-impact-result').props.children).toBe('Moves Museum; 2 people affected · decided by majority'));
    fireEvent.press(getByTestId('trip-replan-propose'));
    await waitFor(() => expect(getByTestId('trip-replan-sent').props.children).toBe('1 proposal sent to the crew.'));
    expect(calls.filter((c) => c.path.endsWith('/replan'))[1].body).toEqual({ createProposals: true });
  });

  it('proposals the server skipped (kernel off) are said to be skipped, not sent', async () => {
    serve((m, p, body) => {
      if (m === 'GET' && p.endsWith('/pulse')) return PULSE;
      if (m === 'POST' && p.endsWith('/replan')) return REPLAN([], body?.createProposals ? 'trip_kernel_enabled is false' : null);
      return undefined;
    });
    const { findByTestId, getByTestId } = await render(<TripReplanCard tripId={TRIP} />);
    fireEvent.press(await findByTestId('trip-replan'));
    fireEvent.press(await findByTestId('trip-replan-propose'));
    await waitFor(() => expect(getByTestId('trip-replan-sent').props.children).toBe('No proposals were created: trip_kernel_enabled is false.'));
  });

  it('changeOf: cancel and add map to §9.4 kinds; keep is no change', () => {
    expect(changeOf({ ...ENTRY, op: 'cancel' } as any)).toEqual({ kind: 'cancel_plan', targetId: 'p1' });
    expect(changeOf({ ...ENTRY, op: 'add', planId: null } as any)).toMatchObject({ kind: 'add_plan', targetId: null, title: 'Museum' });
    expect(changeOf({ ...ENTRY, op: 'keep' } as any)).toBeNull();
  });
});
