/**
 * ForYouTab — the map view starts its controls below Discover's floating tab row.
 *
 * DiscoveryCategoryTab already handed DiscoveryMapView the measured `listTopInset` as `topInset`; the For You map did
 * not, so its filter row, legend and travelers buttons (top 14 / 58 / 102) rendered UNDER the tab row floating over
 * the map (owner's iPhone, 2026-10-22). The list branch has always used the inset; the map branch now does too.
 *
 * Mocks and data are those of ForYouTab.onePipeline.component.test.tsx; DiscoveryMapView is a stub that records props.
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

const mockMapProps: Array<Record<string, unknown>> = [];
// NOTE: intentionally exhaustive — the real map mounts MapLibre (native); the stub records the props it is handed.
jest.mock('../DiscoveryMapView', () => ({
  DiscoveryMapView: (props: Record<string, unknown>) => { mockMapProps.push(props); return null; },
}));

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

describe('ForYouTab — map view top inset', () => {
  it('hands DiscoveryMapView the same top inset the list is padded by', async () => {
    mockMapProps.length = 0;
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} viewMode="map" listTopInset={120} />);
    await waitFor(() => expect(mockMapProps.length).toBeGreaterThan(0));
    expect(mockMapProps.at(-1)?.topInset).toBe(120);
  });

  it('with no inset given, the map keeps its own default (0)', async () => {
    mockMapProps.length = 0;
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} viewMode="map" />);
    await waitFor(() => expect(mockMapProps.length).toBeGreaterThan(0));
    expect(mockMapProps.at(-1)?.topInset).toBe(0);
  });
});
