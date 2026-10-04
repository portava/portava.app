/**
 * ForYouTab — a FAILED read is not an empty tab, and map mode states coverage
 * (census-discovery §100, lane W11-X2 round 4; DV-83, §99.8 findings 1 and 3).
 *
 * §99.8 finding 1: an `ok: false` answer from getDiscoveryPlaces (a network
 * failure or a non-2xx) set `source 'none'` and returned `[]`, so the tab said
 * "No recommendations yet" about a city nobody read, and a failed REFETCH
 * replaced cards already hydrated from the cache (a cached partial page lost
 * its notice with them). Register D-W11X2-22: a transport failure is its own
 * state (`for-you-error`, DiscoveryCategoryTab's "Couldn't load places" copy),
 * and a failed refetch keeps what is on screen, with its partial notice if it
 * had one, under a "couldn't refresh" line (`for-you-stale`).
 *
 * §99.8 finding 3: the map branch returned before any of the list's coverage
 * states, so a refused, partial or failed read drew a plain map. Register
 * D-W11X2-24: map mode draws the same states, with the same testIDs, in a
 * banner over the map, with a "Try again" (map mode has no pull-to-refresh).
 *
 *   T1  no cache, transport failure: the error state, never "No recommendations yet"
 *   T2  cached COMPLETE page, failed refetch: cards kept, `for-you-stale`, no empty state
 *   T3  cached PARTIAL page, failed refetch: cards kept, `for-you-partial` AND `for-you-stale`
 *   T4  cached PARTIAL-EMPTY page, failed refetch: `for-you-partial-empty` kept, plus `for-you-stale`
 *   T5  network page on screen, then a failed pull-to-refresh: cards kept, `for-you-stale`
 *   T6  a failure, then a good refetch: the error clears and the cards arrive
 *   T7  a failure does not clear the kept page's live-unchecked notice (§91)
 *   T8  a REJECTED read (the service threw) is the same failure: the error state
 *   T9  a new query (sort change) starts clean: the previous query's failure is not carried onto its cached page
 *   M1  map, refused (`nothing`): `for-you-refused` over the map
 *   M2  map, partial with places: `for-you-partial` over the map
 *   M3  map, partial with no places: `for-you-partial-empty` over the map
 *   M4  map, transport failure, no cache: `for-you-error` over the map
 *   M5  map, cached partial page, failed refetch: `for-you-partial` + `for-you-stale`
 *   M6  map, the banner's "Try again" asks again
 *   C1  CONTROL: a genuinely empty COMPLETE answer is still "No recommendations yet"
 *   C2  CONTROL: a refused answer is still `for-you-refused`, not the error state
 *   C3  CONTROL: map, a complete page draws no banner
 *   C4  CONTROL: a good refetch over a cached page draws no stale line
 *   K1  the community read failed in transport, nothing held: `for-you-community-unavailable`, never silence (D-W11X2-26)
 *   K2  the community read failed over gems still held: the sections stay, with `for-you-community-stale`
 *   K3  map, the community read refused: `for-you-community-refused` over the map
 *   K4  map, the community read partial: `for-you-community-partial` over the map
 *   K5  map, the community read failed in transport: `for-you-community-unavailable` over the map
 *   C5  CONTROL: a quiet, healthy community lane draws none of these, in either mode
 *
 * Run with: npx jest src/components/discovery/__tests__/ForYouTab.failedRead.component.test.tsx
 */

import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react-native';

// ── Services ──────────────────────────────────────────────────────────────────

const mockGetDiscoveryPlaces       = jest.fn();
const mockGetCachedDiscoveryPlaces = jest.fn();
const mockGetSavedPlaceIds         = jest.fn();

// NOTE: intentionally exhaustive — the real module imports Supabase; spreading
// requireActual would load the client and OOM the Jest runner.
jest.mock('../../../services/discovery', () => ({
  getDiscoveryPlaces:       (...args: unknown[]) => mockGetDiscoveryPlaces(...args),
  getSavedPlaceIds:         (...args: unknown[]) => mockGetSavedPlaceIds(...args),
  getCachedDiscoveryPlaces: (...args: unknown[]) => mockGetCachedDiscoveryPlaces(...args),
  getDiscoveryFeed:         jest.fn().mockResolvedValue({ ok: false, error: 'test' }),
}));

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../services/compass', () => ({
  postCompassFrontloadEvent:  jest.fn().mockResolvedValue(undefined),
  reportCompassViewed:        jest.fn().mockResolvedValue(undefined),
  fetchCompassSettings:       jest.fn().mockResolvedValue({ data: null, error: null }),
  fetchCompassPreferences:    jest.fn().mockResolvedValue({ data: null, error: null }),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — the real hook imports Supabase + realtime.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ isAuthed: true, userId: 'u-test-1' }),
}));

// NOTE: intentionally exhaustive — the real hook opens Compass WebSocket.
jest.mock('../../../hooks/compass/useCompassFeed', () => ({
  useCompassFeed: () => ({ data: null, compassEnabled: false, refresh: jest.fn() }),
}));

// NOTE: intentionally exhaustive — the real hook fetches community posts.
// The lane's state is set per test: the hook ALREADY computes a `refused` flag
// (useCommunityDiscovery.ts), and property (3) below is about whether this
// screen reads it. The default below is the quiet, healthy, empty city, which
// is what every pre-existing case in this file assumes.
const mockCommunityState: { current: Record<string, unknown> } = {
  current: { gems: [], picks: [], places: [], loading: false, refused: false },
};
// `jest.requireActual` is NOT the fix here — the real module reaches Supabase at
// import time, which is why this component test mocks it at all. It exports one
// symbol today, so the stand-in is complete.
// NOTE: intentionally exhaustive; see the block above for what it stands in for.
jest.mock('../../../hooks/useCommunityDiscovery', () => ({
  useCommunityDiscovery: () => mockCommunityState.current,
}));

// ── Heavy child component stubs ───────────────────────────────────────────────

const Null = () => null;

// NOTE: intentional stub — the real card pulls react-native-maps. It renders a
// marker per place so a test can see which cards are on screen.
jest.mock('../PlaceCard', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: ({ place }: { place: { id: string } }) => React.createElement(View, { testID: `card-${place.id}` }) };
});
// NOTE: intentional stub — the real map pulls MapLibre native modules. It renders
// one marker, so a test can see that map mode drew the map and not the list.
jest.mock('../DiscoveryMapView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { DiscoveryMapView: () => React.createElement(View, { testID: 'discovery-map' }) };
});
// NOTE: intentional stub — not under test; pulls native Sheet modules.
jest.mock('../PlaceDetailSheet', () => ({ PlaceDetailSheet: Null }));
// NOTE: intentional stub — not under test; pulls native Share + Sheet modules.
jest.mock('../../DiscoveryShareSheet', () => ({ DiscoveryShareSheet: Null }));
// NOTE: intentional stub — not under test; pulls Supabase.
jest.mock('../../compass/CompassFeedbackMenu', () => ({ CompassFeedbackMenu: Null }));
// NOTE: intentional stub — not under test; pulls Supabase.
jest.mock('../../compass/CompassWhySheet', () => ({ CompassWhySheet: Null }));
// NOTE: intentional stub — not under test; pulls Supabase + native modules.
jest.mock('../../compass/CompassTravelerRow', () => ({ CompassTravelerRow: Null }));
// NOTE: intentional stub — not under test; pulls SVG native module.
jest.mock('../../icons/TelegraphSendIcon', () => ({ TelegraphSendIcon: Null }));

// `prefillSavedPlaceIds` is THE probe for property (1): it is the one call that
// writes the bookmark state DiscoveryWall's cards read. Every assertion about
// bookmarks surviving is an assertion about whether, and with what, it was
// called.
const mockPrefillSavedPlaceIds = jest.fn();
// NOTE: intentional stub — not under test; pulls Supabase + community data.
jest.mock('../../DiscoveryWall', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    // Rendered rather than nulled so the POSITIVE CONTROLS in property (3) can
    // show that a lane which DID answer still puts its sections on screen.
    HiddenGemsSection:    () => React.createElement(View, { testID: 'hidden-gems-section' }),
    TravelerPicksSection: () => React.createElement(View, { testID: 'traveler-picks-section' }),
    prefillSavedPlaceIds: (...args: unknown[]) => mockPrefillSavedPlaceIds(...args),
  };
});
// NOTE: intentional stub — not under test; pulls reanimated animations.
jest.mock('../PlaceSkeleton', () => ({ PlaceSkeletonList: Null }));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { ForYouTab } from '../ForYouTab.tsx';

const PLACE = { id: 'p1', name: 'Cafe A', category: 'food', type: null, description: null,
  distanceKm: null, lat: null, lng: null, tags: [], address: null, website: null,
  phone: null, openingHours: null, rating: null, isOpenNow: null };
const PLACE2 = { ...PLACE, id: 'p2', name: 'Cafe B' };
const PARTIAL_REFUSAL = {
  class: 'upstream_unavailable', code: 'overpass_unavailable', route: 'GET /discovery',
  coverage: 'partial' as const, failedSources: ['overpass'],
};
const NOTHING_REFUSAL = { ...PARTIAL_REFUSAL, coverage: 'nothing' as const, failedSources: ['overpass', 'curated', 'canonical'] };
const COMPLETE_PAGE = { places: [PLACE], total: 1, destination: 'Lisbon', cached: false };
const PARTIAL_PAGE = { ...COMPLETE_PAGE, refusal: PARTIAL_REFUSAL };
const PARTIAL_EMPTY_PAGE = { places: [], total: 0, destination: 'Lisbon', cached: false, refusal: PARTIAL_REFUSAL };
const REFUSED_PAGE = { places: [], total: 0, destination: 'Lisbon', cached: false, refusal: NOTHING_REFUSAL };
const EMPTY_PAGE = { places: [], total: 0, destination: 'Lisbon', cached: false };
const NET_FAIL = { ok: false, error: 'Network error — check your connection' };
const HTTP_FAIL = { ok: false, error: 'HTTP 503' };

/** RNTL v14's `render` is async in this project — every call site awaits it. */
async function renderTab(viewMode: 'list' | 'map' = 'list') {
  await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} viewMode={viewMode} />);
  await act(async () => {});
}

async function pullToRefresh() {
  const scroll = screen.getByTestId('main-scroll');
  await act(async () => { scroll.props.refreshControl.props.onRefresh(); });
  await act(async () => {});
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCommunityState.current = { gems: [], picks: [], places: [], loading: false, refused: false };
  mockGetCachedDiscoveryPlaces.mockReturnValue(null);
  mockGetSavedPlaceIds.mockResolvedValue({ ok: true, ids: [] });
});

afterEach(async () => { await act(async () => {}); });

describe('ForYouTab — a transport failure is its own state, and never wipes a cached page (§100, D-W11X2-22)', () => {
  it('T1 no cache, transport failure: the error state, never "No recommendations yet"', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue(NET_FAIL);
    await renderTab();
    expect(screen.queryByText('No recommendations yet')).toBeNull();
    expect(screen.getByTestId('for-you-error')).toBeTruthy();
    expect(screen.getByText("Couldn't load places")).toBeTruthy();
    expect(screen.getByText(/Network error — check your connection/)).toBeTruthy();
    expect(screen.queryByTestId('for-you-refused')).toBeNull();
  });

  it('T2 cached COMPLETE page, failed refetch: the cards stay, under a "couldn\'t refresh" line', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(COMPLETE_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue(HTTP_FAIL);
    await renderTab();
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    expect(screen.getByTestId('for-you-stale')).toBeTruthy();
    expect(screen.queryByText('No recommendations yet')).toBeNull();
    expect(screen.queryByTestId('for-you-error')).toBeNull();
    expect(screen.queryByTestId('for-you-partial')).toBeNull();
  });

  it('T3 cached PARTIAL page, failed refetch: the cards AND the partial notice stay, plus the stale line', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(PARTIAL_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue(HTTP_FAIL);
    await renderTab();
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    expect(screen.getByTestId('for-you-partial')).toBeTruthy();
    expect(screen.getByTestId('for-you-stale')).toBeTruthy();
    expect(screen.queryByText('No recommendations yet')).toBeNull();
  });

  it('T4 cached PARTIAL-EMPTY page, failed refetch: the partial-empty state stays, plus the stale line', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(PARTIAL_EMPTY_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue(NET_FAIL);
    await renderTab();
    expect(screen.getByTestId('for-you-partial-empty')).toBeTruthy();
    expect(screen.getByTestId('for-you-stale')).toBeTruthy();
    expect(screen.queryByText('No recommendations yet')).toBeNull();
    expect(screen.queryByTestId('for-you-error')).toBeNull();
  });

  it('T5 a network page on screen, then a failed pull-to-refresh: the cards stay, with the stale line', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: COMPLETE_PAGE });
    await renderTab();
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    expect(screen.queryByTestId('for-you-stale')).toBeNull();
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await pullToRefresh();
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    expect(screen.getByTestId('for-you-stale')).toBeTruthy();
    expect(screen.queryByText('No recommendations yet')).toBeNull();
  });

  it('T6 a failure, then a good refetch: the error clears and the new cards arrive', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await renderTab();
    expect(screen.getByTestId('for-you-error')).toBeTruthy();
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { ...COMPLETE_PAGE, places: [PLACE2] } });
    await pullToRefresh();
    expect(screen.queryByTestId('for-you-error')).toBeNull();
    expect(screen.queryByTestId('for-you-stale')).toBeNull();
    expect(screen.getByTestId('card-p2')).toBeTruthy();
  });

  it('T7 a failed refetch does not clear the kept page\'s live-unchecked notice (§91)', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: { ...COMPLETE_PAGE, meta: { liveSafety: { readable: false } } } });
    await renderTab();
    expect(screen.getByTestId('for-you-live-unchecked')).toBeTruthy();
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await pullToRefresh();
    // Whatever the good answer said about its own "now" claims still describes
    // the cards kept on screen; a failed refetch has no say in it.
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    expect(screen.getByTestId('for-you-live-unchecked')).toBeTruthy();
  });

  it('T8 a REJECTED read (the service threw) is the same failure: the error state', async () => {
    mockGetDiscoveryPlaces.mockRejectedValue(new Error('boom'));
    await renderTab();
    expect(screen.getByTestId('for-you-error')).toBeTruthy();
    expect(screen.queryByText('No recommendations yet')).toBeNull();
  });

  it('T9 a new query starts clean: the previous query\'s failure is not carried onto its cached page', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(COMPLETE_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValueOnce(HTTP_FAIL);
    const view = await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} sortBy={null} />);
    await act(async () => {});
    expect(screen.getByTestId('for-you-stale')).toBeTruthy();
    mockGetDiscoveryPlaces.mockReturnValueOnce(new Promise(() => undefined));  // the new query's read is still in flight
    await view.rerender(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} sortBy="rating" />);
    await act(async () => {});
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    expect(screen.queryByTestId('for-you-stale')).toBeNull();
  });

  it('C1 CONTROL: a genuinely empty COMPLETE answer is still "No recommendations yet"', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: EMPTY_PAGE });
    await renderTab();
    expect(screen.getByText('No recommendations yet')).toBeTruthy();
    expect(screen.queryByTestId('for-you-error')).toBeNull();
    expect(screen.queryByTestId('for-you-stale')).toBeNull();
  });

  it('C2 CONTROL: a refused answer is still the refused state, not the transport error', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: REFUSED_PAGE });
    await renderTab();
    expect(screen.getByTestId('for-you-refused')).toBeTruthy();
    expect(screen.queryByTestId('for-you-error')).toBeNull();
    expect(screen.queryByText('No recommendations yet')).toBeNull();
  });

  it('C4 CONTROL: a good refetch over a cached page draws no stale line', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(COMPLETE_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: COMPLETE_PAGE });
    await renderTab();
    expect(screen.getByTestId('card-p1')).toBeTruthy();
    expect(screen.queryByTestId('for-you-stale')).toBeNull();
    expect(screen.queryByTestId('for-you-error')).toBeNull();
  });
});

describe('ForYouTab map mode states the page\'s coverage over the map (§100, D-W11X2-24)', () => {
  it('M1 map, refused (`nothing`): the refused notice is over the map', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: REFUSED_PAGE });
    await renderTab('map');
    expect(screen.getByTestId('discovery-map')).toBeTruthy();
    expect(screen.getByTestId('for-you-refused')).toBeTruthy();
    expect(screen.getByText("Places aren't loading right now")).toBeTruthy();
  });

  it('M2 map, partial with places: the partial notice is over the map', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: PARTIAL_PAGE });
    await renderTab('map');
    expect(screen.getByTestId('discovery-map')).toBeTruthy();
    expect(screen.getByTestId('for-you-partial')).toBeTruthy();
    expect(screen.queryByTestId('for-you-refused')).toBeNull();
  });

  it('M3 map, partial with no places: the partial-empty notice is over the map', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: PARTIAL_EMPTY_PAGE });
    await renderTab('map');
    expect(screen.getByTestId('discovery-map')).toBeTruthy();
    expect(screen.getByTestId('for-you-partial-empty')).toBeTruthy();
  });

  it('M4 map, transport failure with no cache: the error state is over the map', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue(NET_FAIL);
    await renderTab('map');
    expect(screen.getByTestId('discovery-map')).toBeTruthy();
    expect(screen.getByTestId('for-you-error')).toBeTruthy();
    expect(screen.getByText("Couldn't load places")).toBeTruthy();
  });

  it('M5 map, cached partial page and a failed refetch: the partial notice and the stale line', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(PARTIAL_PAGE);
    mockGetDiscoveryPlaces.mockResolvedValue(HTTP_FAIL);
    await renderTab('map');
    expect(screen.getByTestId('for-you-partial')).toBeTruthy();
    expect(screen.getByTestId('for-you-stale')).toBeTruthy();
    expect(screen.queryByTestId('for-you-error')).toBeNull();
  });

  it('M6 map, the banner\'s "Try again" asks again (map mode has no pull-to-refresh)', async () => {
    mockGetDiscoveryPlaces.mockResolvedValueOnce(NET_FAIL);
    await renderTab('map');
    mockGetDiscoveryPlaces.mockResolvedValueOnce({ ok: true, data: COMPLETE_PAGE });
    await act(async () => { fireEvent.press(screen.getByText('Try again')); });
    await act(async () => {});
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('for-you-error')).toBeNull();
  });

  it('C3 CONTROL: map, a complete page draws no banner', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: COMPLETE_PAGE });
    await renderTab('map');
    expect(screen.getByTestId('discovery-map')).toBeTruthy();
    for (const id of ['for-you-refused', 'for-you-partial', 'for-you-partial-empty', 'for-you-error', 'for-you-stale']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });
});

describe('ForYouTab — the community lane\'s failed read is said too (§100, D-W11X2-26)', () => {
  const GEM = { id: 'g1', title: 'Gem', city: 'Lisbon' };
  it('K1 the community read failed in transport with nothing held: the unavailable state, never silence', async () => {
    mockCommunityState.current = { gems: [], picks: [], places: [], loading: false, refused: false, unavailable: true };
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: COMPLETE_PAGE });
    await renderTab();
    expect(screen.getByTestId('for-you-community-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('for-you-community-refused')).toBeNull();
    expect(screen.queryByTestId('for-you-community-stale')).toBeNull();
  });

  it('K2 the community read failed over gems still held: the sections stay, with the stale line', async () => {
    mockCommunityState.current = { gems: [GEM], picks: [], places: [], loading: false, refused: false, unavailable: true };
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: COMPLETE_PAGE });
    await renderTab();
    expect(screen.getByTestId('hidden-gems-section')).toBeTruthy();
    expect(screen.getByTestId('for-you-community-stale')).toBeTruthy();
    expect(screen.queryByTestId('for-you-community-unavailable')).toBeNull();
  });

  it('K3 map, the community read refused: its notice is over the map', async () => {
    mockCommunityState.current = { gems: [], picks: [], places: [], loading: false, refused: true };
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: COMPLETE_PAGE });
    await renderTab('map');
    expect(screen.getByTestId('discovery-map')).toBeTruthy();
    expect(screen.getByTestId('for-you-community-refused')).toBeTruthy();
  });

  it('K4 map, the community read partial: its notice is over the map', async () => {
    mockCommunityState.current = { gems: [GEM], picks: [], places: [], loading: false, refused: false, incomplete: true };
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: COMPLETE_PAGE });
    await renderTab('map');
    expect(screen.getByTestId('for-you-community-partial')).toBeTruthy();
  });

  it('K5 map, the community read failed in transport: its notice is over the map', async () => {
    mockCommunityState.current = { gems: [], picks: [], places: [], loading: false, refused: false, unavailable: true };
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: COMPLETE_PAGE });
    await renderTab('map');
    expect(screen.getByTestId('for-you-community-unavailable')).toBeTruthy();
  });

  it('C5 CONTROL: a quiet, healthy community lane draws none of these, in either mode', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: COMPLETE_PAGE });
    for (const mode of ['list', 'map'] as const) {
      await renderTab(mode);
      for (const id of ['for-you-community-unavailable', 'for-you-community-stale', 'for-you-community-refused', 'for-you-community-partial']) {
        expect(screen.queryByTestId(id)).toBeNull();
      }
    }
  });
});
