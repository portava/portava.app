/**
 * DiscoveryCategoryTab — a refused category is not an empty category.
 *
 * OWNER RULING, 2026-09-14: "...A distinguishable response body alone is
 * insufficient if consumers still treat it as successful empty data."
 *
 * ForYouTab is one of the two list surfaces on the Explore tab; this is the
 * other, and it carries SEVEN of the eight categories (places, food, nightlife,
 * activities, events, beaches, transport — app/(tabs)/discovery.tsx renders it
 * for every non-"for_you" tab). It already had an honest failure state with a
 * "Try again" button, reached when the transport fails — and a REFUSAL never
 * reached it, because a refusal is `ok: true` with an empty `places`. So the
 * server's refusal landed on:
 *
 *     "No places found — Try increasing the search radius or adjust the
 *      filters."
 *
 * which tells the user their own filters are why they see nothing, at the exact
 * moment the server has said it never looked. It sends them to fix something
 * that is not broken, on the strength of an answer nobody gave.
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

const UPSTREAM_REFUSAL = {
  class: 'upstream_unavailable', code: 'nominatim_http_429',
  route: 'GET /discovery', coverage: 'nothing' as const,
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

describe('DiscoveryCategoryTab — refusal vs. empty category', () => {
  it('does NOT tell the user to adjust their filters when the server refused', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true, data: { places: [], total: 0, destination: 'Paris', cached: false, refusal: UPSTREAM_REFUSAL },
    });
    await renderTab();
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText('No places found')).toBeNull();
    expect(screen.queryByText(/adjust the filters/i)).toBeNull();
  });

  it('shows the honest failure state, with the retry the transport-failure path already had', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true, data: { places: [], total: 0, destination: 'Paris', cached: false, refusal: UPSTREAM_REFUSAL },
    });
    await renderTab();
    expect(await screen.findByText("Couldn't load places")).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('POSITIVE CONTROL: a genuinely empty category still says "No places found"', async () => {
    // The two answers must remain two answers. Without this, the fix could be
    // "show the failure state for every empty result", which is the same
    // collapse pointed the other way.
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true, data: { places: [], total: 0, destination: 'Paris', cached: false },
    });
    await renderTab();
    expect(await screen.findByText('No places found')).toBeTruthy();
    expect(screen.queryByText("Couldn't load places")).toBeNull();
  });

  it('POSITIVE CONTROL: a real result still renders the list', async () => {
    await renderTab();
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText('No places found')).toBeNull();
    expect(screen.queryByText("Couldn't load places")).toBeNull();
  });

  it('a PARTIAL refusal that returned places renders them, not a failure', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true,
      data: { places: [MOCK_PLACE], total: 1, destination: 'Paris', cached: false,
        refusal: { ...UPSTREAM_REFUSAL, coverage: 'partial' as const, failedSources: ['places'] } },
    });
    await renderTab();
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText("Couldn't load places")).toBeNull();
    expect(screen.queryByText('No places found')).toBeNull();
  });
});

// census-discovery §80 (DV-83, register D-W10-S1-2). §60.2 recorded this tab's
// partial answer as "rows rendered as a complete answer (a partial page with no
// rows reads 'No places found')". Both halves are now decided: the rows stay and
// ONE line says the list may be incomplete; with no rows the tab says what
// happened — in its own "on our side, not your filters" words — and never blames
// the filters.
const PARTIAL_LINE = 'Some places couldn’t be loaded just now, so this list may be incomplete.';
const PARTIAL_REFUSAL = { ...UPSTREAM_REFUSAL, class: 'transient_db', code: 'discovery_place_sources_unreadable', coverage: 'partial' as const, failedSources: ['discovery_places'] };

describe('DiscoveryCategoryTab — a partial answer is not a complete one (§80)', () => {
  it('PARTIAL with places: the notice is stated above the list', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true, data: { places: [MOCK_PLACE], total: 1, destination: 'Paris', cached: false, refusal: PARTIAL_REFUSAL },
    });
    await renderTab();
    expect(await screen.findByTestId('discovery-category-partial')).toBeTruthy();
    expect(screen.getByText(PARTIAL_LINE)).toBeTruthy();
  });

  it('PARTIAL with NO places: not "No places found", not the filters, and a retry', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true, data: { places: [], total: 0, destination: 'Paris', cached: false, refusal: PARTIAL_REFUSAL },
    });
    await renderTab();
    expect(await screen.findByTestId('discovery-category-partial-empty')).toBeTruthy();
    expect(screen.queryByText('No places found')).toBeNull();
    expect(screen.queryByText(/adjust the filters/i)).toBeNull();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('CONTROL: a complete answer states no incomplete line', async () => {
    await renderTab();
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('discovery-category-partial')).toBeNull();
    expect(screen.queryByText(PARTIAL_LINE)).toBeNull();
  });
});
