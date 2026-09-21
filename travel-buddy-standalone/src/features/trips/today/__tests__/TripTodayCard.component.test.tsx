/**
 * TripTodayCard — §11 reaching a screen, in §11.2's order. census-trips TR193,
 * TR317, TR319.
 *
 *   - the five answers render in order: now, next, who, canDo, changed
 *   - a non-NORMAL §17.2 switch renders its banner FIRST and discovery is not
 *     offered while the server says it is suppressed
 *   - an unavailable read says so and denies being a quiet day
 *   - only `off` renders nothing
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

import { TripTodayCard } from '../TripTodayCard.tsx';
import type { TodayRead, TripToday } from '../tripToday.ts';

const TRIP_ID = 'trip-today-test';

function today(over: Partial<TripToday> = {}): TripToday {
  return {
    projectionSchemaVersion: 1, generatedAt: '2026-09-13T12:00:00.000Z', sourceTripVersion: 9, freshness: 'live',
    tripId: TRIP_ID, decisionId: 'd1', stageReading: 'stage 1',
    nowState: { phase: 'FREE_TIME', reason: 'no plan is running', primaryFocus: null },
    health: 'HEALTHY', healthReasons: [],
    currentPlan: null,
    nextCommitment: { id: 'c1', type: 'dinner', arriveBy: '2026-09-13T18:00:00Z', startsAt: null, placeId: null, mustLeaveBy: '2026-09-13T17:30:00Z', windowId: 'w1' },
    freeWindows: [{ id: 'w1', beginsAt: '2026-09-13T12:00:00Z', endsAt: '2026-09-13T17:30:00Z', durationMinutes: 330, certified: false, confidence: 'LOW' }],
    crewSummary: { total: 2, accepted: 2, invited: 0, featureEnabled: true, liveSharing: 0, safeReturnActive: 0, withLocation: 0, detail: null },
    opportunities: { status: 'ok', items: [{ id: 'o1', title: 'Museum' }] },
    unresolvedActions: [],
    attention: { mode: 'NORMAL', priority: ['plans'], suppression: { commercial: false, discovery: false, reason: null, detail: null } },
    sensing: { level: 'idle', intervalSeconds: 900, reasons: [], reading: 'idle' },
    answers: { now: 'nowState', next: 'nextCommitment', who: 'crewSummary', canDo: 'freeWindows', changed: 'health' },
    ...over,
  };
}
const loader = (read: TodayRead) => jest.fn(async () => read);
const PLAN = { id: 'p1', title: 'Louvre', category: 'activity', status: 'in_progress', startsAt: '2026-09-13T14:00:00Z', endsAt: null, locationName: 'Musée du Louvre' };
// NOTE: intentional stub — the handoff itself is proved in
// src/features/trips/crew/__tests__/tripNavigationHandoff.test.ts; here the
// question is only whether the screen reaches it.
const navSeams = (over: { start?: any; resolve?: any } = {}) => ({
  startNav: over.start ?? jest.fn(async () => ({ state: 'started', url: 'https://maps', presence: { ok: true } as any, pending: {} as any })),
  resolveNav: over.resolve ?? jest.fn(async () => ({ state: 'nothing_pending' as const })),
});

describe('TripTodayCard', () => {
  it('renders nothing ONLY when the feature is off', async () => {
    const { toJSON, queryByTestId } = await render(<TripTodayCard tripId={TRIP_ID} load={loader({ state: 'off' })} />);
    await waitFor(() => expect(queryByTestId('trip-today-loading')).toBeNull());
    expect(toJSON()).toBeNull();
  });

  it('§10.3: a running plan with a place offers navigation, hands off on press, and says what it told the crew', async () => {
    const nav = navSeams();
    const { findByTestId, getByTestId } = await render(
      <TripTodayCard tripId={TRIP_ID} load={loader({ state: 'ok', today: today({ currentPlan: PLAN }), lagSeconds: 1 })} {...nav} />,
    );
    const button = await findByTestId('trip-today-navigate');
    expect(button.props.accessibilityLabel).toBe('Navigate to Musée du Louvre');
    fireEvent.press(button);
    await waitFor(() => expect(nav.startNav).toHaveBeenCalled());
    expect(nav.startNav.mock.calls[0][1]).toMatchObject({ planItemId: 'p1', locationName: 'Musée du Louvre', startsAt: '2026-09-13T14:00:00Z' });
    await waitFor(() => expect(getByTestId('trip-today-nav-note').props.children).toMatch(/on the way/));
  });

  it('§10.3: a plan with no place offers no navigation — there is nowhere to go', async () => {
    const { queryByTestId, findByTestId } = await render(
      <TripTodayCard tripId={TRIP_ID} load={loader({ state: 'ok', today: today({ currentPlan: { ...PLAN, locationName: null } }), lagSeconds: 1 })} {...navSeams()} />,
    );
    await findByTestId('trip-today-card');
    expect(queryByTestId('trip-today-navigate')).toBeNull();
  });

  it('§10.3 callback: reaching Today resolves a journey started earlier, and says what it decided', async () => {
    const resolve = jest.fn(async () => ({ state: 'arrived' as const, planItemId: 'p1', presence: { ok: true } as any }));
    const { findByTestId } = await render(
      <TripTodayCard tripId={TRIP_ID} load={loader({ state: 'ok', today: today({ currentPlan: PLAN }), lagSeconds: 1 })} {...navSeams({ resolve })} />,
    );
    await findByTestId('trip-today-card');
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(TRIP_ID));
    const note = await findByTestId('trip-today-nav-note');
    expect(note.props.children).toMatch(/arrived/);
  });

  it('§3.2: the phase block leads with what the phase is for, and the five answers still follow in §11.2\'s order', async () => {
    const { findByTestId, getByTestId, queryByTestId } = await render(
      <TripTodayCard tripId={TRIP_ID} load={loader({ state: 'ok', today: today({ currentPlan: PLAN, nowState: { phase: 'ACTIVE_PLAN', reason: 'a plan is running', primaryFocus: 'Current activity, participants, next constraint, leave-by time if relevant.' } }), lagSeconds: 1 })} {...navSeams()} />,
    );
    await findByTestId('trip-today-phase');
    expect(getByTestId('trip-today-phase-name').props.children).toBe('ACTIVE PLAN');
    expect(getByTestId('trip-today-phase-focus').props.children).toMatch(/leave-by time/);
    expect(getByTestId('trip-today-phase-plan')).toBeTruthy();
    expect(getByTestId('trip-today-phase-commitment')).toBeTruthy();
    expect(queryByTestId('trip-today-phase-windows')).toBeNull();
    // §11.2's five answers are untouched by the phase.
    expect(getByTestId('trip-today-answer-0-now')).toBeTruthy();
    expect(getByTestId('trip-today-answer-4-changed')).toBeTruthy();
  });

  it('§3.2: REST withholds the ideas and says so, instead of looking like a day with none', async () => {
    const { findByTestId, getByTestId, queryByTestId } = await render(
      <TripTodayCard tripId={TRIP_ID} load={loader({ state: 'ok', today: today({ nowState: { phase: 'REST', reason: 'resting', primaryFocus: null } }), lagSeconds: 1 })} {...navSeams()} />,
    );
    await findByTestId('trip-today-phase');
    expect(getByTestId('trip-today-phase-name').props.children).toBe('REST');
    expect(queryByTestId('trip-today-phase-opportunities')).toBeNull();
    const withheld = getByTestId('trip-today-phase-withheld-opportunities');
    expect(withheld.props.children.join('')).toMatch(/low-value interruptions/);
  });

  it('§3.2: a phase the server did not send renders no phase block at all', async () => {
    const { findByTestId, queryByTestId } = await render(
      <TripTodayCard tripId={TRIP_ID} load={loader({ state: 'ok', today: today({ nowState: { phase: 'LEAVE_BY_WINDOW' as any, reason: 'r', primaryFocus: null } }), lagSeconds: 1 })} {...navSeams()} />,
    );
    await findByTestId('trip-today-card');
    expect(queryByTestId('trip-today-phase')).toBeNull();
  });

  it('an unavailable read says so and denies being a quiet day', async () => {
    const { findByTestId, getByText } = await render(
      <TripTodayCard tripId={TRIP_ID} load={loader({ state: 'unavailable', detail: 'the projection declares itself stale', reason: 'TRIP_PROJECTION_STALE' })} />,
    );
    await findByTestId('trip-today-unavailable');
    expect(getByText(/TRIP_PROJECTION_STALE: the projection declares itself stale\. This is not a quiet day/)).toBeTruthy();
  });

  it('answers §11.2\'s five questions in order, with the phase as the headline and the sensing line last', async () => {
    const { findByTestId, getByText, queryByTestId } = await render(<TripTodayCard tripId={TRIP_ID} load={loader({ state: 'ok', today: today(), lagSeconds: 1 })} />);
    await findByTestId('trip-today-card');
    expect(getByText('Free time')).toBeTruthy();
    for (const [i, key] of ['now', 'next', 'who', 'canDo', 'changed'].entries()) {
      expect(queryByTestId(`trip-today-answer-${i}-${key}`)).not.toBeNull();
    }
    expect(getByText('dinner, arrive by 18:00 — leave by 17:30')).toBeTruthy();
    expect(getByText('330 min free until 17:30 (not certified) — 1 thing(s) you could do')).toBeTruthy();
    expect(getByText('Checking location every 15 min (idle)')).toBeTruthy();
    expect(queryByTestId('trip-today-attention')).toBeNull();
  });

  it('a SAFETY_EVENT switch puts the banner first and withholds discovery in the server\'s words', async () => {
    const t = today({
      health: 'CRITICAL', healthReasons: [{ code: 'SAFE_RETURN_ACTIVE', level: 'CRITICAL', subjectIds: ['u2'], detail: 'a Safe Return is active' }],
      attention: { mode: 'SAFETY_EVENT', priority: ['safety', 'official help', 'location coordination'], suppression: { commercial: true, discovery: true, reason: 'TRIP_DISRUPTION_SUPPRESSED', detail: 'Discovery is paused while a safety event is open' } },
      unresolvedActions: [{ kind: 'check_on_member', subjectIds: ['u2'], detail: 'Check on Alex', severity: 'critical' }],
    });
    const { findByTestId, getByText, queryByText, toJSON } = await render(<TripTodayCard tripId={TRIP_ID} load={loader({ state: 'ok', today: t, lagSeconds: 1 })} />);
    await findByTestId('trip-today-attention');
    expect(getByText('Safety first')).toBeTruthy();
    expect(getByText('safety → official help → location coordination. Discovery is paused while a safety event is open')).toBeTruthy();
    // The suppression sentence is the answer to "what can I do"; the museum is not offered.
    expect(getByText('Discovery is paused while a safety event is open')).toBeTruthy();
    expect(queryByText(/Museum/)).toBeNull();
    expect(getByText('• Check on Alex')).toBeTruthy();
    // The banner precedes the headline in the rendered tree.
    const json = JSON.stringify(toJSON());
    expect(json.indexOf('Safety first')).toBeLessThan(json.indexOf('Free time'));
  });
});
