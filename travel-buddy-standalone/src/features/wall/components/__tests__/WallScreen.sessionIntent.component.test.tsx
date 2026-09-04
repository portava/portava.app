/**
 * Component test: the temporary session-intent steer, set then clear
 * (Wall spec §17).
 *
 * Typing an intent steers For You (the feed refetches with the session_intent
 * param and the intent chip appears); clearing it restores the prior state (the
 * steer input returns and the feed refetches without the param).
 */

import React from 'react';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — the real wallApi loads the supabase /
// apiToken chain at import, which would crash the jest suite.
jest.mock('../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  fetchQuickMedia: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
}));

import * as wallApi from '../../services/wallApi.ts';
import { WallScreen } from '../WallScreen.tsx';

const mockFetchWall = wallApi.fetchWall as unknown as jest.Mock;
const mockFetchLive = wallApi.fetchLiveForYou as unknown as jest.Mock;
const mockSetIntent = wallApi.setSessionIntent as unknown as jest.Mock;
const mockClearIntent = wallApi.clearSessionIntent as unknown as jest.Mock;

const NOW = new Date().toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchLive.mockResolvedValue({ ok: true, liveForYou: [], degraded: false });
  mockFetchWall.mockResolvedValue({
    ok: true,
    degraded: false,
    data: { mode: 'for_you', liveForYou: [], items: [], generatedAt: NOW },
  });
  mockSetIntent.mockResolvedValue({
    ok: true,
    sessionIntent: {
      filters: [{ kind: 'category', label: 'Bangkok nightlife' }],
      keywords: [],
      sessionScoped: true,
      createdAt: NOW,
    },
  });
  mockClearIntent.mockResolvedValue({ ok: true });
});

describe('WallScreen session intent', () => {
  it('sets an intent, then clears it back to the prior state', async () => {
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-intent-input')).toBeTruthy());

    // ── Set ──
    // Two separate act steps: the changeText re-render must commit (so the
    // input's onSubmitEditing closes over the new draft) BEFORE we submit.
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('wall-intent-input'), 'bangkok nightlife');
    });
    await act(async () => {
      fireEvent(screen.getByTestId('wall-intent-input'), 'submitEditing');
    });

    await waitFor(() => expect(screen.getByTestId('wall-intent-chip')).toBeTruthy());
    expect(mockSetIntent).toHaveBeenCalledWith('bangkok nightlife');
    // The feed re-fetched with the temporary steer param (spec §17).
    expect(mockFetchWall).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIntent: 'bangkok nightlife' }),
    );

    // ── Clear restores prior state ──
    await act(async () => {
      fireEvent.press(screen.getByTestId('wall-intent-clear'));
    });

    await waitFor(() => expect(screen.getByTestId('wall-intent-input')).toBeTruthy());
    expect(screen.queryByTestId('wall-intent-chip')).toBeNull();
    expect(mockClearIntent).toHaveBeenCalled();
    // The feed re-fetched WITHOUT a steer — prior (unsteered) state restored.
    expect(mockFetchWall).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIntent: null }),
    );
  });
});
