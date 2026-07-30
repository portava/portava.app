/**
 * Stamps page — pull-to-refresh re-fetches stamps
 *
 * Confirms that triggering the ScrollView's RefreshControl.onRefresh:
 *   1. calls getMyPassportStamps() again
 *   2. clears the refreshing spinner once the re-fetch resolves
 *
 * testID "main-scroll" on the ScrollView in stamps.tsx lets us reach
 * refreshControl via scroll.props.refreshControl.props.onRefresh / .refreshing.
 * The ScrollView only mounts after the initial load completes; findByTestId
 * (async) waits for it to appear.
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';
import type { PassportStampNew } from '../../src/services/passportStamps.ts';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockGetMyPassportStamps = jest.fn();

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../src/services/passportStamps', () => ({
  getMyPassportStamps:   (...args: unknown[]) => mockGetMyPassportStamps(...args),
  updateStampVisibility: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: intentionally exhaustive — the real hook accesses native scroll state.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller:           () => null,
}));

// NOTE: intentionally exhaustive — the real AppHeader uses reanimated.
jest.mock('../../src/components/ui/AppHeader', () => ({
  AppHeader: () => null,
}));

// NOTE: intentionally exhaustive — the real PulseFilterRail uses reanimated.
jest.mock('../../src/components/PulseFilterRail', () => ({
  PulseFilterRail: ({ filters, onPress }: { filters: string[]; active: string[]; onPress: (f: string) => void }) => {
    const React = require('react');
    const { View, Text, Pressable } = require('react-native');
    return React.createElement(
      View, null,
      filters.map((f: string) =>
        React.createElement(Pressable, { key: f, onPress: () => onPress(f), testID: `filter-${f}` },
          React.createElement(Text, null, f),
        ),
      ),
    );
  },
}));

// NOTE: intentionally exhaustive — the real StampArtwork uses reanimated + SVG.
jest.mock('../../src/components/StampArtwork', () => ({
  StampArtwork: () => null,
}));

const MOCK_STAMPS: PassportStampNew[] = [
  {
    id: 's1', stampType: 'city', city: 'Paris', country: 'France',
    earnedAt: '2025-06-01T00:00:00Z', isRevoked: false, sourceType: 'trip',
    visibility: 'public', definition: null, titleOverride: null,
  } as PassportStampNew,
];

import StampsPage from '../stamps.tsx';

describe('Stamps page — pull-to-refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMyPassportStamps.mockResolvedValue({ ok: true, data: MOCK_STAMPS });
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it('calls getMyPassportStamps again when RefreshControl fires', async () => {
    await render(<StampsPage />);

    // findByTestId waits for the ScrollView to appear (only shown after load).
    const scroll = await screen.findByTestId('main-scroll');
    expect(mockGetMyPassportStamps).toHaveBeenCalledTimes(1);

    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });

    await waitFor(() => expect(mockGetMyPassportStamps).toHaveBeenCalledTimes(2));
  });

  it('clears the refreshing indicator once the re-fetch resolves', async () => {
    await render(<StampsPage />);

    const scroll = await screen.findByTestId('main-scroll');
    expect(scroll.props.refreshControl.props.refreshing).toBe(false);

    let resolveFetch!: () => void;
    mockGetMyPassportStamps.mockReturnValueOnce(
      new Promise<{ ok: boolean; data: PassportStampNew[] }>((res) => {
        resolveFetch = () => res({ ok: true, data: MOCK_STAMPS });
      }),
    );

    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });
    expect(screen.getByTestId('main-scroll').props.refreshControl.props.refreshing).toBe(true);

    await act(async () => { resolveFetch(); });
    await waitFor(() => {
      expect(screen.getByTestId('main-scroll').props.refreshControl.props.refreshing).toBe(false);
    });
  });
});
