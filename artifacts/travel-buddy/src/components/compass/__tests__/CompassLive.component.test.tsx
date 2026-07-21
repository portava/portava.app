/**
 * CompassLive component tests (Phase 12).
 *
 * Covers:
 *   - an already-active session resumes on mount: LIVE header, current/next
 *     stop from rolling context, and the prominent stop control render
 *   - inactive state renders the explicit "Go Live" start row; pressing it
 *     calls startCompassLive (explicit opt-in — nothing starts on its own)
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentionally minimal — CompassLive only uses useFocusEffect;
// requireActual('expo-router') drags in native navigation internals that
// crash under jest-expo. The mock runs the focus callback like an effect.
jest.mock('expo-router', () => {
  const ReactActual = require('react');
  return {
    useFocusEffect: (cb: () => void | (() => void)) => ReactActual.useEffect(cb, [cb]),
  };
});

const mockFetchSession = jest.fn();
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockCheck = jest.fn();
jest.mock('../../../services/compass.ts', () => ({
  ...jest.requireActual('../../../services/compass.ts'),
  fetchCompassLiveSession: (...a: unknown[]) => mockFetchSession(...a),
  startCompassLive: (...a: unknown[]) => mockStart(...a),
  stopCompassLive: (...a: unknown[]) => mockStop(...a),
  checkCompassLive: (...a: unknown[]) => mockCheck(...a),
}));

import { CompassLive } from '../CompassLive.tsx';

const ACTIVE_SESSION = {
  id: 'ls-1',
  status: 'active',
  context: {
    city: 'Cebu City',
    tripId: 'trip-1',
    currentStop: { id: 'item-a', title: 'Basilica visit', startsAt: null },
    nextItem: { id: 'item-b', title: 'Lechon lunch', startsAt: null },
    minutesToNext: 42,
    recentEvents: [],
    updatedAt: new Date().toISOString(),
  },
  checksRun: 2,
  nudgesDelivered: 1,
  startedAt: new Date().toISOString(),
};

afterEach(() => jest.clearAllMocks());

describe('CompassLive', () => {
  it('resumes an active session on mount with context and a stop control', async () => {
    mockFetchSession.mockResolvedValue({ ok: true, compassEnabled: true, active: true, session: ACTIVE_SESSION });
    mockCheck.mockResolvedValue({ ok: true, compassEnabled: true, active: true, session: ACTIVE_SESSION, delivered: [] });

    const view = await render(<CompassLive />);
    await waitFor(() => expect(view.getByTestId('live-active')).toBeTruthy());

    expect(view.getByText(/LIVE · CEBU CITY/)).toBeTruthy();
    expect(view.getByText(/Now: Basilica visit/)).toBeTruthy();
    expect(view.getByText(/Next: Lechon lunch/)).toBeTruthy();
    expect(view.getByText(/~42 min/)).toBeTruthy();
    expect(view.getByText('End live session')).toBeTruthy();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('renders the explicit Go Live row when inactive and starts only on press', async () => {
    mockFetchSession.mockResolvedValue({ ok: true, compassEnabled: true, active: false, session: null });
    mockStart.mockResolvedValue({ ok: true, compassEnabled: true, active: true, session: ACTIVE_SESSION });

    const view = await render(<CompassLive />);
    await waitFor(() => expect(view.getByTestId('live-start')).toBeTruthy());
    expect(view.getByText('Go Live with Compass')).toBeTruthy();
    expect(mockStart).not.toHaveBeenCalled();

    fireEvent.press(view.getByTestId('live-start'));
    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1));
  });
});
