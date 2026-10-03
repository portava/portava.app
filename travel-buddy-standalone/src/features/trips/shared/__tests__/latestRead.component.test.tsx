/**
 * Latest request wins on the trip cards (census-trips §79; DV-83's
 * stale-response class).
 *
 * Each case starts two overlapping reads of one card and answers them in the
 * WRONG order — the newer read first, the older one last. Before the guard the
 * card drew whatever arrived last, so the older answer overwrote the newer
 * one: a tally without the vote just recorded, a notes list without the note
 * just added, another trip's Today.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';

import { latestReadCounter } from '../latestRead.ts';
import { TripBallotsCard } from '../../planning/TripBallotsCard.tsx';
import { TripTodayCard } from '../../today/TripTodayCard.tsx';
import { TripSharedContentSection } from '../../sharedContent/TripSharedContentSection.tsx';
import type { DecisionRead } from '../../planning/tripDecisions.ts';
import type { TodayRead, TripToday } from '../../today/tripToday.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('latestReadCounter', () => {
  it('only the newest read is current, and invalidate() retires it', () => {
    const c = latestReadCounter();
    const a = c.begin();
    expect(a()).toBe(true);
    const b = c.begin();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
    c.invalidate();
    expect(b()).toBe(false);
  });
});

// ── Ballots: two votes, two re-reads, answered out of order ─────────────────

const proposal = (id: string, title: string, myVote: string | null) => ({
  id, type: 'change_plan', status: 'pending', decisionRule: 'majority', proposedBy: 'u2', expiresAt: null,
  payload: { title }, myVote,
  tally: { found: true, decision_rule: 'majority', electorate: 3, yes: 0, no: 0, abstain: 0, cast: 0, majority_met: false },
});
const board = (proposals: unknown[]): DecisionRead => ({
  state: 'ok',
  board: { tripId: 't1', asOf: 'x', goals: [], decisionTasks: [], risks: [], proposals: proposals as any, tallyFailures: 0, recommendations: [], elementRisks: [] },
});

it('TripBallotsCard: the re-read after the SECOND vote is not overwritten by the slower re-read after the first', async () => {
  const afterFirst = deferred<DecisionRead>();
  const afterSecond = deferred<DecisionRead>();
  const load = jest.fn()
    .mockResolvedValueOnce(board([proposal('p1', 'Dinner', null), proposal('p2', 'Museum', null)]))
    .mockReturnValueOnce(afterFirst.promise)
    .mockReturnValueOnce(afterSecond.promise);
  const cast = jest.fn().mockResolvedValue({ state: 'recorded', duplicate: false });
  await render(<TripBallotsCard tripId="t1" isOwner={false} load={load} cast={cast} />);
  await waitFor(() => screen.getByTestId('ballot-p1-yes'));
  await act(async () => { fireEvent.press(screen.getByTestId('ballot-p1-yes')); });
  await act(async () => { fireEvent.press(screen.getByTestId('ballot-p2-yes')); });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  // The newer re-read answers first, with both ballots…
  await act(async () => { afterSecond.resolve(board([proposal('p1', 'Dinner', 'yes'), proposal('p2', 'Museum', 'yes')])); });
  // …and the older one arrives last, from before the second vote.
  await act(async () => { afterFirst.resolve(board([proposal('p1', 'Dinner', 'yes'), proposal('p2', 'Museum', null)])); });
  expect(screen.getByTestId('ballot-myvote-p2').props.children).toBe('You voted yes');
});

// ── Today: the trip changes under a mounted card ────────────────────────────

function today(tripId: string, location: string): TripToday {
  return {
    projectionSchemaVersion: 1, generatedAt: '2026-09-13T12:00:00.000Z', sourceTripVersion: 9, freshness: 'live',
    tripId, decisionId: 'd1', stageReading: 'stage 1',
    nowState: { phase: 'IN_PLAN', reason: 'a plan is running', primaryFocus: null },
    health: 'HEALTHY', healthReasons: [],
    currentPlan: { id: 'p1', title: location, category: 'activity', status: 'in_progress', startsAt: '2026-09-13T14:00:00Z', endsAt: null, locationName: location },
    nextCommitment: null,
    freeWindows: [],
    crewSummary: { total: 1, accepted: 1, invited: 0, featureEnabled: true, liveSharing: 0, safeReturnActive: 0, withLocation: 0, detail: null },
    opportunities: { status: 'ok', items: [] },
    unresolvedActions: [],
    attention: { mode: 'NORMAL', priority: ['plans'], suppression: { commercial: false, discovery: false, reason: null, detail: null } },
    sensing: { level: 'idle', intervalSeconds: 900, reasons: [], reading: 'idle' },
    answers: { now: 'nowState', next: 'nextCommitment', who: 'crewSummary', canDo: 'freeWindows', changed: 'health' },
  } as TripToday;
}

it("TripTodayCard: trip A's slow answer is not drawn once the card is showing trip B", async () => {
  const forA = deferred<TodayRead>();
  const forB = deferred<TodayRead>();
  const load = jest.fn((id: string) => (id === 'A' ? forA.promise : forB.promise));
  const resolveNav = jest.fn(async () => ({ state: 'nothing_pending' as const }));
  const view = await render(<TripTodayCard tripId="A" load={load as any} resolveNav={resolveNav as any} />);
  await view.rerender(<TripTodayCard tripId="B" load={load as any} resolveNav={resolveNav as any} />);
  await act(async () => { forB.resolve({ state: 'ok', today: today('B', 'Prado'), lagSeconds: 1 } as TodayRead); });
  await act(async () => { forA.resolve({ state: 'ok', today: today('A', 'Louvre'), lagSeconds: 1 } as TodayRead); });
  expect(screen.getByText('Navigate to Prado')).toBeTruthy();
  expect(screen.queryByText('Navigate to Louvre')).toBeNull();
});

// ── Shared notes: a note added while the first list read is still out ───────

it('TripSharedContentSection: the list read after adding a note is not overwritten by the slower first read', async () => {
  const first = deferred<any>();
  const second = deferred<any>();
  const note = (id: string, content: string) => ({ id, title: null, content, is_private: false, created_at: '2026-10-01T00:00:00Z' });
  const client: any = {
    fetchNotes: jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    createNote: jest.fn().mockResolvedValue({ state: 'done', data: {}, status: 201 }),
  };
  await render(<TripSharedContentSection tripId="t1" isHost={false} client={client} />);
  await act(async () => { fireEvent.changeText(screen.getByTestId('shared-note-input'), 'Meet at 9'); });
  await act(async () => { fireEvent.press(screen.getByTestId('shared-note-add')); });
  await waitFor(() => expect(client.fetchNotes).toHaveBeenCalledTimes(2));
  await act(async () => { second.resolve({ state: 'ok', data: [note('n1', 'Meet at 9')] }); });
  await act(async () => { first.resolve({ state: 'ok', data: [] }); });
  expect(screen.getByTestId('shared-note-n1')).toBeTruthy();
  expect(screen.queryByTestId('shared-notes-empty')).toBeNull();
});

// ── Decisions: the trip changes under a mounted card ────────────────────────

it("TripDecisionsCard: trip A's slow board is not drawn once the card is showing trip B", async () => {
  const { TripDecisionsCard } = require('../../planning/TripDecisionsCard.tsx');
  const risk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, status: 'open', impact: 'low' }));
  const withRisks = (n: number): DecisionRead => ({
    state: 'ok',
    board: { tripId: 'x', asOf: 'x', goals: [], decisionTasks: [], risks: risk(n) as any, proposals: [], tallyFailures: 0, recommendations: [], elementRisks: [] },
  });
  const forA = deferred<DecisionRead>();
  const forB = deferred<DecisionRead>();
  const load = jest.fn((id: string) => (id === 'A' ? forA.promise : forB.promise));
  const view = await render(<TripDecisionsCard tripId="A" load={load} />);
  await view.rerender(<TripDecisionsCard tripId="B" load={load} />);
  await act(async () => { forB.resolve(withRisks(2)); });
  await act(async () => { forA.resolve(withRisks(1)); });
  expect(screen.getByText('2 open risks')).toBeTruthy();
});

it("TripBallotsCard: trip A's slow board is not drawn once the card is showing trip B", async () => {
  const forA = deferred<DecisionRead>();
  const forB = deferred<DecisionRead>();
  const load = jest.fn((id: string) => (id === 'A' ? forA.promise : forB.promise));
  const view = await render(<TripBallotsCard tripId="A" isOwner={false} load={load} />);
  await view.rerender(<TripBallotsCard tripId="B" isOwner={false} load={load} />);
  await act(async () => { forB.resolve(board([proposal('pb', 'Prado tickets', null)])); });
  await act(async () => { forA.resolve(board([proposal('pa', 'Louvre tickets', null)])); });
  expect(screen.getByText('Prado tickets')).toBeTruthy();
  expect(screen.queryByText('Louvre tickets')).toBeNull();
});

it('TripTodayCard: an answer that lands after the card unmounted does not steer the attention switch', async () => {
  const pending = deferred<TodayRead>();
  const onAttention = jest.fn();
  const resolveNav = jest.fn(async () => ({ state: 'nothing_pending' as const }));
  const view = await render(<TripTodayCard tripId="A" load={(() => pending.promise) as any} onAttention={onAttention} resolveNav={resolveNav as any} />);
  await view.unmount();
  await act(async () => { pending.resolve({ state: 'ok', today: today('A', 'Louvre'), lagSeconds: 1 } as TodayRead); });
  expect(onAttention).not.toHaveBeenCalled();
});
