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

  it('clears the refreshing indicator once the re-fetch resolves', async () => {
    // Note: DiscoveryCategoryTab's handleRefresh calls setPlaces([]) which unmounts
    // the FlatList while the re-fetch is in-flight (places.length===0 → empty branch).
    // We therefore cannot check refreshing===true through the FlatList; instead we
    // confirm the indicator resolves by: (a) verifying the FlatList starts with
    // refreshing=false, (b) holding the re-fetch open with a pending Promise,
    // (c) resolving it, and (d) waiting for the FlatList to reappear — that
    // reappearance only happens after setPlaces(newData) + setRefreshing(false) fire.
    await render(
      <DiscoveryCategoryTab
        category="places"
        destination="Lisbon"
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

    // Trigger refresh — FlatList unmounts because setPlaces([]) is called.
    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });

    // Resolve the refresh fetch — setPlaces(filtered) + setRefreshing(false) fire.
    await act(async () => { resolveFetch(); });

    // FlatList reappears only after places are loaded and refreshing is cleared.
    const reloaded = await screen.findByTestId('main-scroll');
    expect(reloaded.props.refreshControl.props.refreshing).toBe(false);
  });
});
