/**
 * ForYouTab — census-discovery §79 (C32 / A05), migration 3455.
 *
 * With `discovery_for_you_pde_enabled` ON, GET /discovery's for_you page is the
 * one-pipeline page: Compass's gates chose its candidates, the PDE pipeline
 * ordered them, and the intent mode the user chose reached that order. The tab
 * used to REPLACE that page with the Compass feed whenever Compass answered — a
 * second ordering that carries no mode (§71.6 Q71-2). So:
 *
 *   O1  flag ON: the Compass feed does not supersede the page, and the feed is
 *       not even requested (enabled: false).
 *   O1b flag ON: a Compass feed that arrives after the page does not supersede
 *       it either (O1c is its flag-off control).
 *   O2  flag ON: the intentMode the screen hands the tab is on the request.
 *   O3  CONTROL, flag OFF: the Compass feed supersedes the page, exactly as
 *       before — so O1 is the flag, not a broken upgrade effect.
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

describe('ForYouTab — one ranking pipeline (3455)', () => {
  it('O1. flag ON: the Compass feed does not supersede the one-pipeline page, and is not requested', async () => {
    mockFlags.on = new Set(['discovery_for_you_pde_enabled']);
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} intentMode="quiet" />);
    await screen.findByText('card:Ranked First');
    await act(async () => {});
    expect(screen.queryByText('card:Compass Cafe')).toBeNull();
    expect(mockUseCompassFeed).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(screen.getByText('Picked for you')).toBeTruthy();
  });

  it('O1b. flag ON: a Compass feed that arrives AFTER the page (a cached feed, or a late answer) still does not supersede it', async () => {
    mockFlags.on = new Set(['discovery_for_you_pde_enabled']);
    const feed = { data: null as unknown, compassEnabled: false, refresh: jest.fn() };
    mockUseCompassFeed.mockImplementation(() => feed);
    const view = await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} intentMode="quiet" />);
    await screen.findByText('card:Ranked First');
    feed.data = { sections: [{ name: 'for_you', items: [COMPASS_ITEM] }], safeItems: [] };
    feed.compassEnabled = true;
    await view.rerender(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} intentMode="quiet" />);
    await act(async () => {});
    expect(screen.queryByText('card:Compass Cafe')).toBeNull();
    expect(screen.getByText('card:Ranked First')).toBeTruthy();
  });

  it('O1c. CONTROL, flag OFF: the same late Compass feed DOES supersede the page (so O1b is the flag)', async () => {
    const feed = { data: null as unknown, compassEnabled: false, refresh: jest.fn() };
    mockUseCompassFeed.mockImplementation(() => feed);
    const view = await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} intentMode="quiet" />);
    await screen.findByText('card:Ranked First');
    feed.data = { sections: [{ name: 'for_you', items: [COMPASS_ITEM] }], safeItems: [] };
    feed.compassEnabled = true;
    await view.rerender(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} intentMode="quiet" />);
    await screen.findByText('card:Compass Cafe');
  });

  it('O2. flag ON: the chosen intent mode is on the GET /discovery request the list shows', async () => {
    mockFlags.on = new Set(['discovery_for_you_pde_enabled']);
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} intentMode="quiet" />);
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalled());
    const [dest, category, filters] = mockGetDiscoveryPlaces.mock.calls[0]!;
    expect([dest, category]).toEqual(['Lisbon', 'for_you']);
    expect(filters).toEqual(expect.objectContaining({ intentMode: 'quiet' }));
  });

  it('O3. CONTROL, flag OFF: the Compass feed supersedes the page, exactly as before', async () => {
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} intentMode="quiet" />);
    await screen.findByText('card:Compass Cafe');
    await act(async () => {});
    expect(screen.queryByText('card:Ranked First')).toBeNull();
    expect(mockUseCompassFeed).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });
});
