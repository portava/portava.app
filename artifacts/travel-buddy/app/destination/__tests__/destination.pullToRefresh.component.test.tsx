/**
 * Destination page — pull-to-refresh re-fetches all three data sections
 *
 * Confirms that triggering the ScrollView's RefreshControl.onRefresh:
 *   1. calls listGems() again
 *   2. calls listEvents() again
 *   3. calls getPulseData() again
 *   4. clears the refreshing spinner once all three fetches resolve
 *
 * testID "main-scroll" on the ScrollView in destination/[slug].tsx lets us
 * reach refreshControl via scroll.props.refreshControl.props.onRefresh / .refreshing.
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router:               { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ slug: 'lisbon' })),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockListGems   = jest.fn();
const mockListEvents = jest.fn();
const mockGetPulse   = jest.fn();

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/hiddenGems', () => ({
  listGems: (...args: unknown[]) => mockListGems(...args),
}));

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/events', () => ({
  listEvents: (...args: unknown[]) => mockListEvents(...args),
}));

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/pulse', () => ({
  getPulseData: (...args: unknown[]) => mockGetPulse(...args),
}));

jest.mock('../../../src/services/compass', () => ({
  ...jest.requireActual('../../../src/services/compass'),
  fetchCityConfidence: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test; pulls FSQ network service.
jest.mock('../../../src/components/trip/TripFsqPlacesSection', () => ({
  TripFsqPlacesSection: () => null,
}));

import Destination from '../[slug].tsx';

describe('Destination page — pull-to-refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListGems.mockResolvedValue([]);
    mockListEvents.mockResolvedValue({ ok: true, data: { events: [] } });
    mockGetPulse.mockResolvedValue({ ok: true, data: { posts: [] } });
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it('re-fetches gems, events and pulse posts when RefreshControl fires', async () => {
    await render(<Destination />);

    await waitFor(() => {
      expect(mockListGems).toHaveBeenCalledTimes(1);
      expect(mockListEvents).toHaveBeenCalledTimes(1);
      expect(mockGetPulse).toHaveBeenCalledTimes(1);
    });

    const scroll = await screen.findByTestId('main-scroll');
    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });

    await waitFor(() => {
      expect(mockListGems).toHaveBeenCalledTimes(2);
      expect(mockListEvents).toHaveBeenCalledTimes(2);
      expect(mockGetPulse).toHaveBeenCalledTimes(2);
    });
  });

  it('clears the refreshing indicator once all fetches resolve', async () => {
    await render(<Destination />);
    await waitFor(() => expect(mockListGems).toHaveBeenCalledTimes(1));

    const scroll = await screen.findByTestId('main-scroll');
    expect(scroll.props.refreshControl.props.refreshing).toBe(false);

    let resolveGems!:   () => void;
    let resolveEvents!: () => void;
    let resolvePulse!:  () => void;
    mockListGems.mockReturnValueOnce(
      new Promise<never[]>((res) => { resolveGems = () => res([]); }),
    );
    mockListEvents.mockReturnValueOnce(
      new Promise<{ ok: boolean; data: { events: never[] } }>((res) => {
        resolveEvents = () => res({ ok: true, data: { events: [] } });
      }),
    );
    mockGetPulse.mockReturnValueOnce(
      new Promise<{ ok: boolean; data: { posts: never[] } }>((res) => {
        resolvePulse = () => res({ ok: true, data: { posts: [] } });
      }),
    );

    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });
    expect(screen.getByTestId('main-scroll').props.refreshControl.props.refreshing).toBe(true);

    await act(async () => { resolveGems(); resolveEvents(); resolvePulse(); });
    await waitFor(() => {
      expect(screen.getByTestId('main-scroll').props.refreshControl.props.refreshing).toBe(false);
    });
  });
});
