/**
 * ForYouTab — census-discovery §91 (lane W10-I), A07: the For You page whose
 * "now" claims the server WITHHELD says so, and only over that page.
 *
 *   F1  3455 ON (the tab keeps the GET /discovery page): meta.liveSafety
 *       readable:false shows the notice
 *   F2  3455 OFF: the Compass feed supersedes the page, and the notice — which
 *       describes the page, not the feed — is not shown over the feed
 *   F3  CONTROL: a healthy page shows no notice
 *
 * The harness is ForYouTab.onePipeline.component.test.tsx's.
 *
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
  getSavedPlaceIds:         jest.fn().mockResolvedValue({ ok: true, ids: [] }),
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

// The server capability. Set per test.
const mockFlags: { on: Set<string> } = { on: new Set() };
// NOTE: intentionally exhaustive — the provider fetches GET /api/feature-flags;
// the tab reads only `isEnabled`, and the stand-in answers from the set above.
jest.mock('../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlags.on.has(k), isLivePlacesEnabled: () => false, loading: false }),
}));

// A Compass feed that HAS answered, with one item, so the upgrade effect has
// something to supersede the page with.
const COMPASS_ITEM = { id: 'compass-1', type: 'place', category: 'cafe', title: 'Compass Cafe', data: {} };
const mockUseCompassFeed = jest.fn();
// NOTE: intentionally exhaustive — the real hook opens Compass WebSocket.
jest.mock('../../../hooks/compass/useCompassFeed', () => ({
  useCompassFeed: (...args: unknown[]) => mockUseCompassFeed(...args),
}));

// NOTE: intentionally exhaustive — the real hook fetches community posts.
jest.mock('../../../hooks/useCommunityDiscovery', () => ({
  useCommunityDiscovery: () => ({ gems: [], picks: [], places: [], loading: false, refused: false }),
}));

// ── Heavy child component stubs ───────────────────────────────────────────────

const Null = () => null;

// NOTE: intentional stub — renders the place name so the test can read which
// list is on screen; the real card pulls react-native-maps.
jest.mock('../PlaceCard', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: ({ place }: { place: { name: string } }) => React.createElement(Text, null, `card:${place.name}`) };
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
// NOTE: intentional stub — not under test; pulls Supabase + community data.
jest.mock('../../DiscoveryWall', () => ({
  HiddenGemsSection: Null, TravelerPicksSection: Null, prefillSavedPlaceIds: jest.fn(),
}));
// NOTE: intentional stub — not under test; pulls reanimated animations.
jest.mock('../PlaceSkeleton', () => ({ PlaceSkeletonList: Null }));
// NOTE: intentional stub — Compass's own rail below the list, not under test;
// it reads the same mocked feed hook and posts analytics.
jest.mock('../../compass/CompassPicksSection', () => ({ CompassPicksSection: Null }));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { ForYouTab } from '../ForYouTab.tsx';

const PDE_PAGE = {
  ok: true,
  data: {
    places: [{ id: 'node/1', name: 'Ranked First', category: 'for_you', type: null, description: null, distanceKm: 1, lat: 1, lng: 1, tags: [], address: null, website: null, phone: null, openingHours: null, rating: null, isOpenNow: null }],
    total: 1, destination: 'Lisbon', cached: false,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFlags.on = new Set();
  mockGetCachedDiscoveryPlaces.mockReturnValue(null);
  mockGetDiscoveryPlaces.mockResolvedValue(PDE_PAGE);
  mockUseCompassFeed.mockReturnValue({
    data: { sections: [{ name: 'for_you', items: [COMPASS_ITEM] }], safeItems: [] },
    compassEnabled: true, refresh: jest.fn(),
  });
});

afterEach(async () => { await act(async () => {}); });

const NOTICE = "We couldn't check what's live nearby just now.";
const WITHHELD_PAGE = { ...PDE_PAGE, data: { ...PDE_PAGE.data, meta: { liveSafety: { readable: false, claimsWithheld: 1 } } } };

describe('ForYouTab — meta.liveSafety (census-discovery §91, A07)', () => {
  it('F1. 3455 ON: a page whose Live read failed says the "now" claims were not checked', async () => {
    mockFlags.on = new Set(['discovery_for_you_pde_enabled']);
    mockGetDiscoveryPlaces.mockResolvedValue(WITHHELD_PAGE);
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} />);
    await screen.findByText('card:Ranked First');
    expect(await screen.findByText(NOTICE)).toBeTruthy();
  });

  it('F2. 3455 OFF: once the Compass feed supersedes the page, the notice is not shown over it', async () => {
    mockGetDiscoveryPlaces.mockResolvedValue(WITHHELD_PAGE);
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} />);
    await screen.findByText('card:Compass Cafe');
    await act(async () => {});
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('F3. CONTROL: a healthy page shows no notice', async () => {
    mockFlags.on = new Set(['discovery_for_you_pde_enabled']);
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} />);
    await screen.findByText('card:Ranked First');
    await act(async () => {});
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
