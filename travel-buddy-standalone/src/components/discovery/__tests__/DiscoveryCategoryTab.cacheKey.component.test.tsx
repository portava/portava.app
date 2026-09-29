/**
 * census-discovery §103 (DV-83, W11-X2 round 7): the verifier's §102.11 probe, kept as a failing-first test.
 * Real services/discovery (fetch mocked) under the real DiscoveryCategoryTab.
 */
// NOTE: a stand-in on purpose — the probe needs a signed-in, configured client and nothing else from the module.
jest.mock('../../../lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: false }));
// NOTE: a stand-in on purpose — only freshToken is read, and the probe fixes its value.
jest.mock('../../../services/apiToken', () => ({ freshToken: async () => 'tok-1' }));
// NOTE: a stand-in on purpose — the tab's empty-destination picker is not under test.
jest.mock('../../../hooks/usePopularCities', () => ({ usePopularCities: () => ({ places: [], loading: false }) }));
jest.mock('../PlaceCard', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: ({ place }: { place: { id: string } }) => React.createElement(View, { testID: `card-${place.id}` }) };
});
jest.mock('../DiscoveryMapView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { DiscoveryMapView: () => React.createElement(View, { testID: 'discovery-map' }) };
});
// NOTE: a stand-in on purpose — the skeleton's markup is not under test.
jest.mock('../PlaceSkeleton', () => ({ PlaceSkeletonList: () => null }));
// NOTE: a stand-in on purpose — the picker is not under test.
jest.mock('../../selectors/GlobalPlacePicker', () => ({ POPULAR: [], GlobalPlacePicker: () => null }));

import React from 'react';
import { render, screen, act } from '@testing-library/react-native';
import { DiscoveryCategoryTab } from '../DiscoveryCategoryTab.tsx';
import { _resetDiscoveryClientCache } from '../../../services/discovery.ts';

const PLACE = (id: string) => ({
  id, name: id, category: 'places', type: null, description: null, distanceKm: null, lat: null, lng: null,
  tags: [], address: null, website: null, phone: null, openingHours: null, rating: null, isOpenNow: null,
});
const F10 = { radiusKm: 10, openNow: false, minRating: null, sortBy: null };
let calls: string[] = [];
let respond: (url: string) => Promise<Response>;
const realFetch = global.fetch;
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => {
  calls = [];
  _resetDiscoveryClientCache();
  global.fetch = jest.fn((u: string) => { calls.push(String(u)); return respond(String(u)); }) as unknown as typeof fetch;
});
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));

function tab(props: Record<string, unknown>) {
  return <DiscoveryCategoryTab category="places" destination="Paris" onSelectPlace={jest.fn()} onAddToPlan={jest.fn()} filters={F10 as never} {...props} />;
}

describe('§102.11 DiscoveryCategoryTab — a failed read for one filter is not drawn over another filter\'s rows', () => {
  it('V6-K1 age filter any → 21_plus, the 21_plus read FAILS: the any-age rows are not shown under "couldn\'t refresh"', async () => {
    respond = () => ok({ places: [PLACE('any-age-only')], total: 1, destination: 'Paris', cached: false });
    const t = await render(tab({ ageFilter: 'any' }));
    await act(async () => {});
    expect(screen.queryByTestId('card-any-age-only')).not.toBeNull();

    respond = () => Promise.reject(new TypeError('Network request failed'));
    await act(async () => { t.rerender(tab({ ageFilter: '21_plus' })); });
    await act(async () => {});
    // the failed request WAS the 21_plus one
    expect(calls[calls.length - 1]).toContain('ageFilter=21_plus');
    expect({
      anyAgeRowShown: screen.queryByTestId('card-any-age-only') !== null,
      staleLine: screen.queryByTestId('discovery-category-stale') !== null,
    }).toEqual({ anyAgeRowShown: false, staleLine: false });
  });

  it('V6-K2 openNow off → on, the open-now read FAILS: the unfiltered rows are not shown under "couldn\'t refresh"', async () => {
    respond = () => ok({ places: [PLACE('closed-now')], total: 1, destination: 'Paris', cached: false });
    const t = await render(tab({}));
    await act(async () => {});
    expect(screen.queryByTestId('card-closed-now')).not.toBeNull();

    respond = () => Promise.reject(new TypeError('Network request failed'));
    await act(async () => { t.rerender(tab({ filters: { ...F10, openNow: true } })); });
    await act(async () => {});
    expect(calls[calls.length - 1]).toContain('openNow=1');
    expect({
      unfilteredRowShown: screen.queryByTestId('card-closed-now') !== null,
      staleLine: screen.queryByTestId('discovery-category-stale') !== null,
    }).toEqual({ unfilteredRowShown: false, staleLine: false });
  });

  it('V6-K3 CONTROL: same filters, refresh FAILS: the same query\'s rows stay under the stale line (legitimate)', async () => {
    respond = () => ok({ places: [PLACE('same')], total: 1, destination: 'Paris', cached: false });
    const t = await render(tab({ ageFilter: 'any' }));
    await act(async () => {});
    respond = () => Promise.reject(new TypeError('Network request failed'));
    await act(async () => { t.rerender(tab({ ageFilter: 'any', filters: { ...F10 } })); });
    await act(async () => {});
    expect(screen.queryByTestId('card-same')).not.toBeNull();
    expect(screen.queryByTestId('discovery-category-stale')).not.toBeNull();
  });

  it('V6-K4 §103: while the 21_plus read is in flight, the any-age page is not painted as its page', async () => {
    respond = () => ok({ places: [PLACE('any-age-only')], total: 1, destination: 'Paris', cached: false });
    const t = await render(tab({ ageFilter: 'any' }));
    await act(async () => {});
    expect(screen.queryByTestId('card-any-age-only')).not.toBeNull();
    respond = () => new Promise<Response>(() => {});
    await act(async () => { t.rerender(tab({ ageFilter: '21_plus' })); });
    expect(calls[calls.length - 1]).toContain('ageFilter=21_plus');
    expect(screen.queryByTestId('card-any-age-only')).toBeNull();
  });
});

