/**
 * DiscoveryCategoryTab — map mode states a refused, partial or failed read, and
 * a failed REFRESH over a page on screen says so (census-discovery §100, lane
 * W11-X2 round 4; DV-83, §99.8 finding 3 and the round's adversarial sweep).
 *
 * §99.8 finding 3: the render chain tested `viewMode === 'map'` BEFORE its
 * error, partial-empty and partial branches, so in map mode a refused page, a
 * transport failure and a partial page all drew a plain map. Register
 * D-W11X2-24: the same states, with the list's testIDs, sit in a banner over the
 * map, with a "Try again".
 *
 * The sweep: a page-1 transport failure over places already on screen (the SWR
 * cache, or the last good answer) set `error` and rendered nothing — the error
 * state requires `places.length === 0` — so a refresh that never happened was
 * shown as a fresh, complete answer. Register D-W11X2-22 (ForYouTab's rule, the
 * same here): the places stay, under a "couldn't refresh" line.
 *
 *   D1  map, refused (`nothing`) page 1: `discovery-category-error` over the map
 *   D2  map, transport failure: `discovery-category-error` over the map
 *   D3  map, partial with places: `discovery-category-partial` over the map
 *   D4  map, partial with no places: `discovery-category-partial-empty` over the map
 *   D5  list, cached page, failed refetch: places kept, `discovery-category-stale`
 *   D6  map, cached page, failed refetch: `discovery-category-stale` over the map
 *   D7  map, the banner's "Try again" asks again
 *   D8  list, the no-places error state carries its testID
 *   D9  list, a failed refetch and then a good pull-to-refresh: the stale line clears
 *   C1  CONTROL: map, a complete page draws no banner
 *   C2  CONTROL: list, a good refetch over a cached page draws no stale line
 *   C3  CONTROL: list, a failed LOAD-MORE is not a failed refresh (no stale line)
 *
 * Run with: npx jest src/components/discovery/__tests__/DiscoveryCategoryTab.failedRead.component.test.tsx
 */

import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react-native';

const mockGetDiscoveryPlaces       = jest.fn();
const mockGetCachedDiscoveryPlaces = jest.fn();

// NOTE: intentionally exhaustive — the real module imports Supabase; spreading
// requireActual would load the client and OOM the Jest runner.
jest.mock('../../../services/discovery', () => ({
  getDiscoveryPlaces:       (...args: unknown[]) => mockGetDiscoveryPlaces(...args),
  getCachedDiscoveryPlaces: (...args: unknown[]) => mockGetCachedDiscoveryPlaces(...args),
}));

// NOTE: intentionally exhaustive — the real hook fetches from a remote API.
jest.mock('../../../hooks/usePopularCities', () => ({
  usePopularCities: () => ({ places: [], loading: false }),
}));

const Null = () => null;
// NOTE: intentional stub — the real card pulls react-native-maps. It renders a
// marker per place so a test can see which cards are on screen.
jest.mock('../PlaceCard', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: ({ place }: { place: { id: string } }) => React.createElement(View, { testID: `card-${place.id}` }) };
});
// NOTE: intentional stub — the real map pulls MapLibre native modules.
jest.mock('../DiscoveryMapView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { DiscoveryMapView: () => React.createElement(View, { testID: 'discovery-map' }) };
});
// NOTE: intentional stub — not under test; pulls reanimated animations.
jest.mock('../PlaceSkeleton', () => ({ PlaceSkeletonList: Null }));
// NOTE: intentional stub — not under test; pulls native modules + navigation.
jest.mock('../../selectors/GlobalPlacePicker', () => ({
  POPULAR: [],
  GlobalPlacePicker: Null,
}));

import { DiscoveryCategoryTab } from '../DiscoveryCategoryTab.tsx';

const PLACE = {
  id: 'p1', name: 'Eiffel Tower', category: 'places', type: null, description: null,
  distanceKm: null, lat: null, lng: null, tags: [], address: null, website: null,
  phone: null, openingHours: null, rating: null, isOpenNow: null,
};
const PARTIAL_REFUSAL = {
  class: 'upstream_unavailable', code: 'overpass_unavailable', route: 'GET /discovery',
  coverage: 'partial' as const, failedSources: ['overpass'],
};
const REFUSED = { ...PARTIAL_REFUSAL, coverage: 'nothing' as const };
const COMPLETE_PAGE = { places: [PLACE], total: 1, destination: 'Paris', cached: false };
const PARTIAL_PAGE = { ...COMPLETE_PAGE, refusal: PARTIAL_REFUSAL };
const PARTIAL_EMPTY_PAGE = { places: [], total: 0, destination: 'Paris', cached: false, refusal: PARTIAL_REFUSAL };
const REFUSED_PAGE = { places: [], total: 0, destination: 'Paris', cached: false, refusal: REFUSED };
const NET_FAIL = { ok: false, error: 'Network error — check your connection' };

async function renderTab(viewMode: 'list' | 'map' = 'list') {
  await render(
    <DiscoveryCategoryTab category="places" destination="Paris" onSelectPlace={jest.fn()} onAddToPlan={jest.fn()} viewMode={viewMode} />,
  );
  await act(async () => {});
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCachedDiscoveryPlaces.mockReturnValue(null);
});

afterEach(async () => { await act(async () => {}); });

describe('DiscoveryCategoryTab map mode states a refused, partial or failed read (§100, D-W11X2-24)', () => {
  it('D1 map, refused (`nothing`) page 1: the error state is over the map', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: REFUSED_PAGE });
    await renderTab('map');
    expect(screen.getByTestId('discovery-map')).toBeTruthy();
    expect(screen.getByTestId('discovery-category-error')).toBeTruthy();
    expect(screen.getByText(/this is on our side, not your filters/)).toBeTruthy();
  });

  it('D2 map, transport failure: the error state is over the map', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue(NET_FAIL);
    await renderTab('map');
    expect(screen.getByTestId('discovery-map')).toBeTruthy();
    expect(screen.getByTestId('discovery-category-error')).toBeTruthy();
    expect(screen.getByText('Network error — check your connection')).toBeTruthy();
  });

  it('D3 map, partial with places: the partial notice is over the map', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: PARTIAL_PAGE });
    await renderTab('map');
    expect(screen.getByTestId('discovery-map')).toBeTruthy();
    expect(screen.getByTestId('discovery-category-partial')).toBeTruthy();
    expect(screen.queryByTestId('discovery-category-error')).toBeNull();
  });

  it('D4 map, partial with no places: the partial-empty notice is over the map', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: PARTIAL_EMPTY_PAGE });
    await renderTab('map');
    expect(screen.getByTestId('discovery-map')).toBeTruthy();
    expect(screen.getByTestId('discovery-category-partial-empty')).toBeTruthy();
  });

  it('D6 map, cached page and a failed refetch: the stale line is over the map', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(COMPLETE_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue(NET_FAIL);
    await renderTab('map');
    expect(screen.getByTestId('discovery-category-stale')).toBeTruthy();
    expect(screen.queryByTestId('discovery-category-error')).toBeNull();
  });

  it('D7 map, the banner\'s "Try again" asks again', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await renderTab('map');
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: COMPLETE_PAGE });
    await act(async () => { fireEvent.press(screen.getByText('Try again')); });
    await act(async () => {});
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('discovery-category-error')).toBeNull();
  });

  it('C1 CONTROL: map, a complete page draws no banner', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: COMPLETE_PAGE });
    await renderTab('map');
    expect(screen.getByTestId('discovery-map')).toBeTruthy();
    for (const id of ['discovery-category-error', 'discovery-category-partial', 'discovery-category-partial-empty', 'discovery-category-stale']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });
});

describe('DiscoveryCategoryTab — a failed refresh over a page on screen says so (§100, D-W11X2-22)', () => {
  it('D5 list, cached page, failed refetch: the places stay, under the stale line', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(COMPLETE_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue(NET_FAIL);
    await renderTab();
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    expect(screen.getByTestId('discovery-category-stale')).toBeTruthy();
    expect(screen.queryByText('No places found')).toBeNull();
  });

  it('D8 list, a transport failure with no places is the error state, with its testID', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue(NET_FAIL);
    await renderTab();
    expect(screen.getByTestId('discovery-category-error')).toBeTruthy();
    expect(screen.getByText("Couldn't load places")).toBeTruthy();
  });

  it('D9 list, a failed refetch and then a good pull-to-refresh: the stale line clears', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(COMPLETE_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await renderTab();
    expect(screen.getByTestId('discovery-category-stale')).toBeTruthy();
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: COMPLETE_PAGE });
    const list = screen.getByTestId('main-scroll');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });
    await act(async () => {});
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('discovery-category-stale')).toBeNull();
  });

  it('C2 CONTROL: list, a good refetch over a cached page draws no stale line', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(COMPLETE_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: COMPLETE_PAGE });
    await renderTab();
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    expect(screen.queryByTestId('discovery-category-stale')).toBeNull();
  });

  it('C3 CONTROL: list, a failed LOAD-MORE is not a failed refresh — no stale line, the list is not called ended', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { ...COMPLETE_PAGE, total: 30 } });
    await renderTab();
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    const list = screen.getByTestId('main-scroll');
    await act(async () => { list.props.onEndReached?.(); });
    await act(async () => {});
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    expect(screen.queryByTestId('discovery-category-stale')).toBeNull();
    expect(screen.queryByText(/places found/)).toBeNull();
  });
});
