/**
 * DiscoveryCategoryTab — only the LATEST request may write the screen, and a
 * list whose page 1 could not be refreshed never claims the set has ended
 * (census-discovery §102, lane W11-X2 round 6; DV-83; register D-W11X2-38,
 * D-W11X2-40).
 *
 * The verifier at 0db25c816 (V5-R3, V5-R4): `load()` had no latest-request
 * guard. Radius, the age filter and custom ages re-run `load(1)` WITHOUT a
 * remount (they are not in the tab's key), so an older answer that lands after
 * a newer one wrote the screen:
 *   - V5-R3: radius 25 refused → error; the superseded radius-10 answer lands →
 *     its rows shown, error cleared, no notice;
 *   - V5-R4: radius 25 fails in transport → error; the superseded answer lands →
 *     radius-10 rows under the failure.
 *
 *   R3  the verifier's V5-R3 probe: a superseded answer never overwrites a refused read
 *   R4  the verifier's V5-R4 probe: a superseded answer never overwrites a failed read
 *   R5  a superseded FAILURE never overwrites the newer good answer
 *   R6  a superseded load-more (page 2 of the old filters) never appends to the new list
 *   R8  a load-more during the page-1 refresh of the SAME query does not swallow that refresh's failure
 *   E8  a failed refresh over a cached page, then a good page 2 that reaches the
 *       total: no "N places found" beside the stale line (the §101.11 "possible")
 *   C1  CONTROL: a single good answer is shown, and its end claim made
 *   R7  the newer good answer after an older good one wins (the old one lands last)
 *
 * Harness copied from DiscoveryCategoryTab.endClaim.component.test.tsx.
 *
 * Run with: npx jest src/components/discovery/__tests__/DiscoveryCategoryTab.latestRequest.component.test.tsx
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

const PLACE2 = { ...PLACE, id: 'p2' };
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const F10 = { radiusKm: 10, openNow: false, minRating: null, sortBy: null };
const F25 = { ...F10, radiusKm: 25 };
const ROWS_10 = { places: [PLACE], total: 1, destination: 'Paris', cached: false };
const ROWS_25 = { places: [PLACE2], total: 1, destination: 'Paris', cached: false };

async function renderWith(filters: typeof F10) {
  const utils = await render(
    <DiscoveryCategoryTab category="places" destination="Paris" onSelectPlace={jest.fn()} onAddToPlan={jest.fn()} filters={filters as never} />,
  );
  await act(async () => {});
  return {
    ...utils,
    setFilters: async (next: typeof F10) => {
      await act(async () => {
        utils.rerender(<DiscoveryCategoryTab category="places" destination="Paris" onSelectPlace={jest.fn()} onAddToPlan={jest.fn()} filters={next as never} />);
      });
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDiscoveryPlaces.mockReset();
  mockGetCachedDiscoveryPlaces.mockReturnValue(null);
});
afterEach(async () => { await act(async () => {}); });

describe('DiscoveryCategoryTab — only the latest request writes the screen (DV-83, §102)', () => {
  it('R3 (V5-R3) radius 25 REFUSED, then the superseded radius-10 answer lands: the refusal stands', async () => {
    const old = deferred<unknown>();
    mockGetDiscoveryPlaces.mockReturnValueOnce(old.promise);
    const t = await renderWith(F10);
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: REFUSED_PAGE });
    await t.setFilters(F25);
    expect(screen.getByTestId('discovery-category-error')).toBeTruthy();
    await act(async () => { old.resolve({ ok: true, data: ROWS_10 }); });
    await act(async () => {});
    expect({ card: screen.queryByTestId('card-p1') !== null, error: screen.queryByTestId('discovery-category-error') !== null })
      .toEqual({ card: false, error: true });
  });

  it('R4 (V5-R4) radius 25 FAILS in transport, then the superseded answer lands: no old rows under the failure', async () => {
    const old = deferred<unknown>();
    mockGetDiscoveryPlaces.mockReturnValueOnce(old.promise);
    const t = await renderWith(F10);
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await t.setFilters(F25);
    expect(screen.getByTestId('discovery-category-error')).toBeTruthy();
    await act(async () => { old.resolve({ ok: true, data: ROWS_10 }); });
    await act(async () => {});
    expect(screen.queryByTestId('card-p1')).toBeNull();
    expect(screen.getByTestId('discovery-category-error')).toBeTruthy();
  });

  it('R5 a superseded FAILURE never overwrites the newer good answer', async () => {
    const old = deferred<unknown>();
    mockGetDiscoveryPlaces.mockReturnValueOnce(old.promise);
    const t = await renderWith(F10);
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: ROWS_25 });
    await t.setFilters(F25);
    expect(screen.getByTestId('card-p2')).toBeTruthy();
    await act(async () => { old.resolve(NET_FAIL); });
    await act(async () => {});
    expect(screen.getByTestId('card-p2')).toBeTruthy();
    expect(screen.queryByTestId('discovery-category-stale')).toBeNull();
    expect(screen.getByText('1 places found')).toBeTruthy();
  });

  it('R6 a superseded load-more (page 2 of the old filters) never appends to the new list', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { ...ROWS_10, total: 50 } });
    const t = await renderWith(F10);
    const more = deferred<unknown>();
    mockGetDiscoveryPlaces.mockReturnValueOnce(more.promise);
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: ROWS_25 });
    await t.setFilters(F25);
    expect(screen.getByTestId('card-p2')).toBeTruthy();
    await act(async () => { more.resolve({ ok: true, data: { places: [{ ...PLACE, id: 'p-old-2' }], total: 50, destination: 'Paris', cached: false } }); });
    await act(async () => {});
    expect(screen.queryByTestId('card-p-old-2')).toBeNull();
    expect(screen.getByText('1 places found')).toBeTruthy();
  });

  it('R8 a load-more during the page-1 refresh of the same query does not swallow that refresh\'s failure', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue({ places: [PLACE], total: 50, destination: 'Paris', cached: false });
    const refresh = deferred<unknown>();
    mockGetDiscoveryPlaces.mockReturnValueOnce(refresh.promise);
    await renderWith(F10);
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE2], total: 50, destination: 'Paris', cached: false } });
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    await act(async () => {});
    expect(screen.getByTestId('card-p2')).toBeTruthy();
    await act(async () => { refresh.resolve(NET_FAIL); });
    await act(async () => {});
    expect(screen.getByTestId('discovery-category-stale')).toBeTruthy();
  });

  it('E8 failed refresh over a cached page, then a good page 2 reaching the total: no end claim beside the stale line', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue({ places: [PLACE], total: 2, destination: 'Paris', cached: false });
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await renderWith(F10);
    expect(screen.getByTestId('discovery-category-stale')).toBeTruthy();
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [PLACE2], total: 2, destination: 'Paris', cached: false } });
    await act(async () => { fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
    await act(async () => {});
    expect(screen.getByTestId('card-p2')).toBeTruthy();
    expect(screen.getByTestId('discovery-category-stale')).toBeTruthy();
    expect(screen.queryByText(/places found/)).toBeNull();
  });

  it('C1 CONTROL a single good answer is shown with its end claim', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: ROWS_10 });
    await renderWith(F10);
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    expect(screen.getByText('1 places found')).toBeTruthy();
  });

  it('R7 the newer good answer after an older good one wins', async () => {
    const old = deferred<unknown>();
    mockGetDiscoveryPlaces.mockReturnValueOnce(old.promise);
    const t = await renderWith(F10);
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: ROWS_25 });
    await t.setFilters(F25);
    await act(async () => { old.resolve({ ok: true, data: ROWS_10 }); });
    await act(async () => {});
    expect(screen.getByTestId('card-p2')).toBeTruthy();
    expect(screen.queryByTestId('card-p1')).toBeNull();
  });
});
