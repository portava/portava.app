/**
 * ForYouTab — the Compass feed that upgrades the tab is only this city's, and a
 * failed Compass refresh over it is said (census-discovery §101, lane W11-X2
 * round 5; DV-83, the round's adversarial sweep; register D-W11X2-34).
 *
 * With 3455 OFF (production's state) the tab of a signed-in viewer shows
 * `useCompassFeed`'s items in place of the GET /discovery page. §100 made a
 * failed GET /discovery refresh say "couldn't refresh" — and excluded Compass
 * items from that line, so a failed Compass refresh left its last feed on screen
 * as a fresh answer. The hook now returns a feed only for the city it was read
 * for, and its error beside a kept feed; the tab says so.
 *
 *   Y1  a Compass feed kept after its refresh failed: the stale line over the Compass cards
 *   Y2  a city switch whose Compass read fails: the previous city's Compass cards are gone; the new city's page is shown
 *   C1  CONTROL: a healthy Compass feed draws no stale line
 *
 * The harness is ForYouTab.liveSafety.component.test.tsx's.
 *
 * Run with: npx jest src/components/discovery/__tests__/ForYouTab.compassScope.component.test.tsx
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

const PORTO_PAGE = { ok: true, data: { ...PDE_PAGE.data, places: [{ ...PDE_PAGE.data.places[0], id: 'node/2', name: 'Porto First' }], destination: 'Porto' } };
const LISBON_FEED = { data: { sections: [{ name: 'for_you', items: [COMPASS_ITEM] }], safeItems: [] }, compassEnabled: true, error: null, refresh: jest.fn() };

describe('ForYouTab — the Compass feed is this city’s, and its failed refresh is said (DV-83, §101)', () => {
  it('Y1 a Compass feed kept after its refresh failed: the stale line over the Compass cards', async () => {
    mockUseCompassFeed.mockReturnValue({ ...LISBON_FEED, error: 'network_error' });
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} />);
    await screen.findByText('card:Compass Cafe');
    await act(async () => {});
    expect(screen.getByTestId('for-you-stale')).toBeTruthy();
  });

  it('Y2 a city switch whose Compass read fails: the previous city’s Compass cards are gone', async () => {
    mockUseCompassFeed.mockImplementation(({ city }: { city: string }) => (city === 'Lisbon'
      ? LISBON_FEED
      : { data: null, compassEnabled: true, error: 'network_error', refresh: jest.fn() }));
    const r = await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} />);
    await screen.findByText('card:Compass Cafe');
    mockGetDiscoveryPlaces.mockResolvedValue(PORTO_PAGE);
    await act(async () => { r.rerender(<ForYouTab destination="Porto" onAddToPlan={jest.fn()} />); });
    await act(async () => {});
    expect(screen.queryByText('card:Compass Cafe')).toBeNull();
    expect(await screen.findByText('card:Porto First')).toBeTruthy();
  });

  it('C1 CONTROL a healthy Compass feed draws no stale line', async () => {
    mockUseCompassFeed.mockReturnValue(LISBON_FEED);
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} />);
    await screen.findByText('card:Compass Cafe');
    await act(async () => {});
    expect(screen.queryByTestId('for-you-stale')).toBeNull();
  });
});
