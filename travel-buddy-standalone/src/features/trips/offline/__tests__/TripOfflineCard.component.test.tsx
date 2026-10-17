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
      contents: {
        nextCommitments: [], activePlan: null,
        plans: [{ id: 'p1', title: 'Louvre', status: 'confirmed', dayDate: '2026-09-13', startsAt: null, endsAt: null, locationName: null }],
        meetingPoints: [], criticalAddresses: [{ kind: 'reservation', id: 'r1', title: 'Hotel', address: '1 rue X', at: null }],
        selectedRoute: null,
        certifiedContext: { sourceTripVersion: 7, certifiedAt: '2026-09-13T10:00:00.000Z', reading: 'x', freeWindows: null, windowsDecisionId: null, windowsReading: 'trip_operational_projections_enabled is off: not read for this bundle' },
      },
      notCarried: { selectedRoute: 'trip_operational_projections_enabled is off: not read for this bundle' }, ...over,
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
  it('says what the offline copy carries of the route and the free windows, and says plainly when it carries neither', async () => {
    const bare = await render(<TripOfflineCard tripId={TRIP_ID} now={() => NOW} {...seams({ stored: stored() })} />);
    await bare.findByTestId('trip-offline-card');
    expect(bare.getByTestId('trip-offline-route').props.children).toMatch(/No route offline/);
    expect(bare.getByTestId('trip-offline-route').props.children).toMatch(/is off/);
    expect(bare.getByTestId('trip-offline-windows').props.children).toMatch(/No free windows offline/);
    expect(bare.getByTestId('trip-offline-windows').props.children).toMatch(/is off/);

    const carried = stored({
      contents: {
        ...signed().bundle.contents,
        selectedRoute: {
          decisionId: 'd1', partySize: 2, disclosure: 'straight-line bound',
          stops: [
            { planItemId: 'p1', title: 'Louvre', startsAt: null, endsAt: null, locationName: null },
            { planItemId: 'p2', title: 'Seine', startsAt: null, endsAt: null, locationName: null },
          ],
          hops: [{ from: 'p1', to: 'p2', departAt: '2026-09-13T11:00:00.000Z', boundMinutes: 18, expectedMinutes: 24, unknownReason: null, arrivalAtBound: null, expectedArrivalAt: null, band: 'SHOULDER' }],
          unplaced: [{ planItemId: 'p3', reason: 'NO_TIME' }],
        },
        certifiedContext: {
          sourceTripVersion: 7, certifiedAt: '2026-09-13T10:00:00.000Z', reading: 'x',
          freeWindows: [{ id: 'w1', beginsAt: 'a', endsAt: 'b', durationMinutes: 90, certified: false, confidence: 'MEDIUM', participants: [], afterCommitmentId: null, beforeCommitmentId: null, reservedMinutes: null }],
          windowsDecisionId: 'd2', windowsReading: 'not routed',
        },
      },
    });
    const full = await render(<TripOfflineCard tripId={TRIP_ID} now={() => NOW} {...seams({ stored: carried })} />);
    await full.findByTestId('trip-offline-card');
    expect(full.getByTestId('trip-offline-route').props.children).toMatch(/2 stop\(s\)/);
    expect(full.getByTestId('trip-offline-route').props.children).toMatch(/1 hop\(s\)/);
    expect(full.getByTestId('trip-offline-route').props.children).toMatch(/1 item\(s\) without a time or a place/);
    expect(full.getByTestId('trip-offline-windows').props.children).toMatch(/1 read at version 7/);
    expect(full.getByTestId('trip-offline-windows').props.children).toMatch(/0 certified/);
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

// ── census-trips TR340: §18.1 "cached map tiles where permitted" ─────────────
describe('TripOfflineCard — the offline map of the trip area (TR340)', () => {
  const PARIS = { lat: 48.8566, lng: 2.3522 };
  const withPoints = (): SignedBundle => signed({ sourceTripVersion: 8, contents: { ...signed().bundle.contents, meetingPoints: [{ id: 'm1', label: 'Fountain', lat: 48.86, lng: 2.33, meetAt: null, purpose: 'regroup', myArrivalState: null }] } });
  function tileSeams(o: { allowed?: boolean; outcome?: any; status?: any } = {}) {
    return {
      cacheTiles: jest.fn(async () => o.outcome ?? ({ state: 'cached' as const, scope: `trip:${TRIP_ID}` })),
      tileStatus: jest.fn(async () => o.status ?? ({ state: 'none' as const })),
      mediaAllowed: jest.fn(async () => o.allowed ?? true),
    };
  }

  it('does NOT download on mount; it reads how far the trip\'s pack has got', async () => {
    const t = tileSeams({ status: { state: 'complete' } });
    const r = await render(<TripOfflineCard tripId={TRIP_ID} now={() => NOW} destination={PARIS} tiles={t} {...seams({ stored: stored() })} />);
    expect((await r.findByTestId('trip-offline-tiles')).props.children).toMatch(/saved for offline use/);
    expect(t.cacheTiles).not.toHaveBeenCalled();
    expect(t.tileStatus).toHaveBeenCalledWith(TRIP_ID);
  });

  it('a refresh packs the trip area: the destination and the NEW copy\'s meeting points, with the device\'s data-saver answer', async () => {
    const t = tileSeams({ status: { state: 'none' } });
    const s = { ...seams({ stored: stored() }), fetchBundle: jest.fn(async () => ({ state: 'ok' as const, signed: withPoints() })) };
    const r = await render(<TripOfflineCard tripId={TRIP_ID} now={() => NOW} destination={PARIS} tiles={t} {...s} />);
    await r.findByTestId('trip-offline-card');
    t.tileStatus.mockResolvedValue({ state: 'downloading', percentage: 37 } as any);
    await fireEvent.press(await r.findByTestId('trip-offline-refresh'));
    await waitFor(() => expect(t.cacheTiles).toHaveBeenCalledTimes(1));
    expect(t.cacheTiles).toHaveBeenCalledWith(TRIP_ID, { destination: PARIS, meetingPoints: withPoints().bundle.contents.meetingPoints }, { mediaAllowed: true });
    await waitFor(() => expect(r.getByTestId('trip-offline-tiles').props.children).toMatch(/37%/));
  });

  it('where NOT permitted, the card says why — and the offline copy itself is unaffected', async () => {
    const t = tileSeams({ allowed: false, outcome: { state: 'not_permitted', reason: 'data_saver' } });
    const s = seams({ stored: stored() });
    const r = await render(<TripOfflineCard tripId={TRIP_ID} now={() => NOW} destination={PARIS} tiles={t} {...s} />);
    await r.findByTestId('trip-offline-card');
    await fireEvent.press(await r.findByTestId('trip-offline-refresh'));
    await waitFor(() => expect(r.getByTestId('trip-offline-tiles').props.children).toMatch(/data saver is on/));
    expect(t.cacheTiles).toHaveBeenCalledWith(TRIP_ID, expect.anything(), { mediaAllowed: false });
    expect(r.getByText('Offline copy ready')).toBeTruthy();
  });

  it('a trip with no destination coordinates passes none (the pack is refused as having no area, not centred on null island)', async () => {
    const t = tileSeams();
    const s = seams({ stored: stored() });
    const r = await render(<TripOfflineCard tripId={TRIP_ID} now={() => NOW} destination={{ lat: null, lng: null }} tiles={t} {...s} />);
    await r.findByTestId('trip-offline-card');
    await fireEvent.press(await r.findByTestId('trip-offline-refresh'));
    await waitFor(() => expect(t.cacheTiles).toHaveBeenCalled());
    expect((t.cacheTiles.mock.calls[0] as any[])[1].destination).toBeNull();
  });
});

describe('TR340 — the device data-saver setting decides, with no seam', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const asyncStorageModule = require('@react-native-async-storage/async-storage');
  const AsyncStorage = asyncStorageModule.default ?? asyncStorageModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readDataSaverSetting } = require('../../../telegraph/hooks/useDataSaver.ts');
  beforeEach(async () => { await AsyncStorage.clear(); });

  it('reads the same device setting the Telegraph data-saver writes; unreadable or absent is off', async () => {
    expect(await readDataSaverSetting()).toBe('off');
    await AsyncStorage.setItem('telegraph:dataSaver:v1', 'on');
    expect(await readDataSaverSetting()).toBe('on');
    // Once, and not restored: the storage mock's getItem is itself a jest.fn, and mockRestore() would strip it.
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage gone'));
    expect(await readDataSaverSetting()).toBe('off');
    expect(await readDataSaverSetting()).toBe('on');
  });

  it('with data saver ON and no mediaAllowed seam, the refresh asks for NO tiles', async () => {
    await AsyncStorage.setItem('telegraph:dataSaver:v1', 'on');
    const cacheTiles = jest.fn(async () => ({ state: 'not_permitted' as const, reason: 'data_saver' as const }));
    const tileStatus = jest.fn(async () => ({ state: 'none' as const }));
    const r = await render(<TripOfflineCard tripId={TRIP_ID} now={() => NOW} destination={{ lat: 48.85, lng: 2.35 }} tiles={{ cacheTiles, tileStatus }} {...seams({ stored: stored() })} />);
    await r.findByTestId('trip-offline-card');
    await fireEvent.press(await r.findByTestId('trip-offline-refresh'));
    await waitFor(() => expect(cacheTiles).toHaveBeenCalled());
    expect((cacheTiles.mock.calls[0] as any[])[2]).toEqual({ mediaAllowed: false });
  });
});
