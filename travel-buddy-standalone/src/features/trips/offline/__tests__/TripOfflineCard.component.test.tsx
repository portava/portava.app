/**
 * TripOfflineCard — §18 reaching a screen. census-trips TR334, TR421, TR432.
 *
 *   - no copy yet: says so and offers the refresh
 *   - a stored copy: version, expiry and contents; stale is drawn as stale, in the server's words
 *   - the queue: pending changes listed; a revalidate-marked one offers confirmation when the version is known
 *   - a replay reports the server's counts and never drops a failed replay
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

import { TripOfflineCard } from '../TripOfflineCard.tsx';
import type { StoredBundle, QueuedEntry, ReplayResult, SignedBundle } from '../tripOffline.ts';

const TRIP_ID = 'trip-offline-test';
const NOW = Date.parse('2026-09-13T12:00:00Z');
function signed(over: Partial<SignedBundle['bundle']> = {}): SignedBundle {
  return {
    bundle: {
      bundleSchemaVersion: 1, tripId: TRIP_ID, sourceTripVersion: 7, generatedAt: '2026-09-13T10:00:00.000Z', expiresAt: '2026-09-14T10:00:00.000Z',
      contents: { nextCommitments: [], activePlan: null, plans: [{ id: 'p1', title: 'Louvre', status: 'confirmed', dayDate: '2026-09-13', startsAt: null, endsAt: null, locationName: null }], meetingPoints: [], criticalAddresses: [{ kind: 'reservation', id: 'r1', title: 'Hotel', address: '1 rue X', at: null }], certifiedContext: { sourceTripVersion: 7, certifiedAt: '2026-09-13T10:00:00.000Z', reading: 'x' } },
      notCarried: {}, ...over,
    },
    signature: 'a'.repeat(64), algorithm: 'hmac-sha256',
  };
}
const stored = (over: Partial<SignedBundle['bundle']> = {}): StoredBundle => ({ signed: signed(over), storedAt: '2026-09-13T10:00:01.000Z' });
const entry = (id: string, type: string, state: QueuedEntry['state'] = 'pending', note: string | null = null): QueuedEntry => ({ op: { operationId: id, tripId: TRIP_ID, expectedTripVersion: 7, type, payload: {}, clientOccurredAt: '2026-09-13T11:00:00.000Z', idempotencyKey: `k-${id}` }, state, note });

function seams(o: { stored?: StoredBundle | null; queue?: QueuedEntry[]; replay?: ReplayResult } = {}) {
  return {
    loadStored: jest.fn(async () => o.stored ?? null),
    queue: jest.fn(async () => o.queue ?? []),
    fetchBundle: jest.fn(async () => ({ state: 'ok' as const, signed: signed({ sourceTripVersion: 8 }) })),
    store: jest.fn(async (_t: string, s: SignedBundle) => ({ signed: s, storedAt: '2026-09-13T12:00:00.000Z' })),
    replay: jest.fn(async () => o.replay ?? ({ state: 'nothing_queued' as const })),
    revalidate: jest.fn(async () => true),
  };
}

describe('TripOfflineCard', () => {
  it('with no copy, says so and refreshes into a stored copy on request', async () => {
    const s = seams();
    const { findByTestId, getByText } = await render(<TripOfflineCard tripId={TRIP_ID} now={() => NOW} {...s} />);
    await findByTestId('trip-offline-card');
    expect(getByText('No offline copy yet')).toBeTruthy();
    fireEvent.press(await findByTestId('trip-offline-refresh'));
    await waitFor(() => expect(s.store).toHaveBeenCalled());
    await waitFor(() => expect(getByText('Offline copy ready')).toBeTruthy());
    expect(getByText(/Read at version 8/)).toBeTruthy();
  });
  it('a stale copy is drawn as stale, in the server\'s words, and is still shown', async () => {
    const s = seams({ stored: stored() });
    const { findByTestId, getByText } = await render(<TripOfflineCard tripId={TRIP_ID} currentTripVersion={9} now={() => NOW} {...s} />);
    await findByTestId('trip-offline-stale');
    expect(getByText('Offline copy is stale')).toBeTruthy();
    expect(getByText(/read at trip version 7 and the trip is at 9/)).toBeTruthy();
    expect(getByText(/1 plan\(s\), 0 commitment\(s\), 1 address\(es\), 0 meeting point\(s\)/)).toBeTruthy();
  });
  it('lists the queue, offers confirmation for a revalidate-marked change when the version is known, and reports a replay\'s counts', async () => {
    const replay: ReplayResult = { state: 'replayed', currentVersion: 9, counts: { replayed: 1, duplicates: 0, conflicted: 1, rejected: 0, revalidate: 1 }, settled: [{ op: entry('c', 'JOIN_PLAN').op, outcome: 'conflict', reasonCode: 'TRIP_VERSION_CONFLICT', detail: 'the trip moved on' }], remaining: [entry('b', 'CANCEL_PLAN', 'revalidate', 'confirm against version 9')], reading: null };
    const s = seams({ stored: stored(), queue: [entry('a', 'JOIN_PLAN'), entry('b', 'CANCEL_PLAN', 'revalidate', 'confirm against version 9'), entry('c', 'JOIN_PLAN')], replay });
    const { findByTestId, getByText, queryByTestId } = await render(<TripOfflineCard tripId={TRIP_ID} currentTripVersion={9} now={() => NOW} {...s} />);
    await findByTestId('trip-offline-queue');
    expect(getByText('3 change(s) queued for reconnect')).toBeTruthy();
    expect(getByText('CANCEL_PLAN · revalidate — confirm against version 9')).toBeTruthy();
    fireEvent.press(await findByTestId('trip-offline-replay'));
    await findByTestId('trip-offline-replay-result');
    expect(getByText('Replayed 1, already applied 0, conflicts 1, rejected 0, to confirm 1.')).toBeTruthy();
    expect(getByText('JOIN_PLAN: conflict — the trip moved on')).toBeTruthy();
    expect(getByText('1 change(s) queued for reconnect')).toBeTruthy();
    fireEvent.press(await findByTestId('trip-offline-confirm-b'));
    await waitFor(() => expect(s.revalidate).toHaveBeenCalledWith(TRIP_ID, 'b', 9));
    expect(queryByTestId('trip-offline-loading')).toBeNull();
  });
  it('a failed replay says nothing was dropped', async () => {
    const s = seams({ queue: [entry('a', 'JOIN_PLAN')], replay: { state: 'unavailable', detail: 'offline' } });
    const { findByTestId, getByText } = await render(<TripOfflineCard tripId={TRIP_ID} now={() => NOW} {...s} />);
    fireEvent.press(await findByTestId('trip-offline-replay'));
    await findByTestId('trip-offline-note');
    expect(getByText('Could not replay: offline. Nothing was dropped.')).toBeTruthy();
    expect(getByText('1 change(s) queued for reconnect')).toBeTruthy();
  });
});
