/**
 * The two Discovery tabs that call GET /discovery hand the chosen intent mode to
 * the service, and hand exactly what they handed before when none is chosen.
 * census-discovery §71 (lane P31), rows A05 and DV-42.
 *
 *   T1  DiscoveryCategoryTab, no mode: the filters object passed is the SAME
 *       object the screen gave it (no copy, no `intentMode` key), and the cache
 *       is read under the no-mode key.
 *   T2  DiscoveryCategoryTab, mode: `intentMode` is on the filters, every other
 *       filter is unchanged, and the cache is read under that mode.
 *   T3  ForYouTab, no mode: no `intentMode` key reaches the service.
 *   T4  ForYouTab, mode: it does, and the cache is read under that mode.
 *
 * The request those filters produce is pinned byte for byte by
 * services/__tests__/discovery.intentMode.test.ts. The mocks are
 * ForYouTab.refusal's and DiscoveryCategoryTab.noFilters', unchanged.
 *
 * Run: pnpm test:component -- DiscoveryTabs.intentMode
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

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


// ── DiscoveryCategoryTab's own dependencies (as DiscoveryCategoryTab.noFilters) ──

// NOTE: intentionally exhaustive — the real hook fetches from a remote API.
jest.mock('../../../hooks/usePopularCities', () => ({
  usePopularCities: () => ({ places: [], loading: false }),
}));
// NOTE: intentional stub — not under test; pulls native modules + navigation.
jest.mock('../../selectors/GlobalPlacePicker', () => ({
  POPULAR: [],
  GlobalPlacePicker: Null,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { ForYouTab } from '../ForYouTab.tsx';
import { DiscoveryCategoryTab } from '../DiscoveryCategoryTab.tsx';

const FILTERS = { radiusKm: 10, openNow: true, minRating: 4, sortBy: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockCommunityState.current = { gems: [], picks: [], places: [], loading: false, refused: false };
  mockGetCachedDiscoveryPlaces.mockReturnValue(null);
  mockGetSavedPlaceIds.mockResolvedValue({ ok: true, ids: [] });
  mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: { places: [], total: 0, destination: 'Lisbon', cached: false } });
});
afterEach(async () => { await act(async () => {}); });

const filtersSent = () => mockGetDiscoveryPlaces.mock.calls.map((c) => c[2] as Record<string, unknown>);
const cacheModesRead = () => mockGetCachedDiscoveryPlaces.mock.calls.map((c) => c[4]);

describe('DiscoveryCategoryTab', () => {
  const props = { category: 'food' as const, destination: 'Lisbon', onSelectPlace: jest.fn(), onAddToPlan: jest.fn(), filters: FILTERS };

  it('T1 no mode: the screen\'s filters object itself is passed, with no intentMode key', async () => {
    await act(async () => { render(<DiscoveryCategoryTab {...props} />); });
    expect(filtersSent().length).toBeGreaterThan(0);
    for (const f of filtersSent()) {
      expect(f).toBe(FILTERS);
      expect(f).not.toHaveProperty('intentMode');
    }
    expect(cacheModesRead().length).toBeGreaterThan(0);
    for (const m of cacheModesRead()) expect(m ?? null).toBeNull();
  });

  it('T2 mode: intentMode is on the filters, the rest unchanged, and the cache is read under it', async () => {
    await act(async () => { render(<DiscoveryCategoryTab {...props} intentMode="quiet" />); });
    expect(filtersSent().length).toBeGreaterThan(0);
    for (const f of filtersSent()) expect(f).toEqual({ ...FILTERS, intentMode: 'quiet' });
    expect(cacheModesRead().length).toBeGreaterThan(0);
    for (const m of cacheModesRead()) expect(m).toBe('quiet');
  });
});

describe('ForYouTab', () => {
  it('T3 no mode: no intentMode key reaches the service', async () => {
    await act(async () => { render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} />); });
    expect(filtersSent().length).toBeGreaterThan(0);
    for (const f of filtersSent()) expect(f).not.toHaveProperty('intentMode');
    for (const m of cacheModesRead()) expect(m ?? null).toBeNull();
  });

  it('T4 mode: intentMode reaches the service, and the cache is read under it', async () => {
    await act(async () => { render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} intentMode="tonight" />); });
    expect(filtersSent().length).toBeGreaterThan(0);
    for (const f of filtersSent()) expect(f).toEqual({ radiusKm: 25, openNow: false, minRating: null, sortBy: null, intentMode: 'tonight' });
    expect(cacheModesRead().length).toBeGreaterThan(0);
    for (const m of cacheModesRead()) expect(m).toBe('tonight');
  });
});
