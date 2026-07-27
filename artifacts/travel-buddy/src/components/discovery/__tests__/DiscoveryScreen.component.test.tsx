/**
 * DiscoveryHub screen — crash-resilience component tests (task: Discovery
 * crash on open).
 *
 * Covered:
 *  (a) Renders with complete data (trending, buddies, sections all resolve).
 *  (b) Renders when all optional sections return empty.
 *  (c) Renders when location is unavailable/denied — shows the "choose a
 *      city" nudge and generalized (non-location-gated) content instead of
 *      crashing.
 *  (d) Renders when one section throws — that section shows an inline
 *      error fallback while the rest of the screen stays up.
 *
 * Heavy child sections (ForYouTab, DiscoveryCategoryTab, CompassBuddyRow, …)
 * are stubbed so the tests exercise the screen shell, its data-fetch effects,
 * and the real SectionErrorBoundary isolation.
 */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

// ── Controls shared with mock factories (must be `mock`-prefixed) ─────────────

const mockFlags = { throwCompassRow: false };

const mockLocation = {
  locationState: {
    place: { city: 'Lisbon', country: 'Portugal' },
    coords: { lat: 38.7223, lng: -9.1393 },
  } as { place: { city: string | null; country: string | null }; coords: { lat: number; lng: number } | null },
  showCityPicker: false,
  openCityPicker: jest.fn(),
  closeCityPicker: jest.fn(),
  setManualCity: jest.fn().mockResolvedValue(undefined),
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

// NOTE: the real tabs render the screen's shared header (title "Discovery",
// trending/buddy/CompassPicks sections) via the `listHeaderComponent` prop —
// discovery.tsx moved the header stack inside each tab's FlatList.  The stub
// MUST render that prop, otherwise the screen shell (and the assertions that
// query it) never appears.
jest.mock('../ForYouTab', () => {
  const RN = jest.requireActual('react-native');
  return {
    ForYouTab: ({ listHeaderComponent }: { listHeaderComponent?: React.ReactNode }) => (
      <RN.View>
        <RN.Text testID="stub-for-you">ForYouTab</RN.Text>
        {listHeaderComponent}
      </RN.View>
    ),
  };
});

jest.mock('../DiscoveryCategoryTab', () => {
  const RN = jest.requireActual('react-native');
  const Stub = ({ listHeaderComponent }: { listHeaderComponent?: React.ReactNode }) => (
    <RN.View>
      <RN.Text testID="stub-category-tab">DiscoveryCategoryTab</RN.Text>
      {listHeaderComponent}
    </RN.View>
  );
  return { DiscoveryCategoryTab: Stub, default: Stub };
});

jest.mock('../../compass/CompassBuddyRow', () => {
  const RN = jest.requireActual('react-native');
  return {
    CompassBuddyRow: () => {
      if (mockFlags.throwCompassRow) throw new Error('compass row boom');
      return <RN.Text testID="stub-compass-row">CompassBuddyRow</RN.Text>;
    },
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
  };
  mockLocation.isLoading = false;
}

function setLocationDenied() {
  mockLocation.locationState = {
    place: { city: null, country: null },
    coords: null,
  };
  mockLocation.isLoading = false;
}

afterEach(async () => {
  // Drain any concurrent work scheduled outside act() before RNTL cleanup.
  await act(async () => {});
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFlags.throwCompassRow = false;
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

    // The screen renders "Discovery" in both the large scrolling header and the
    // compact sticky bar overlay; getAllByText handles both occurrences.
    expect(screen.getAllByText('Discovery').length).toBeGreaterThan(0);
    expect(screen.getByTestId('stub-for-you')).toBeTruthy();
    expect(screen.getByTestId('stub-compass-row')).toBeTruthy();

    // Optional sections hydrate from their queries without throwing.
    await waitFor(() => {
      expect(screen.getByText('lisbon')).toBeTruthy();       // trending chip
      expect(screen.getByText('Ana')).toBeTruthy();           // buddy strip
    });
  });

  it('(b) renders when all optional sections return empty', async () => {
    mockTrending.mockResolvedValue({ ok: true, data: { trending: [] } });
    mockAvailableNow.mockResolvedValue({ ok: true, data: { buddies: [] } });

    await render(<DiscoveryHub />);

    expect(screen.getAllByText('Discovery').length).toBeGreaterThan(0);
    expect(screen.getByTestId('stub-for-you')).toBeTruthy();

    await waitFor(() => {
      expect(screen.queryByText('lisbon')).toBeNull();
      expect(screen.queryByText('Ana')).toBeNull();
    });
  });

  it('(b2) renders when an optional payload is malformed (missing arrays)', async () => {
    mockTrending.mockResolvedValue({ ok: true, data: {} });      // no trending field
    mockAvailableNow.mockResolvedValue({ ok: true, data: {} });  // no buddies field

    await render(<DiscoveryHub />);

    expect(screen.getAllByText('Discovery').length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.queryByText('lisbon')).toBeNull();
    });
  });

  it('(c) renders when location is denied — shows the choose-a-city nudge, no crash', async () => {
    setLocationDenied();
    mockTrending.mockResolvedValue({ ok: true, data: { trending: [] } });

    await render(<DiscoveryHub />);

    expect(screen.getAllByText('Discovery').length).toBeGreaterThan(0);
    // Location nudge (generalized, non-location-gated path) is offered.
    expect(screen.getByLabelText('Set your location to discover nearby places')).toBeTruthy();
    // For You tab still renders (its stub stands in for generalized picks).
    expect(screen.getByTestId('stub-for-you')).toBeTruthy();

    await waitFor(() => {
      expect(mockTrending).toHaveBeenCalled();
    });
  });

  it("(d) one section throwing shows that section's inline error, rest still renders", async () => {
    mockFlags.throwCompassRow = true;
    // Silence React's expected error-boundary noise for this test only.
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await render(<DiscoveryHub />);

    // The crashed section shows its isolated fallback…
    expect(screen.getByTestId('section-error-CompassPicks')).toBeTruthy();
    expect(screen.getByText("Couldn't load this section")).toBeTruthy();
    // …while the rest of the screen still renders.
    expect(screen.getAllByText('Discovery').length).toBeGreaterThan(0);
    expect(screen.getByTestId('stub-for-you')).toBeTruthy();
    // And the real error was logged for developers.
    expect(
      consoleErrorSpy.mock.calls.some((args) =>
        String(args[0]).includes('section "CompassPicks" crashed'),
      ),
    ).toBe(true);

    await waitFor(() => {
      expect(mockTrending).toHaveBeenCalled();
    });
    consoleErrorSpy.mockRestore();
  });
});
