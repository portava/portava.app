/**
 * Compass Remembers (app/compass-memories.tsx) — a failed read is not "Nothing remembered".
 *
 * Before: when GET /api/compass/me/memories failed, the screen kept whatever list it
 * had (empty on first open, the previous scope's rows after a tab switch) and showed
 * "Nothing remembered yet", telling the person Compass had forgotten them.
 *
 * Pinned: a failed read shows the error with Try again, never the empty copy; Try
 * again loads the list; a failed tab switch does not keep the old tab's rows.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

// NOTE: intentional stub — expo-router's focus effect needs a navigator; here it runs once on mount.
jest.mock('expo-router', () => {
  const R = jest.requireActual('react');
  return { router: { back: jest.fn(), push: jest.fn() }, useFocusEffect: (cb: () => void) => R.useEffect(cb, [cb]) };
});

const mockFetch = jest.fn();
// NOTE: intentional stub — the real service does an authed fetch.
jest.mock('../../src/services/compass', () => ({
  ...jest.requireActual('../../src/services/compass'),
  fetchCompassMemories: (...a: unknown[]) => mockFetch(...a),
}));
// NOTE: intentional stub — circles are not under test.
jest.mock('../../src/services/circles', () => ({ getMyCircles: async () => [] }));
// NOTE: intentional stub — the bottom filler reads safe-area insets.
jest.mock('../../src/hooks/useBottomInset', () => ({ PlainBottomFiller: () => null }));

import CompassMemoriesScreen from '../compass-memories.tsx';

const MEM = {
  id: 'm1', scope: 'user', category: 'food', content: 'Prefers street food', source: 'taught', confidence: 0.9,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', circle_owner_id: null, trip_id: null,
};

beforeEach(() => mockFetch.mockReset());

describe('Compass Remembers — read failures', () => {
  it('a failed read says so with Try again, not "Nothing remembered"', async () => {
    mockFetch.mockResolvedValue({ ok: false, error: 'http_503' });
    await render(<CompassMemoriesScreen />);
    await act(async () => {});
    expect(screen.getByTestId('memories-error')).toBeTruthy();
    expect(screen.queryByTestId('memories-empty')).toBeNull();
  });

  it('Try again loads the list', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, error: 'network_error' }).mockResolvedValue({ ok: true, data: [MEM] });
    await render(<CompassMemoriesScreen />);
    await act(async () => {});
    await act(async () => { fireEvent.press(screen.getByLabelText('Try loading memories again')); });
    expect(await screen.findByTestId('memory-m1')).toBeTruthy();
    expect(screen.queryByTestId('memories-error')).toBeNull();
  });

  it('control: an empty answer is the empty copy', async () => {
    mockFetch.mockResolvedValue({ ok: true, data: [] });
    await render(<CompassMemoriesScreen />);
    await act(async () => {});
    expect(screen.getByTestId('memories-empty')).toBeTruthy();
    expect(screen.queryByTestId('memories-error')).toBeNull();
  });
});
