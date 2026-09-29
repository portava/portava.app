/**
 * DiscoveryCategoryTab — rows read for one query are never kept under ANOTHER
 * query's "couldn't refresh" line (census-discovery §103, lane W11-X2 round 7;
 * DV-83; register D-W11X2-47).
 *
 * §102.11 finding 1 was a cache that handed the tab another filter's page
 * (the key left most of the query out). The key is fixed at the service
 * (services/__tests__/discovery.cacheKey.test.ts). This suite pins the tab's own
 * guard, which does not trust the cache: every page and every failed read carries
 * the identity of the query it was sent for (services/discoveryQueryStamp.ts),
 * and a failed page-1 read whose identity differs from the rows on screen clears
 * them, so the tab draws its error state, never those rows under the stale line.
 *
 * The service is mocked as a LYING cache: it hands back the any-age page for any
 * query, stamped (truthfully) as the any-age page.
 *
 *   G1  hydrated from a page stamped for another query, this query's read fails →
 *       no rows, no stale line, the error state
 *   G2  rows from a GOOD answer for query A, then query B's read fails without a
 *       cache hit in between → the error state
 *   G3  mounted straight onto a page stamped for another query, this query's first read fails → the error state
 *   C1  CONTROL: the same query's refresh fails → its rows stay under the stale line
 *   C2  CONTROL: an unstamped failure (identity unknown) is not judged → rows stay
 *
 * Run with: npx jest src/components/discovery/__tests__/DiscoveryCategoryTab.heldQuery.component.test.tsx
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react-native';
import { stampDiscoveryQuery } from '../../../services/discoveryQueryStamp.ts';

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
jest.mock('../../selectors/GlobalPlacePicker', () => ({ POPULAR: [], GlobalPlacePicker: Null }));

import { DiscoveryCategoryTab } from '../DiscoveryCategoryTab.tsx';

const PLACE = (id: string) => ({
  id, name: id, category: 'places', type: null, description: null, distanceKm: null, lat: null, lng: null,
  tags: [], address: null, website: null, phone: null, openingHours: null, rating: null, isOpenNow: null,
});
const F10 = { radiusKm: 10, openNow: false, minRating: null, sortBy: null };
const ANY_AGE = 'category=places&destination=paris&radiusKm=10';
const AGE_21 = 'ageFilter=21_plus&category=places&destination=paris&radiusKm=10';
const page = (id: string, identity: string) => stampDiscoveryQuery({ places: [PLACE(id)], total: 1, destination: 'Paris', cached: false }, identity);
const failed = (identity: string | null) => {
  const f = { ok: false as const, error: 'Network error — check your connection' };
  return identity ? stampDiscoveryQuery(f, identity) : f;
};

function tab(ageFilter: string) {
  return <DiscoveryCategoryTab category="places" destination="Paris" onSelectPlace={jest.fn()} onAddToPlan={jest.fn()} filters={F10 as never} ageFilter={ageFilter as never} />;
}
const onScreen = () => ({
  row: screen.queryByTestId('card-any-age') !== null,
  stale: screen.queryByTestId('discovery-category-stale') !== null,
  error: screen.queryByTestId('discovery-category-error') !== null,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDiscoveryPlaces.mockReset();
  mockGetCachedDiscoveryPlaces.mockReset();
  mockGetCachedDiscoveryPlaces.mockReturnValue(null);
});
afterEach(async () => { await act(async () => {}); });

describe('§103 DiscoveryCategoryTab — another query\'s rows are never kept under this query\'s failure (D-W11X2-47)', () => {
  it('G1 hydrated from a page stamped for another query (a lying cache), this query\'s read FAILS → the error state, no stale line', async () => {
    mockGetCachedDiscoveryPlaces.mockImplementation(() => page('any-age', ANY_AGE));
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: page('any-age', ANY_AGE) });
    const t = await render(tab('any'));
    await act(async () => {});
    expect(onScreen()).toEqual({ row: true, stale: false, error: false });
    mockGetDiscoveryPlaces.mockResolvedValueOnce(failed(AGE_21));
    await act(async () => { t.rerender(tab('21_plus')); });
    await act(async () => {});
    expect(onScreen()).toEqual({ row: false, stale: false, error: true });
  });

  it('G2 rows from a GOOD answer for one query, then another query\'s read FAILS with no cache in between → the error state', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: page('any-age', ANY_AGE) });
    const t = await render(tab('any'));
    await act(async () => {});
    expect(onScreen().row).toBe(true);
    // the tab's own hydration would clear the rows on a cache miss; keep them there, as a lying cache would
    mockGetCachedDiscoveryPlaces.mockImplementation(() => page('any-age', ANY_AGE));
    mockGetDiscoveryPlaces.mockResolvedValueOnce(failed(AGE_21));
    await act(async () => { t.rerender(tab('21_plus')); });
    await act(async () => {});
    expect(onScreen()).toEqual({ row: false, stale: false, error: true });
  });

  it('G3 mounted straight onto a page stamped for another query (no answer in between), this query\'s first read FAILS → the error state', async () => {
    mockGetCachedDiscoveryPlaces.mockImplementation(() => page('any-age', ANY_AGE));
    mockGetDiscoveryPlaces.mockResolvedValueOnce(failed(AGE_21));
    await render(tab('21_plus'));
    await act(async () => {});
    expect(onScreen()).toEqual({ row: false, stale: false, error: true });
  });

  it('C1 CONTROL: the SAME query\'s refresh fails → its rows stay under the stale line', async () => {
    mockGetCachedDiscoveryPlaces.mockImplementation(() => page('any-age', ANY_AGE));
    mockGetDiscoveryPlaces.mockResolvedValueOnce(failed(ANY_AGE));
    await render(tab('any'));
    await act(async () => {});
    expect(onScreen()).toEqual({ row: true, stale: true, error: false });
  });

  it('C2 CONTROL: a failure with no identity is not judged → the rows stay under the stale line', async () => {
    mockGetCachedDiscoveryPlaces.mockImplementation(() => page('any-age', ANY_AGE));
    mockGetDiscoveryPlaces.mockResolvedValueOnce(failed(null));
    const t = await render(tab('any'));
    await act(async () => {});
    mockGetDiscoveryPlaces.mockResolvedValueOnce(failed(null));
    await act(async () => { t.rerender(tab('21_plus')); });
    await act(async () => {});
    expect(onScreen()).toEqual({ row: true, stale: true, error: false });
  });
});
