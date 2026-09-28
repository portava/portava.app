/**
 * DiscoveryCategoryTab — a refused LOAD-MORE is not the end of the list.
 *
 * census-discovery DV-83 (`11` §9 / owner ruling D11, the consumer leg):
 * "A distinguishable response body alone is insufficient if consumers still
 * treat it as successful empty data."
 *
 * The page-1 refusal was fixed (DiscoveryCategoryTab.refusal.component.test.tsx)
 * and deliberately scoped to page 1 — "a refused 'load more' must not replace a
 * page of genuine results already on screen with a failure card". Correct, but
 * the refused load-more did not then stop: it FELL THROUGH to the success path,
 * which set `total` to the refusal's padding `0` and advanced `page`. With 20
 * rows on screen and `total` 0, the footer printed "20 places found" — the
 * list's own claim that the set had ended — and `handleLoadMore` refused every
 * further page (`places.length >= total`). A read nobody performed was rendered
 * as the last page of a complete answer.
 *
 * The copy is the page-1 refusal's own sentence and the transport-failure
 * state's own "Try again"; nothing here is new wording.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react-native';

const mockGetDiscoveryPlaces       = jest.fn();
const mockGetCachedDiscoveryPlaces = jest.fn();

// NOTE: intentionally exhaustive — the real module loads the Supabase client
// through apiToken; this suite is about what the SCREEN does with each answer.
jest.mock('../../../services/discovery', () => ({
  getDiscoveryPlaces:       (...args: unknown[]) => mockGetDiscoveryPlaces(...args),
  getCachedDiscoveryPlaces: (...args: unknown[]) => mockGetCachedDiscoveryPlaces(...args),
}));

// NOTE: intentionally exhaustive — the real hook fetches from a remote API.
jest.mock('../../../hooks/usePopularCities', () => ({
  usePopularCities: () => ({ places: [], loading: false }),
}));

// NOTE: intentional stub — the real PlaceCard pulls react-native-maps; this one
// renders the place name so the rows ON SCREEN can be counted.
jest.mock('../PlaceCard', () => {
  const { Text } = jest.requireActual('react-native');
  return { __esModule: true, default: ({ place }: { place: { name: string } }) => <Text>{place.name}</Text> };
});
const Null = () => null;
// NOTE: intentional stub — not under test; pulls reanimated animations.
jest.mock('../PlaceSkeleton', () => ({ PlaceSkeletonList: Null }));
// NOTE: intentional stub — not under test; pulls native modules + navigation.
jest.mock('../../selectors/GlobalPlacePicker', () => ({
  POPULAR: [],
  GlobalPlacePicker: Null,
}));

import { DiscoveryCategoryTab } from '../DiscoveryCategoryTab.tsx';

const placeN = (n: number) => ({
  id: `p${n}`, name: `Place ${n}`, category: 'places', type: null, description: null,
  distanceKm: null, lat: null, lng: null, tags: [], address: null, website: null,
  phone: null, openingHours: null, rating: null, isOpenNow: null,
});
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => placeN(from + i));

/**
 * Page 1 of a 10-place category: 5 rows now, 5 more on page 2. Small pages so
 * FlatList's first render window (10 rows) shows every row the list holds.
 */
const PAGE_1 = { ok: true, data: { places: range(1, 5), total: 10, destination: 'Paris', cached: false } };
const PAGE_2 = { ok: true, data: { places: range(6, 10), total: 10, destination: 'Paris', cached: false } };
/** What GET /discovery answers when it could not read page 2 at all. */
const PAGE_2_REFUSED = {
  ok: true,
  data: {
    places: [], total: 0, destination: 'Paris', cached: false,
    refusal: { class: 'transient_db', code: 'discovery_assembly_failed', route: 'GET /discovery', coverage: 'nothing' as const },
  },
};
const REFUSED_COPY = "We couldn't load places just now — this is on our side, not your filters.";

async function renderWithPage1() {
  mockGetDiscoveryPlaces.mockResolvedValueOnce(PAGE_1);
  await render(
    <DiscoveryCategoryTab category="places" destination="Paris" onSelectPlace={jest.fn()} onAddToPlan={jest.fn()} />,
  );
  expect(await screen.findByText('Place 5')).toBeTruthy();
}

async function scrollToEnd() {
  await act(async () => { await fireEvent(screen.getByTestId('main-scroll'), 'onEndReached'); });
  await act(async () => {});
}

const pageArg = (call: unknown[]) => call[3];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCachedDiscoveryPlaces.mockReturnValue(null);
});

afterEach(async () => { await act(async () => {}); });

describe('DiscoveryCategoryTab — a refused page 2 is not the last page', () => {
  it('keeps page 1 on screen and does NOT print the end-of-list count', async () => {
    await renderWithPage1();
    mockGetDiscoveryPlaces.mockResolvedValueOnce(PAGE_2_REFUSED);
    await scrollToEnd();
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2));
    expect(pageArg(mockGetDiscoveryPlaces.mock.calls[1]!)).toBe(2);

    expect(screen.getByText('Place 1')).toBeTruthy();
    expect(screen.getByText('Place 5')).toBeTruthy();
    expect(screen.queryByText(/places found/)).toBeNull();   // "5 places found" is a claim the set ended
    expect(screen.queryByText('No places found')).toBeNull();
  });

  it('says so where page 2 would be, with the retry the failure state already offers — and the retry asks for page 2 again', async () => {
    await renderWithPage1();
    mockGetDiscoveryPlaces.mockResolvedValueOnce(PAGE_2_REFUSED);
    await scrollToEnd();
    expect(await screen.findByText(REFUSED_COPY)).toBeTruthy();
    expect(screen.getByTestId('discovery-category-more-refused')).toBeTruthy();

    mockGetDiscoveryPlaces.mockResolvedValueOnce(PAGE_2);
    await act(async () => { await fireEvent.press(screen.getByText('Try again')); });
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(3));
    expect(pageArg(mockGetDiscoveryPlaces.mock.calls[2]!)).toBe(2);
    expect(await screen.findByText('Place 10')).toBeTruthy();
    expect(screen.getByText('10 places found')).toBeTruthy();   // the real total survived the refusal
    expect(screen.queryByText(REFUSED_COPY)).toBeNull();
  });

  it('does not auto-retry on every scroll during the outage: only the explicit retry asks again', async () => {
    await renderWithPage1();
    mockGetDiscoveryPlaces.mockResolvedValueOnce(PAGE_2_REFUSED);
    await scrollToEnd();
    await screen.findByText(REFUSED_COPY);
    await scrollToEnd();
    await scrollToEnd();
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: a genuine page 2 is appended and the end-of-list count is the real one', async () => {
    await renderWithPage1();
    mockGetDiscoveryPlaces.mockResolvedValueOnce(PAGE_2);
    await scrollToEnd();
    expect(await screen.findByText('Place 10')).toBeTruthy();
    expect(screen.getByText('10 places found')).toBeTruthy();
    expect(screen.queryByText(REFUSED_COPY)).toBeNull();
  });

  it('CONTROL: a genuinely EMPTY page 2 (no refusal) ends the list — the two answers stay two answers', async () => {
    await renderWithPage1();
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { places: [], total: 5, destination: 'Paris', cached: false } });
    await scrollToEnd();
    expect(await screen.findByText('5 places found')).toBeTruthy();
    expect(screen.queryByText(REFUSED_COPY)).toBeNull();
  });

  it('CONTROL: a PARTIAL page 2 renders the rows it carries — partial is not routed to the notice', async () => {
    await renderWithPage1();
    mockGetDiscoveryPlaces.mockResolvedValueOnce({
      ok: true,
      data: { ...PAGE_2.data, refusal: { ...PAGE_2_REFUSED.data.refusal, coverage: 'partial' as const, failedSources: ['discovery_places'] } },
    });
    await scrollToEnd();
    expect(await screen.findByText('Place 10')).toBeTruthy();
    expect(screen.queryByText(REFUSED_COPY)).toBeNull();
  });
});
