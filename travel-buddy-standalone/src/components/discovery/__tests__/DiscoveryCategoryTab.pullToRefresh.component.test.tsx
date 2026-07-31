/**
 * DiscoveryCategoryTab — pull-to-refresh re-fetches data
 *
 * Confirms that triggering the FlatList's RefreshControl.onRefresh:
 *   1. calls getDiscoveryPlaces again (page-1 re-fetch)
 *   2. invokes the onRefresh prop passed by the parent discovery screen
 *   3. clears the refreshing spinner once the re-fetch resolves
 *
 * testID "main-scroll" on the FlatList lets us reach refreshControl via
 * scroll.props.refreshControl.props.onRefresh / .refreshing.
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

// ── Services ──────────────────────────────────────────────────────────────────

const mockGetDiscoveryPlaces       = jest.fn();
const mockGetCachedDiscoveryPlaces = jest.fn();

// NOTE: intentionally exhaustive — the real module imports Supabase; spreading
// requireActual would load the client and OOM the Jest runner.
jest.mock('../../../services/discovery', () => ({
  getDiscoveryPlaces:       (...args: unknown[]) => mockGetDiscoveryPlaces(...args),
  getCachedDiscoveryPlaces: (...args: unknown[]) => mockGetCachedDiscoveryPlaces(...args),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — the real hook fetches from a remote API.
jest.mock('../../../hooks/usePopularCities', () => ({
  usePopularCities: () => ({ places: [], loading: false }),
}));

// ── Component stubs ───────────────────────────────────────────────────────────

const Null = () => null;

// NOTE: intentional stub — not under test; real PlaceCard pulls react-native-maps.
jest.mock('../PlaceCard', () => ({ __esModule: true, default: Null }));
// NOTE: intentional stub — not under test; pulls reanimated animations.
jest.mock('../PlaceSkeleton', () => ({ PlaceSkeletonList: Null }));
// NOTE: intentional stub — not under test; pulls native modules + navigation.
jest.mock('../../selectors/GlobalPlacePicker', () => ({
  POPULAR: [],
  GlobalPlacePicker: Null,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { DiscoveryCategoryTab } from '../DiscoveryCategoryTab.tsx';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryCategoryTab — pull-to-refresh', () => {
  const onRefreshSpy = jest.fn();

  const MOCK_PLACE = {
    id: 'p1', name: 'Sushi Bar', category: 'food', type: null, description: null,
    distanceKm: null, lat: null, lng: null, address: null, openingHours: null,
    rating: null, photoUrl: null, visitCount: null, savedCount: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedDiscoveryPlaces.mockReturnValue(null);
    // non-empty so the FlatList branch (not empty-state) is rendered
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true, data: { places: [MOCK_PLACE], total: 1 },
    });
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it('calls getDiscoveryPlaces again and invokes onRefresh prop when RefreshControl fires', async () => {
    await render(
      <DiscoveryCategoryTab
        category="places"
        destination="Lisbon"
        filters={{ radiusKm: 10, openNow: false, minRating: null }}
        onSelectPlace={jest.fn()}
        onAddToPlan={jest.fn()}
        onFiltersChange={jest.fn()}
        onRefresh={onRefreshSpy}
      />,
    );

    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(1));

    const scroll = await screen.findByTestId('main-scroll');
    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });

    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2));
    expect(onRefreshSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the list visible while refreshing and clears the spinner once the re-fetch resolves', async () => {
    // handleRefresh no longer calls setPlaces([]), so the FlatList stays mounted
    // throughout the refresh cycle. We can therefore check refreshing===true
    // in-flight and refreshing===false after resolution — all on the same node.
    await render(
      <DiscoveryCategoryTab
        category="places"
        destination="Lisbon"
        filters={{ radiusKm: 10, openNow: false, minRating: null }}
        onSelectPlace={jest.fn()}
        onAddToPlan={jest.fn()}
        onFiltersChange={jest.fn()}
        onRefresh={onRefreshSpy}
      />,
    );

    // Wait for the initial load so the FlatList is stable and visible.
    const scroll = await screen.findByTestId('main-scroll');
    expect(scroll.props.refreshControl.props.refreshing).toBe(false);

    // Intercept the refresh re-fetch with a pending Promise.
    let resolveFetch!: () => void;
    mockGetDiscoveryPlaces.mockReturnValueOnce(
      new Promise<{ ok: boolean; data: { places: typeof MOCK_PLACE[]; total: number } }>((res) => {
        resolveFetch = () => res({ ok: true, data: { places: [MOCK_PLACE], total: 1 } });
      }),
    );

    // Trigger refresh — FlatList stays mounted because setPlaces([]) is NOT called.
    // Flush one microtask so the synchronous setRefreshing(true) commits before
    // we assert, without letting the pending fetch Promise itself resolve.
    await act(async () => {
      scroll.props.refreshControl.props.onRefresh();
      await Promise.resolve();
    });

    // Spinner is active while the fetch is in-flight.
    await waitFor(() =>
      expect(screen.getByTestId('main-scroll').props.refreshControl.props.refreshing).toBe(true),
    );

    // Resolve the refresh fetch — setPlaces(filtered) + setRefreshing(false) fire.
    await act(async () => { resolveFetch(); });

    // Spinner is cleared and the FlatList is still visible.
    await waitFor(() =>
      expect(screen.getByTestId('main-scroll').props.refreshControl.props.refreshing).toBe(false),
    );
  });
});
