/**
 * DiscoveryHub screen — crash-resilience component tests (task: Discovery
 * crash on open).
 *
 * Covered:
 *  (a) Renders with complete data (trending strip + default ForYouTab all
 *      resolve).
 *  (b) Renders when all optional sections return empty.
 *  (c) Renders when location is unavailable/denied — the shell + For You tab
 *      still render (generalized, non-location-gated content) instead of
 *      crashing.
 *  (d) Renders when one section throws — that section shows an inline
 *      error fallback while the rest of the screen stays up.
 *
 * NOTE (standalone fork divergence): this app/(tabs)/discovery.tsx is a
 * tab-based hub. It does NOT render CompassBuddyRow or an "available buddies"
 * strip, and there is no "choose a city" nudge label — those are mobile-tree
 * features. The tests below assert the standalone tree's ACTUAL behavior:
 * a trending-hashtag strip (getTrendingHashtags → chip showing the slug) plus
 * the default For You tab, wrapped in real SectionErrorBoundary isolation
 * (labels "DiscoveryHub" / "ForYouTab" / "DiscoveryCategoryTab-<key>").
 *
 * Heavy child sections (ForYouTab, DiscoveryCategoryTab) are stubbed so the
 * tests exercise the screen shell, its data-fetch effects, and the real
 * SectionErrorBoundary isolation.
 */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

// ── Controls shared with mock factories (must be `mock`-prefixed) ─────────────

const mockFlags = { throwForYouTab: false };

const mockLocation = {
  locationState: {
    place: { city: 'Lisbon', country: 'Portugal' },
    coords: { lat: 38.7223, lng: -9.1393 },
    permissionStatus: 'granted' as 'granted' | 'denied' | 'undetermined',
  } as {
    place: { city: string | null; country: string | null };
    coords: { lat: number; lng: number } | null;
    permissionStatus: 'granted' | 'denied' | 'undetermined';
  },
  showCityPicker: false,
  openCityPicker: jest.fn(),
  closeCityPicker: jest.fn(),
  setManualCity: jest.fn().mockResolvedValue(undefined),
  requestLocation: jest.fn(),
  isLoading: false,
};

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../services/hashtag', () => ({
  ...jest.requireActual('../../../services/hashtag'),
  getTrendingHashtags: jest.fn(),
}));

jest.mock('../../../services/discovery', () => ({
  ...jest.requireActual('../../../services/discovery'),
  getDiscoveryCategoryCounts: jest.fn().mockResolvedValue({}),
  getDiscoveryCategoryCountsBatch: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../../services/trips', () => ({
  ...jest.requireActual('../../../services/trips'),
  listMyTrips: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../../services/rentABuddy', () => ({
  ...jest.requireActual('../../../services/rentABuddy'),
  getAvailableNow: jest.fn(),
}));

// NOTE: intentionally exhaustive — the real hook depends on reanimated
// internals that are not safe under jest.
jest.mock('../../../hooks/useNavBarCollapse', () => ({
  NAV_BAR_FILLER_HEIGHT: 0,
  useNavBarScrollHandler: () => undefined,
}));

// NOTE: intentionally exhaustive — stubbed provider hook; the real module
// pulls the full plan-picker UI tree.
jest.mock('../../PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn() }),
}));

jest.mock('../../../context/SessionContext', () => ({
  ...jest.requireActual('../../../context/SessionContext'),
  useSession: () => ({ isAuthed: true, userId: 'user-1' }),
}));

// NOTE: intentionally exhaustive — LocationContext pulls in useActiveLocation
// which imports expo-location native modules unavailable in the jest-expo JSDOM
// runner; spreading requireActual would crash the suite.  Each test drives
// location state through the mockLocation variable instead.
jest.mock('../../../context/LocationContext', () => ({
  useLocationContext: () => ({
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
    ...mockLocation,
    // resolvedLocation — required by discovery.tsx after location unification.
    // Computed at call time so beforeEach mutations to mockLocation.locationState
    // are reflected in the next render.
    resolvedLocation: {
      place:  mockLocation.locationState.place ?? { city: null, country: null },
      coords: mockLocation.locationState.coords ?? null,
      source: 'home',
      freshness: 'unavailable',
    },
  }),
}));

// NOTE: intentionally exhaustive — stubbed highlights hook.
jest.mock('../../../hooks/useFollowingHighlights', () => ({
  useFollowingHighlights: () => ({
    users: [],
    loading: false,
    refresh: jest.fn(),
    sessionViewedIds: new Set<string>(),
    markSessionViewed: jest.fn(),
  }),
}));

// ── Heavy child-section stubs ─────────────────────────────────────────────────
// NOTE: intentionally exhaustive — each stub replaces a component whose real
// implementation pulls maps/reanimated/etc. that are not safe under jest.

jest.mock('../ForYouTab', () => {
  const RN = jest.requireActual('react-native');
  return {
    ForYouTab: () => {
      if (mockFlags.throwForYouTab) throw new Error('for-you tab boom');
      return <RN.Text testID="stub-for-you">ForYouTab</RN.Text>;
    },
  };
});

// NOTE: intentionally exhaustive — DiscoveryCategoryTab's real module also
// exports FilterStrip + SORT_LABELS, both imported by discovery.tsx; omitting
// them crashes the filters panel into SectionErrorBoundary.
jest.mock('../DiscoveryCategoryTab', () => {
  const RN = jest.requireActual('react-native');
  const Stub = () => <RN.Text testID="stub-category-tab">DiscoveryCategoryTab</RN.Text>;
  return {
    DiscoveryCategoryTab: Stub,
    default: Stub,
    FilterStrip: () => null,
    SORT_LABELS: {},
  };
});

// NOTE: intentionally exhaustive — null stub; the real component pulls
// native-module internals that are not safe under jest.
jest.mock('../DestinationBar', () => ({
  DestinationBar: () => null,
}));

// NOTE: intentionally exhaustive — null stub; the real component pulls
// native-module internals that are not safe under jest.
jest.mock('../PlaceDetailSheet', () => ({
  PlaceDetailSheet: () => null,
}));

// NOTE: intentionally exhaustive — null stub; the real component pulls
// native-module internals that are not safe under jest.
jest.mock('../SubmitPlaceSheet', () => ({
  SubmitPlaceSheet: () => null,
}));

// NOTE: intentionally exhaustive — null stub; the real component pulls
// native-module internals that are not safe under jest.
jest.mock('../../layover/LayoverModeSheet', () => ({
  LayoverModeSheet: () => null,
}));

// NOTE: intentionally exhaustive — null stub; the real component pulls
// native-module internals that are not safe under jest.
jest.mock('../../ManualCityPicker', () => ({
  ManualCityPicker: () => null,
}));

// NOTE: intentionally exhaustive — null stub; the real component pulls
// native-module internals that are not safe under jest.
jest.mock('../../FollowingHighlightsStrip', () => ({
  FollowingHighlightsStrip: () => null,
}));

// NOTE: intentionally exhaustive — null stub; the real component pulls
// native-module internals that are not safe under jest.
jest.mock('../../RouteBuilderSheet', () => ({
  RouteBuilderSheet: () => null,
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import DiscoveryHub from '../../../../app/(tabs)/discovery.tsx';
import { getTrendingHashtags } from '../../../services/hashtag.ts';
import { getAvailableNow } from '../../../services/rentABuddy.ts';

const mockTrending = getTrendingHashtags as jest.Mock;
const mockAvailableNow = getAvailableNow as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

function setLocationAvailable() {
  mockLocation.locationState = {
    place: { city: 'Lisbon', country: 'Portugal' },
    coords: { lat: 38.7223, lng: -9.1393 },
    permissionStatus: 'granted',
  };
  mockLocation.isLoading = false;
}

function setLocationDenied() {
  mockLocation.locationState = {
    place: { city: null, country: null },
    coords: null,
    permissionStatus: 'denied',
  };
  mockLocation.isLoading = false;
}

afterEach(async () => {
  // Drain any concurrent work scheduled outside act() before RNTL cleanup.
  await act(async () => {});
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFlags.throwForYouTab = false;
  setLocationAvailable();
  mockTrending.mockResolvedValue({
    ok: true,
    data: { trending: [{ id: 'h1', slug: 'lisbon', usageCount: 42 }] },
  });
  mockAvailableNow.mockResolvedValue({
    ok: true,
    data: { buddies: [{ id: 'b1', displayName: 'Ana', categories: ['food'] }] },
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DiscoveryHub crash resilience', () => {
  it('(a) renders with complete data', async () => {
    await render(<DiscoveryHub />);

    expect(screen.getByText('Discover')).toBeTruthy();
    // Default active tab is For You (initialCategory defaults to 'for_you').
    expect(screen.getByTestId('stub-for-you')).toBeTruthy();

    // The trending-hashtag strip hydrates from getTrendingHashtags without
    // throwing — the chip renders the slug.
    await waitFor(() => {
      expect(screen.getByText('lisbon')).toBeTruthy();       // trending chip
    });
  });

  it('(b) renders when all optional sections return empty', async () => {
    mockTrending.mockResolvedValue({ ok: true, data: { trending: [] } });

    await render(<DiscoveryHub />);

    expect(screen.getByText('Discover')).toBeTruthy();
    expect(screen.getByTestId('stub-for-you')).toBeTruthy();

    await waitFor(() => {
      expect(screen.queryByText('lisbon')).toBeNull();
    });
  });

  it('(b2) renders when an optional payload is malformed (missing arrays)', async () => {
    mockTrending.mockResolvedValue({ ok: true, data: {} });      // no trending field

    await render(<DiscoveryHub />);

    expect(screen.getByText('Discover')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText('lisbon')).toBeNull();
    });
  });

  it('(c) renders when location is denied — shell + For You tab still render, no crash', async () => {
    setLocationDenied();
    mockTrending.mockResolvedValue({ ok: true, data: { trending: [] } });

    await render(<DiscoveryHub />);

    expect(screen.getByText('Discover')).toBeTruthy();
    // For You tab still renders — generalized (non-location-gated) content.
    // NOTE: the standalone hub has no "choose a city" nudge label (mobile-only);
    // the resilience contract here is that a denied location does not crash the
    // screen and the default tab still mounts.
    expect(screen.getByTestId('stub-for-you')).toBeTruthy();

    await waitFor(() => {
      expect(mockTrending).toHaveBeenCalled();
    });
  });

  it("(d) one section throwing shows that section's inline error, rest still renders", async () => {
    mockFlags.throwForYouTab = true;
    // Silence React's expected error-boundary noise for this test only.
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await render(<DiscoveryHub />);

    // The crashed section (For You tab) shows its isolated fallback…
    expect(screen.getByTestId('section-error-ForYouTab')).toBeTruthy();
    expect(screen.getByText("Couldn't load this section")).toBeTruthy();
    // …while the rest of the screen shell still renders.
    expect(screen.getByText('Discover')).toBeTruthy();
    // And the real error was logged for developers.
    expect(
      consoleErrorSpy.mock.calls.some((args) =>
        String(args[0]).includes('section "ForYouTab" crashed'),
      ),
    ).toBe(true);

    await waitFor(() => {
      expect(mockTrending).toHaveBeenCalled();
    });
    consoleErrorSpy.mockRestore();
  });
});
