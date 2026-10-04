/**
 * ForYouTab — a CACHED partial page is replayed as partial (census-discovery
 * §99, lane W11-X2 round 3; DV-83, §98.1 finding 2).
 *
 * `getDiscoveryPlaces` caches a `coverage: "partial"` body on purpose — its
 * rows are real — with the refusal intact (services/discovery.ts, the
 * `!refusedEverything` cache write). ForYouTab's SWR hydration painted that
 * page with `source 'none'` and `osmPartial false`, and the incomplete notice
 * requires `source === 'osm'`. So while the refetch was in flight, a page the
 * server had said was incomplete was shown as whole: the cards, no notice. The
 * same page fresh from the network showed the notice.
 *
 *   H1  a cached partial page with places: `for-you-partial` while the refetch is pending
 *   H2  a cached partial page with no places: the partial-empty state, never "No recommendations yet"
 *   H3  the notice follows the refetch: a complete answer clears it
 *   H0  the first frame, before the hydration effect runs, already states it
 *   C1  CONTROL: the same partial page fresh from the network shows the notice
 *   C2  CONTROL: a cached COMPLETE page shows no notice while the refetch is pending
 *   C3  CONTROL: no cache — the skeleton, then the network decides (no notice from nothing)
 *   C4  CONTROL: the first frame of a cached COMPLETE page states no notice
 *
 * Run with: npx jest src/components/discovery/__tests__/ForYouTab.cachedPartial.component.test.tsx
 */

import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react-native';

// ── React: effects can be held off for one render (H0 reads the first frame) ──

const mockHoldEffects = { current: false };
// NOTE: requireActual is safe here — React has no native or network import. Only
// `useEffect` is wrapped, and it delegates unless H0 holds effects off.
jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return { ...actual, useEffect: (fn: () => void, deps?: unknown[]) => (mockHoldEffects.current ? undefined : actual.useEffect(fn, deps)) };
});

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

// NOTE: intentional stub — not under test; real implementation pulls react-native-maps.
jest.mock('../PlaceCard', () => ({ __esModule: true, default: Null }));
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

const PARTIAL_REFUSAL = {
  class: 'upstream_unavailable', code: 'overpass_unavailable', route: 'GET /discovery',
  coverage: 'partial' as const, failedSources: ['overpass'],
};
const PLACE = { id: 'p1', name: 'Cafe A', category: 'food', type: null, description: null,
  distanceKm: null, lat: null, lng: null, tags: [], address: null, website: null,
  phone: null, openingHours: null, rating: null, isOpenNow: null };
const PARTIAL_PAGE = { places: [PLACE], total: 1, destination: 'Lisbon', cached: false, refusal: PARTIAL_REFUSAL };
const PARTIAL_EMPTY_PAGE = { places: [], total: 0, destination: 'Lisbon', cached: false, refusal: PARTIAL_REFUSAL };
const COMPLETE_PAGE = { places: [PLACE], total: 1, destination: 'Lisbon', cached: false };

/** RNTL v14's `render` is async in this project — every call site awaits it. */
async function renderTab() {
  return render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} />);
}

/** A refetch that has not answered yet: the window the cached page is on screen alone. */
function pendingRefetch(): (value: unknown) => void {
  let resolve: (value: unknown) => void = () => undefined;
  mockGetDiscoveryPlaces.mockReturnValue(new Promise((r) => { resolve = r; }));
  return (value) => resolve(value);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCommunityState.current = { gems: [], picks: [], places: [], loading: false, refused: false };
  mockGetCachedDiscoveryPlaces.mockReturnValue(null);
  mockGetSavedPlaceIds.mockResolvedValue({ ok: true, ids: [] });
});

afterEach(async () => { await act(async () => {}); });

describe('ForYouTab — the SWR replay keeps a partial page partial (§99)', () => {
  it('H1 a cached partial page with places states the incomplete notice while the refetch is pending', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(PARTIAL_PAGE);
    pendingRefetch();
    await renderTab();
    await act(async () => {});
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('for-you-partial')).toBeTruthy();
    expect(screen.queryByTestId('for-you-partial-empty')).toBeNull();
  });

  it('H2 a cached partial page with no places is the partial-empty state, never "No recommendations yet"', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(PARTIAL_EMPTY_PAGE);
    pendingRefetch();
    await renderTab();
    await act(async () => {});
    expect(screen.getByTestId('for-you-partial-empty')).toBeTruthy();
    expect(screen.queryByText('No recommendations yet')).toBeNull();
  });

  it('H3 the notice follows the refetch: a complete answer clears it', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(PARTIAL_PAGE);
    const answer = pendingRefetch();
    await renderTab();
    await act(async () => {});
    expect(screen.getByTestId('for-you-partial')).toBeTruthy();
    await act(async () => { answer({ ok: true, data: COMPLETE_PAGE }); });
    await waitFor(() => expect(screen.queryByTestId('for-you-partial')).toBeNull());
  });

  it('H0 the FIRST frame, before any effect has run, already states the notice', async () => {
    // The tab seeds its cards from the cache during its first render (the
    // `useState` initialiser), so the frame painted before the hydration effect
    // runs must already carry the page's coverage. Effects are held off for this
    // one render so that frame is what the assertion reads.
    mockGetCachedDiscoveryPlaces.mockReturnValue(PARTIAL_PAGE);
    pendingRefetch();
    mockHoldEffects.current = true;
    try {
      await renderTab();
      expect(mockGetDiscoveryPlaces).not.toHaveBeenCalled();
      expect(screen.getByTestId('for-you-partial')).toBeTruthy();
    } finally { mockHoldEffects.current = false; }
  });

  it('C4 CONTROL: the first frame of a cached COMPLETE page states no notice', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(COMPLETE_PAGE);
    pendingRefetch();
    mockHoldEffects.current = true;
    try {
      await renderTab();
      expect(screen.queryByTestId('for-you-partial')).toBeNull();
      expect(screen.queryByTestId('for-you-partial-empty')).toBeNull();
    } finally { mockHoldEffects.current = false; }
  });

  it('C1 CONTROL: the same partial page fresh from the network states the notice', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: PARTIAL_PAGE });
    await renderTab();
    expect(await screen.findByTestId('for-you-partial')).toBeTruthy();
  });

  it('C2 CONTROL: a cached COMPLETE page states no notice while the refetch is pending', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(COMPLETE_PAGE);
    pendingRefetch();
    await renderTab();
    await act(async () => {});
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('for-you-partial')).toBeNull();
    expect(screen.queryByTestId('for-you-partial-empty')).toBeNull();
  });

  it('C3 CONTROL: with no cache and the refetch pending, no notice is invented', async () => {
    pendingRefetch();
    await renderTab();
    await act(async () => {});
    expect(screen.queryByTestId('for-you-partial')).toBeNull();
    expect(screen.queryByTestId('for-you-partial-empty')).toBeNull();
  });
});

// census-discovery §123 (DV-83 round 24): a partial page says how to ask again. In list mode the notice and the
// partial-empty state named no control (the map-mode card has "Try again"; the list had only the pull gesture):
//   H4  a replayed cached partial page offers "Try again", and a press asks the network again
//   H5  the partial-empty state offers "Try again", and a press asks the network again
//   C5  CONTROL: a complete page offers no retry
// (Stated here, not in the header: census-discovery cites H1, H0 and C2 above by line.)
describe('ForYouTab — a partial page offers a retry (§123)', () => {
  it('H4 a replayed cached partial page offers "Try again", and a press asks the network again', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(PARTIAL_PAGE);
    pendingRefetch();
    await renderTab();
    await act(async () => {});
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.press(screen.getByTestId('for-you-partial-retry')); });
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('for-you-partial')).toBeTruthy();  // still partial until an answer says otherwise
  });

  it('H5 the partial-empty state offers "Try again", and a press asks the network again', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(PARTIAL_EMPTY_PAGE);
    pendingRefetch();
    await renderTab();
    await act(async () => {});
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.press(screen.getByTestId('for-you-partial-empty-retry')); });
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2);
  });

  it('C5 CONTROL: a complete page offers no retry', async () => {
    mockGetCachedDiscoveryPlaces.mockReturnValue(COMPLETE_PAGE);
    pendingRefetch();
    await renderTab();
    await act(async () => {});
    expect(screen.queryByTestId('for-you-partial-retry')).toBeNull();
    expect(screen.queryByTestId('for-you-partial-empty-retry')).toBeNull();
  });
});

// census-discovery §104 (DV-83, §103.11 survivor CM7): the cache is read with the tab's WHOLE
// query — the sort, the context, the centre, and the position only for the nearest sort — so
// another sort's page is never painted as this one's. Nothing pinned `forYouCacheQuery`.
describe('ForYouTab — the cache read names the whole query (§104, CM7)', () => {
  it('Q1 every cache read carries the tab\'s sort, context and centre; the position only for the nearest sort', async () => {
    pendingRefetch();
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} sortBy="rating" contextMode={'solo' as never} lat={38.7} lng={-9.1} userLat={38.71} userLng={-9.14} />);
    await act(async () => {});
    expect(mockGetCachedDiscoveryPlaces).toHaveBeenCalled();
    for (const call of mockGetCachedDiscoveryPlaces.mock.calls) {
      expect(call.slice(0, 4)).toEqual(['Lisbon', 'for_you', 25, 1]);
      expect(call[5]).toEqual({ sortBy: 'rating', contextMode: 'solo', lat: 38.7, lng: -9.1, userLat: null, userLng: null });
    }
  });

  it('Q2 the nearest sort reads the cache with the position it sends', async () => {
    pendingRefetch();
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} sortBy="nearest" userLat={38.71} userLng={-9.14} />);
    await act(async () => {});
    for (const call of mockGetCachedDiscoveryPlaces.mock.calls) {
      expect(call[5]).toMatchObject({ sortBy: 'nearest', userLat: 38.71, userLng: -9.14 });
    }
  });

  it('Q3 a page cached for ANOTHER sort is not painted as this sort\'s first frame', async () => {
    pendingRefetch();
    mockGetCachedDiscoveryPlaces.mockImplementation((...a: unknown[]) => ((a[5] as { sortBy?: string | null } | undefined)?.sortBy ?? null) === null ? COMPLETE_PAGE : null);
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} sortBy="rating" />);
    await act(async () => {});
    expect(screen.queryByText('Cafe A')).toBeNull();
  });
});
