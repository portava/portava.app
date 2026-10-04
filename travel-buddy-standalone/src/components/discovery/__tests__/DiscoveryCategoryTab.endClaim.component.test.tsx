/**
 * DiscoveryCategoryTab — "N places found" is the list's claim that the set has
 * ended, and a failed or partial read never makes it; a failed load-more is
 * said (census-discovery §101, lane W11-X2 round 5; DV-83, §100.11 finding 2
 * and §100.10; register D-W11X2-29, D-W11X2-30).
 *
 * §100.11's verifier found the footer printed on two kinds of read:
 *   - after a failed refresh over a cached page — `total` stayed at its initial
 *     0 (hydration never set it), so the cached page was called the whole set,
 *     and every load-more was refused locally (`places.length >= total`);
 *   - beside a partial page, whenever `places.length >= total`.
 * And §100.10: a failed load-more (page ≥ 2) was silent.
 *
 *   Q1–Q9  the verifier's probes, copied in unchanged (Q1/Q9 pin the stale line
 *          over a cached PARTIAL page and hydration keeping the partial flag —
 *          the two mutations, D-M8 and D-M9, that survived the lane's own suites)
 *   E1  a failed refresh over a cached page (server total 50): load-more still asks page 2
 *   E2  a failed refresh over a cached page whose total equals its rows: no end claim
 *   E3  a page whose total is unknown (0 while rows are on screen): no end claim
 *   E4  a failed load-more: the "couldn't load more" line, with its retry; the tap asks page 2 again
 *   E5  a failed load-more: scrolling asks again, and a good page clears the line
 *   E6  a partial page 2 after a complete page 1, list ends: partial notice, no end claim
 *   E7  a failed load-more is not a failed refresh, and draws no stale line
 *   C1  CONTROL: a complete page 1 whose rows are the whole set: "1 places found"
 *   C2  CONTROL: complete page 1 and page 2 that end the set: "2 places found"
 *   C3  CONTROL: a complete cached page and a GOOD refetch that ends the set: "1 places found"
 *
 * Harness copied from the verifier's probe (itself from
 * DiscoveryCategoryTab.failedRead.component.test.tsx).
 *
 * Run with: npx jest src/components/discovery/__tests__/DiscoveryCategoryTab.endClaim.component.test.tsx
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
  mockGetDiscoveryPlaces.mockReset();  // a queued once-value must not leak into the next case
  mockGetCachedDiscoveryPlaces.mockReturnValue(null);
});

afterEach(async () => { await act(async () => {}); });

const BIG_CACHED = { places: [PLACE], total: 50, destination: 'Paris', cached: false };
const PLACE2 = { ...PLACE, id: 'p2' };
describe('DiscoveryCategoryTab — the end claim, and a failed load-more (DV-83, §101; Q1–Q9 are the §100.11 verifier probes)', () => {
  it('Q1 map, cached PARTIAL page, failed refetch: partial + stale over the map', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(PARTIAL_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue(NET_FAIL);
    await renderTab('map');
    expect(screen.getByTestId('discovery-category-partial')).toBeTruthy();
    expect(screen.getByTestId('discovery-category-stale')).toBeTruthy();
  });
  it('Q2 map, partial page from the network: partial over the map (no list-only notice)', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: { ...PARTIAL_PAGE, places: [PLACE, PLACE2], total: 2 } });
    await renderTab('map');
    expect(screen.getByTestId('discovery-map')).toBeTruthy();
    expect(screen.getByTestId('discovery-category-partial')).toBeTruthy();
  });
  it('Q3 map, cached PARTIAL-EMPTY page, failed refetch: partial-empty OR error over the map, never plain map', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(PARTIAL_EMPTY_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue(NET_FAIL);
    await renderTab('map');
    expect(screen.queryByTestId('discovery-category-error') ?? screen.queryByTestId('discovery-category-partial-empty')).toBeTruthy();
  });
  it('Q4 list, cached page (server total 50, 1 place) with a failed refetch: must not claim the list ended ("N places found")', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(BIG_CACHED);
    mockGetDiscoveryPlaces.mockResolvedValue(NET_FAIL);
    await renderTab('list');
    expect(screen.getByTestId('discovery-category-stale')).toBeTruthy();
    expect(screen.queryByText(/places found/)).toBeNull();
  });
  it('Q4c CONTROL list, cached page (total 50), GOOD refetch with total 50: no end claim', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(BIG_CACHED);
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: BIG_CACHED });
    await renderTab('list');
    expect(screen.queryByText(/places found/)).toBeNull();
  });
  it('Q5 list, page-2 transport failure: the failed load-more is said (not silent)', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE], total: 50, destination: 'Paris', cached: false } });
    await renderTab('list');
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    await act(async () => {});
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2);
    expect(mockGetDiscoveryPlaces.mock.calls[1][3]).toBe(2);
    expect(screen.queryByTestId('discovery-category-more-refused') ?? screen.queryByText(/couldn.t load/i)).toBeTruthy();
  });
  it('Q6 list, page-2 PARTIAL (page 1 complete): partial notice appears', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE], total: 50, destination: 'Paris', cached: false } });
    await renderTab('list');
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE2], total: 2, destination: 'Paris', cached: false, refusal: PARTIAL_REFUSAL } });
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    await act(async () => {});
    expect(screen.getByTestId('discovery-category-partial')).toBeTruthy();
  });
  it('Q7 list, page-2 PARTIAL whose total shrinks to what is on screen: must not print the end-of-list claim beside a partial', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE], total: 50, destination: 'Paris', cached: false } });
    await renderTab('list');
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE2], total: 2, destination: 'Paris', cached: false, refusal: PARTIAL_REFUSAL } });
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    await act(async () => {});
    expect(screen.queryByText(/places found/)).toBeNull();
  });
  it('Q8 list, page-1 PARTIAL complete-looking (places == total): must not print end-of-list claim', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: PARTIAL_PAGE });
    await renderTab('list');
    expect(screen.getByTestId('discovery-category-partial')).toBeTruthy();
    expect(screen.queryByText(/places found/)).toBeNull();
  });
  it('Q9 list, cached PARTIAL page, failed refetch: partial notice AND stale line', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(PARTIAL_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue(NET_FAIL);
    await renderTab('list');
    expect(screen.getByTestId('discovery-category-partial')).toBeTruthy();
    expect(screen.getByTestId('discovery-category-stale')).toBeTruthy();
  });

  it('E1 a failed refresh over a cached page (server total 50): load-more still asks page 2', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(BIG_CACHED);
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await renderTab('list');
    expect(screen.getByTestId('discovery-category-stale')).toBeTruthy();
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE2], total: 50, destination: 'Paris', cached: false } });
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    await act(async () => {});
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2);
    expect(mockGetDiscoveryPlaces.mock.calls[1][3]).toBe(2);
    expect(screen.getByTestId('card-p2')).toBeTruthy();
  });

  it('E2 a failed refresh over a cached page whose total equals its rows: no end claim', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(COMPLETE_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue(NET_FAIL);
    await renderTab('list');
    expect(screen.getByTestId('discovery-category-stale')).toBeTruthy();
    expect(screen.queryByText(/places found/)).toBeNull();
  });

  it('E3 a page whose total is unknown (0 while rows are on screen): no end claim', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue({ ...COMPLETE_PAGE, total: 0 });
    mockGetDiscoveryPlaces.mockReturnValue(new Promise(() => {}));
    await renderTab('list');
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    expect(screen.queryByText(/places found/)).toBeNull();
  });

  it('E4 a failed load-more: the "couldn’t load more" line, with its retry; the tap asks page 2 again', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE], total: 50, destination: 'Paris', cached: false } });
    await renderTab('list');
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    await act(async () => {});
    expect(screen.getByTestId('discovery-category-more-failed')).toBeTruthy();
    expect(screen.getByText('Couldn’t load more places just now.')).toBeTruthy();
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE2], total: 50, destination: 'Paris', cached: false } });
    await act(async () => { fireEvent.press(screen.getByText('Try again')); });
    await act(async () => {});
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(3);
    expect(mockGetDiscoveryPlaces.mock.calls[2][3]).toBe(2);
    expect(screen.getByTestId('card-p2')).toBeTruthy();
    expect(screen.queryByTestId('discovery-category-more-failed')).toBeNull();
  });

  it('E5 a failed load-more: scrolling asks again, and a good page clears the line', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE], total: 50, destination: 'Paris', cached: false } });
    await renderTab('list');
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    await act(async () => {});
    expect(screen.getByTestId('discovery-category-more-failed')).toBeTruthy();
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE2], total: 50, destination: 'Paris', cached: false } });
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    await act(async () => {});
    expect(mockGetDiscoveryPlaces.mock.calls[2][3]).toBe(2);
    expect(screen.queryByTestId('discovery-category-more-failed')).toBeNull();
  });

  it('E6 a partial page 2 after a complete page 1, list ends: partial notice, no end claim', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE], total: 2, destination: 'Paris', cached: false } });
    await renderTab('list');
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE2], total: 2, destination: 'Paris', cached: false, refusal: PARTIAL_REFUSAL } });
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    await act(async () => {});
    expect(screen.getByTestId('discovery-category-partial')).toBeTruthy();
    expect(screen.queryByText(/places found/)).toBeNull();
  });

  it('E7 a failed load-more is not a failed refresh, and draws no stale line', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE], total: 50, destination: 'Paris', cached: false } });
    await renderTab('list');
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    await act(async () => {});
    expect(screen.queryByTestId('discovery-category-stale')).toBeNull();
    expect(screen.queryByTestId('discovery-category-more-refused')).toBeNull();
  });

  it('C1 CONTROL a complete page 1 whose rows are the whole set: "1 places found"', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: COMPLETE_PAGE });
    await renderTab('list');
    expect(screen.getByText('1 places found')).toBeTruthy();
    expect(screen.queryByTestId('discovery-category-more-failed')).toBeNull();
  });

  it('C2 CONTROL complete page 1 and page 2 that end the set: "2 places found"', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE], total: 2, destination: 'Paris', cached: false } });
    await renderTab('list');
    expect(screen.queryByText(/places found/)).toBeNull();
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE2], total: 2, destination: 'Paris', cached: false } });
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    await act(async () => {});
    expect(screen.getByText('2 places found')).toBeTruthy();
  });

  it('C3 CONTROL a complete cached page and a GOOD refetch that ends the set: "1 places found"', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(COMPLETE_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: COMPLETE_PAGE });
    await renderTab('list');
    expect(screen.getByText('1 places found')).toBeTruthy();
  });
});
