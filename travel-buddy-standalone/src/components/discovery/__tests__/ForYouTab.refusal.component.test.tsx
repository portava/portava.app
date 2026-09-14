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
jest.mock('../../../hooks/useCommunityDiscovery', () => ({
  useCommunityDiscovery: () => ({ gems: [], picks: [], places: [], loading: false }),
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
jest.mock('../../DiscoveryWall', () => ({
  HiddenGemsSection:    Null,
  TravelerPicksSection: Null,
  prefillSavedPlaceIds: (...args: unknown[]) => mockPrefillSavedPlaceIds(...args),
}));
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

beforeEach(() => {
  jest.clearAllMocks();
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
