/**
 * ForYouTab — pull-to-refresh re-fetches data
 *
 * Confirms that triggering the FlatList's RefreshControl.onRefresh:
 *   1. calls getDiscoveryPlaces again (OSM baseline re-fetch)
 *   2. invokes the onRefresh prop passed by the parent discovery screen
 *   3. clears the refreshing spinner once the re-fetch resolves
 *
 * testID "main-scroll" on the FlatList lets us reach refreshControl via
 * scroll.props.refreshControl.props.onRefresh / .refreshing.
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

// ── Services ──────────────────────────────────────────────────────────────────

const mockGetDiscoveryPlaces       = jest.fn();
const mockGetCachedDiscoveryPlaces = jest.fn();

// NOTE: intentionally exhaustive — the real module imports Supabase; spreading
// requireActual would load the client and OOM the Jest runner.
jest.mock('../../../services/discovery', () => ({
  getDiscoveryPlaces:       (...args: unknown[]) => mockGetDiscoveryPlaces(...args),
  getSavedPlaceIds:         jest.fn().mockResolvedValue([]),
  getCachedDiscoveryPlaces: (...args: unknown[]) => mockGetCachedDiscoveryPlaces(...args),
  // DiscoveryEventPostsRail (serve point 7) calls this; the rail renders nothing
  // on a non-ok result, which keeps this pull-to-refresh test focused on the
  // OSM baseline path.
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
// NOTE: intentional stub — not under test; pulls Supabase + community data.
jest.mock('../../DiscoveryWall', () => ({
  HiddenGemsSection:    Null,
  TravelerPicksSection: Null,
  prefillSavedPlaceIds: jest.fn(),
}));
// NOTE: intentional stub — not under test; pulls reanimated animations.
jest.mock('../PlaceSkeleton', () => ({ PlaceSkeletonList: Null }));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { ForYouTab } from '../ForYouTab.tsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_PLACE = {
  id: 'p1', name: 'Cafe A', category: 'food', type: null, description: null,
  distanceKm: null, lat: null, lng: null, address: null, openingHours: null,
  rating: null, photoUrl: null, visitCount: null, savedCount: null,
};

/** Wait for the FlatList to mount, then return it with refreshControl accessible. */
async function getScroll() {
  return screen.findByTestId('main-scroll');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ForYouTab — pull-to-refresh', () => {
  const onRefreshSpy = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedDiscoveryPlaces.mockReturnValue(null);
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: { places: [MOCK_PLACE] } });
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it('calls getDiscoveryPlaces again and invokes onRefresh prop when RefreshControl fires', async () => {
    await render(
      <ForYouTab
        destination="Lisbon"
        onAddToPlan={jest.fn()}
        onRefresh={onRefreshSpy}
      />,
    );

    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(1));

    const scroll = await getScroll();
    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });

    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(2));
    expect(onRefreshSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the refreshing indicator once the re-fetch resolves', async () => {
    await render(
      <ForYouTab
        destination="Lisbon"
        onAddToPlan={jest.fn()}
        onRefresh={onRefreshSpy}
      />,
    );
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(1));

    const scroll = await getScroll();
    expect(scroll.props.refreshControl.props.refreshing).toBe(false);

    let resolveFetch!: () => void;
    mockGetDiscoveryPlaces.mockReturnValueOnce(
      new Promise<{ ok: boolean; data: { places: typeof MOCK_PLACE[] } }>((res) => {
        resolveFetch = () => res({ ok: true, data: { places: [] } });
      }),
    );

    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });
    expect(screen.getByTestId('main-scroll').props.refreshControl.props.refreshing).toBe(true);

    await act(async () => { resolveFetch(); });
    await waitFor(() => {
      expect(screen.getByTestId('main-scroll').props.refreshControl.props.refreshing).toBe(false);
    });
  });
});
