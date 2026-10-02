/**
 * DiscoveryCategoryTab — census-discovery §91 (lane W10-I), A07: a page whose
 * "now" claims the server WITHHELD says so.
 *
 * §79 made a failed Live read fail closed: the rows are served without their
 * "open around now" reason, and the envelope carries `meta.liveSafety:
 * { readable: false, claimsWithheld }`. Without a notice the missing reason
 * reads as "nothing is on", which is the claim the server refused to make.
 * The copy is the event rail's own first sentence (DiscoveryEventPostsRail).
 *
 *   L1  meta.liveSafety.readable === false: the notice is shown over the list
 *   L2  CONTROL: a healthy page (no meta.liveSafety) shows no notice
 *   L3  a later healthy page-1 answer (pull to refresh) clears it
 *
 * The harness is DiscoveryCategoryTab.refusal.component.test.tsx's.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react-native';

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
// NOTE: intentional stub — not under test; real PlaceCard pulls react-native-maps.
jest.mock('../PlaceCard', () => ({ __esModule: true, default: Null }));
// NOTE: intentional stub — not under test; pulls reanimated animations.
jest.mock('../PlaceSkeleton', () => ({ PlaceSkeletonList: Null }));
// NOTE: intentional stub — not under test; pulls native modules + navigation.
jest.mock('../../selectors/GlobalPlacePicker', () => ({
  POPULAR: [],
  GlobalPlacePicker: Null,
}));

import { DiscoveryCategoryTab } from '../DiscoveryCategoryTab.tsx';

const MOCK_PLACE = {
  id: 'p1', name: 'Eiffel Tower', category: 'places', type: null, description: null,
  distanceKm: null, lat: null, lng: null, tags: [], address: null, website: null,
  phone: null, openingHours: null, rating: null, isOpenNow: null,
};

async function renderTab() {
  return render(
    <DiscoveryCategoryTab
      category="places"
      destination="Paris"
      onSelectPlace={jest.fn()}
      onAddToPlan={jest.fn()}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCachedDiscoveryPlaces.mockReturnValue(null);
  mockGetDiscoveryPlaces.mockResolvedValue({
    ok: true, data: { places: [MOCK_PLACE], total: 1 },
  });
});

afterEach(async () => { await act(async () => {}); });

const NOTICE = "We couldn't check what's live nearby just now.";
const withheld = { ok: true, data: { places: [MOCK_PLACE], total: 1, destination: 'Paris', cached: false, meta: { liveSafety: { readable: false, claimsWithheld: 1 } } } };

describe('DiscoveryCategoryTab — meta.liveSafety (census-discovery §91, A07)', () => {
  it('L1. a page whose Live read failed says the "now" claims were not checked', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue(withheld);
    await renderTab();
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(screen.getByTestId('discovery-live-unchecked')).toBeTruthy();
  });

  it('L2. CONTROL: a healthy page shows no notice', async () => {
    await renderTab();
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('L3. a later healthy page-1 answer clears it', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue(withheld);
    const r = await renderTab();
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: { places: [MOCK_PLACE], total: 1, destination: 'Paris', cached: false } });
    await r.rerender(
      <DiscoveryCategoryTab category="places" destination="Lyon" onSelectPlace={jest.fn()} onAddToPlan={jest.fn()} />,
    );
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
