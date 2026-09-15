/**
 * ForYouTab — the screen RECOGNISES a refusal.
 *
 * OWNER RULING, 2026-09-14, verbatim. The last sentence is what this file is:
 *
 *   "Add upstream_unavailable for upstream dependency failures. Do not cache
 *    rate limits or outages as 'this location does not exist.' Verify that
 *    clients recognize refusal responses, preserve existing bookmarks on read
 *    failures, and exclude failed responses from exposure accounting. A
 *    distinguishable response body alone is insufficient if consumers still
 *    treat it as successful empty data."
 *
 * ForYouTab is the reachable surface for two of the three client properties,
 * and it is reachable from the Explore tab: app/(tabs)/discovery.tsx renders it
 * for the "For you" category. Everything below is asserted through the rendered
 * tree, not through a return value, because "consumers still treat it as
 * successful empty data" is a claim about what a person sees.
 *
 *   (1) BOOKMARKS SURVIVE A READ FAILURE.  ForYouTab.tsx:144 fired
 *       `getSavedPlaceIds().then(prefillSavedPlaceIds)`. When the server refused
 *       the saved-ids read, the old service returned `[]` and this line seeded
 *       the bookmark state from it — so a failed read presented as "you have
 *       saved nothing". This is the most user-visible item in the lane, and the
 *       hardest to notice, because nothing on screen looks broken.
 *
 *   (2) A REFUSED LIST IS NOT AN EMPTY STATE.  A refused GET /discovery put
 *       `source: 'none'` on screen — the same "No recommendations yet" a city
 *       with genuinely nothing in it gets.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

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

const SAVED_IDS_REFUSAL = {
  class: 'transient_db', code: 'saved_ids_read_failed',
  route: 'GET /discovery/community/saved-ids', coverage: 'nothing' as const,
};

const PLACES_REFUSAL = {
  class: 'upstream_unavailable', code: 'nominatim_http_429',
  route: 'GET /discovery', coverage: 'nothing' as const,
};

/** RNTL v14's `render` is async in this project — every call site awaits it. */
async function renderTab() {
  return render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} />);
}

/** A community place in the shape HiddenGemsSection/TravelerPicksSection take. */
const COMMUNITY_GEM = { id: 'gem-1', name: 'Rooftop in Alfama', category: 'bar' };

beforeEach(() => {
  jest.clearAllMocks();
  mockCommunityState.current = { gems: [], picks: [], places: [], loading: false, refused: false };
  mockGetCachedDiscoveryPlaces.mockReturnValue(null);
  mockGetDiscoveryPlaces.mockResolvedValue({
    ok: true, data: { places: [], total: 0, destination: 'Lisbon', cached: false },
  });
  mockGetSavedPlaceIds.mockResolvedValue({ ok: true, ids: [] });
});

afterEach(async () => { await act(async () => {}); });

// ─────────────────────────────────────────────────────────────────────────────
// (1) BOOKMARKS SURVIVE A READ FAILURE
// ─────────────────────────────────────────────────────────────────────────────

describe('ForYouTab — saved-ids refusal must not erase bookmarks', () => {
  it('does NOT seed the bookmark state from a refused saved-ids read', async () => {
    // The whole defect in one line. The server said "I could not read your save
    // set". The old client turned that into `[]` and handed it to the function
    // that decides which bookmarks are filled. Nothing may be written from a
    // refusal — the last-known state, whatever it is, must be left alone.
    mockGetSavedPlaceIds.mockResolvedValue({
      ok: false, reason: 'refused', refusal: SAVED_IDS_REFUSAL,
    });
    await renderTab();
    await waitFor(() => expect(mockGetSavedPlaceIds).toHaveBeenCalled());
    await act(async () => {});
    expect(mockPrefillSavedPlaceIds).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: a successful read DOES seed the bookmark state, exactly once', async () => {
    // Without this the assertion above would also pass if ForYouTab had simply
    // stopped calling prefillSavedPlaceIds at all — which would break every
    // returning user's bookmarks permanently instead of only during an outage.
    mockGetSavedPlaceIds.mockResolvedValue({ ok: true, ids: ['gem-1', 'gem-2'] });
    await renderTab();
    await waitFor(() => expect(mockPrefillSavedPlaceIds).toHaveBeenCalledTimes(1));
    expect(mockPrefillSavedPlaceIds).toHaveBeenCalledWith(['gem-1', 'gem-2']);
  });

  it('a refusal AFTER a successful read leaves the earlier ids as the last word', async () => {
    // The sequence a real user hits: the app read the save set on launch, then
    // re-read it (a re-auth, a remount) while the server was unhealthy. The
    // second read must add nothing and unwrite nothing, so the bookmarks from
    // the first read are still the state the cards see.
    mockGetSavedPlaceIds.mockResolvedValue({ ok: true, ids: ['gem-1'] });
    const first = await renderTab();
    await waitFor(() => expect(mockPrefillSavedPlaceIds).toHaveBeenCalledTimes(1));
    await act(async () => { first.unmount(); });

    mockGetSavedPlaceIds.mockResolvedValue({
      ok: false, reason: 'refused', refusal: SAVED_IDS_REFUSAL,
    });
    await renderTab();
    await waitFor(() => expect(mockGetSavedPlaceIds).toHaveBeenCalledTimes(2));
    await act(async () => {});

    expect(mockPrefillSavedPlaceIds).toHaveBeenCalledTimes(1);
    expect(mockPrefillSavedPlaceIds).toHaveBeenLastCalledWith(['gem-1']);
    expect(mockPrefillSavedPlaceIds).not.toHaveBeenCalledWith([]);
  });

  it('tells the user their saved places could not be checked, in plain words', async () => {
    // Silence is what made this invisible. The notice is deliberately small and
    // unalarming: nothing was lost, one read failed.
    mockGetSavedPlaceIds.mockResolvedValue({
      ok: false, reason: 'refused', refusal: SAVED_IDS_REFUSAL,
    });
    await renderTab();
    const notice = await screen.findByTestId('for-you-saved-unavailable');
    expect(notice).toBeTruthy();
    expect(screen.getByText(/couldn't check your saved places/i)).toBeTruthy();
  });

  it('shows NO such notice when the read succeeded — the control', async () => {
    mockGetSavedPlaceIds.mockResolvedValue({ ok: true, ids: ['gem-1'] });
    await renderTab();
    await waitFor(() => expect(mockPrefillSavedPlaceIds).toHaveBeenCalled());
    expect(screen.queryByTestId('for-you-saved-unavailable')).toBeNull();
  });

  it('shows NO such notice when signed out — not being signed in is not a failure', async () => {
    mockGetSavedPlaceIds.mockResolvedValue({ ok: false, reason: 'signed_out' });
    await renderTab();
    await waitFor(() => expect(mockGetSavedPlaceIds).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('for-you-saved-unavailable')).toBeNull();
    expect(mockPrefillSavedPlaceIds).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) A REFUSED LIST IS NOT AN EMPTY STATE
// ─────────────────────────────────────────────────────────────────────────────

describe('ForYouTab — a refused place list is distinguishable on screen', () => {
  it('does NOT render the "No recommendations yet" empty state for a refusal', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true,
      data: { places: [], total: 0, destination: 'Lisbon', cached: false, refusal: PLACES_REFUSAL },
    });
    await renderTab();
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText('No recommendations yet')).toBeNull();
  });

  it('renders a distinguishable, plainly-worded notice instead', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true,
      data: { places: [], total: 0, destination: 'Lisbon', cached: false, refusal: PLACES_REFUSAL },
    });
    await renderTab();
    const notice = await screen.findByTestId('for-you-refused');
    expect(notice).toBeTruthy();
    expect(screen.getByText(/couldn't load places for Lisbon/i)).toBeTruthy();
    // Non-alarming: no "error", no "failed", no exclamation.
    expect(screen.queryByText(/error|failed|!/i)).toBeNull();
  });

  it('POSITIVE CONTROL: a genuinely empty city still gets the ordinary empty state', async () => {
    // This is what stops the fix from being "replace one blanket message with
    // another". The two answers must remain two answers.
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true, data: { places: [], total: 0, destination: 'Lisbon', cached: false },
    });
    await renderTab();
    expect(await screen.findByText('No recommendations yet')).toBeTruthy();
    expect(screen.queryByTestId('for-you-refused')).toBeNull();
  });

  it('a PARTIAL refusal that returned places renders the places, not the notice', async () => {
    // coverage "partial" means some of this is real and was served. Hiding it
    // behind a failure notice would discard a genuine result.
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true,
      data: {
        places: [{ id: 'p1', name: 'Cafe A', category: 'food', type: null, description: null,
          distanceKm: null, lat: null, lng: null, tags: [], address: null, website: null,
          phone: null, openingHours: null, rating: null, isOpenNow: null }],
        total: 1, destination: 'Lisbon', cached: false,
        refusal: { ...PLACES_REFUSAL, coverage: 'partial' as const, failedSources: ['food'] },
      },
    });
    await renderTab();
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('for-you-refused')).toBeNull();
    expect(screen.queryByText('No recommendations yet')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) A REFUSED COMMUNITY LANE IS NOT A CITY WITHOUT COMMUNITY CONTENT
//
// `useCommunityDiscovery` already does the hard half: it reads
// `result.data.refusal?.coverage === 'nothing'` and exposes `refused`
// (useCommunityDiscovery.ts). Until now that flag had NO readers — ForYouTab
// rendered the gems and picks sections on `length > 0` alone, so a refused read
// and a city with no traveler submissions produced the same screen: nothing.
//
// That is the owner ruling's "consumers still treat it as successful empty
// data" in its purest form — the distinguishable value exists, in this very
// component's props, and is thrown away.
//
// The state rendered below is the one property (2) already established for the
// OSM lane; this lane gets the same treatment, not a new invention.
// ─────────────────────────────────────────────────────────────────────────────

describe('ForYouTab — a refused community lane is distinguishable on screen', () => {
  it('renders a distinguishable notice when the community lane refused', async () => {
    mockCommunityState.current = {
      gems: [], picks: [], places: [], loading: false, refused: true,
    };
    await renderTab();
    expect(await screen.findByTestId('for-you-community-refused')).toBeTruthy();
  });

  it('words it plainly, and does not claim the city has no community places', async () => {
    mockCommunityState.current = {
      gems: [], picks: [], places: [], loading: false, refused: true,
    };
    await renderTab();
    await screen.findByTestId('for-you-community-refused');
    expect(screen.getByText(/couldn't load traveler places for Lisbon/i)).toBeTruthy();
    // Same register as the OSM refused state: no "error", no "failed".
    expect(screen.queryByText(/error|failed|!/i)).toBeNull();
  });

  it('CONTROL: a city with genuinely no community content shows NO notice', async () => {
    // The two answers must remain two answers. `refused: false` with empty
    // arrays is a real read that found nothing, and this lane has always been
    // silent about that — silence stays correct here.
    mockCommunityState.current = {
      gems: [], picks: [], places: [], loading: false, refused: false,
    };
    await renderTab();
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('for-you-community-refused')).toBeNull();
  });

  it('CONTROL: a lane that DID answer still renders its sections, and no notice', async () => {
    // Without this, "render a notice when refused" would also be satisfied by a
    // component that stopped rendering community content altogether.
    mockCommunityState.current = {
      gems: [COMMUNITY_GEM], picks: [COMMUNITY_GEM], places: [], loading: false, refused: false,
    };
    await renderTab();
    expect(await screen.findByTestId('hidden-gems-section')).toBeTruthy();
    expect(screen.getByTestId('traveler-picks-section')).toBeTruthy();
    expect(screen.queryByTestId('for-you-community-refused')).toBeNull();
  });

  it('a refusal that still carried gems renders the gems, not the notice', async () => {
    // `partial` never sets `refused` (the hook only sets it for coverage
    // "nothing"), so a lane holding real rows must show them. This pins the
    // asymmetry so a later "show the notice whenever anything went wrong"
    // rewrite cannot quietly bury real content.
    mockCommunityState.current = {
      gems: [COMMUNITY_GEM], picks: [], places: [], loading: false, refused: false,
    };
    await renderTab();
    expect(await screen.findByTestId('hidden-gems-section')).toBeTruthy();
    expect(screen.queryByTestId('for-you-community-refused')).toBeNull();
  });
});
