/**
 * Discovery screen → intent mode → the tab that fetches. census-discovery §71
 * (lane P31), rows A05 and DV-42.
 *
 * The selector's own behaviour is DiscoveryIntentModeSelector.component.test;
 * the request it produces is services/__tests__/discovery.intentMode.test. This
 * file pins the wire between them: the mode the user chooses on the SCREEN is
 * what the tab that calls GET /discovery is handed, and nothing is handed when
 * nothing is chosen or the server has not reported the capability.
 *
 *   W1  capability unknown / 2850 FALSE: no selector, and both tabs get no mode.
 *   W2  2850 TRUE: the selector is in the filter panel; choosing Quiet reaches
 *       For You, the filter badge counts it, and it carries to a category tab.
 *   W3  choosing it again clears it, and the tabs get no mode.
 *   W4  the choice is not persisted: a fresh mount starts with no mode.
 *
 * The flag read is the production FeatureFlagsProvider over a stubbed fetch.
 * The two tabs are stubbed to record their props (the same stubs as
 * DiscoveryScreen.component.test, plus a props probe).
 *
 * Run: pnpm test:component -- DiscoveryScreen.intentMode
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';

// ── Controls shared with mock factories (must be `mock`-prefixed) ─────────────

/** The props each tab stub was last rendered with. */
const mockTabProps: { forYou: Record<string, unknown> | null; category: Record<string, unknown> | null } = { forYou: null, category: null };

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
    // §28.11: null means the feed WAS read and is genuinely empty, which is
    // the state this screen test is exercising.
    unreadable: null,
  }),
}));

// ── Heavy child-section stubs ─────────────────────────────────────────────────
// NOTE: intentionally exhaustive — each stub replaces a component whose real
// implementation pulls maps/reanimated/etc. that are not safe under jest.

jest.mock('../ForYouTab', () => {
  const RN = jest.requireActual('react-native');
  return {
    ForYouTab: (props: Record<string, unknown>) => {
      mockTabProps.forYou = props;
      return <RN.Text testID="stub-for-you">ForYouTab</RN.Text>;
    },
  };
});

// NOTE: intentionally exhaustive — DiscoveryCategoryTab's real module also
// exports FilterStrip + SORT_LABELS, both imported by discovery.tsx; omitting
// them crashes the filters panel into SectionErrorBoundary.
jest.mock('../DiscoveryCategoryTab', () => {
  const RN = jest.requireActual('react-native');
  const Stub = (props: Record<string, unknown>) => {
    mockTabProps.category = props;
    return <RN.Text testID="stub-category-tab">DiscoveryCategoryTab</RN.Text>;
  };
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
import { FeatureFlagsProvider } from '../../../context/FeatureFlagsContext.tsx';
import { getTrendingHashtags } from '../../../services/hashtag.ts';
import { getAvailableNow } from '../../../services/rentABuddy.ts';

const realFetch = global.fetch;
let serverFlags: Record<string, boolean> | null = {};

beforeEach(() => {
  jest.clearAllMocks();
  mockTabProps.forYou = null;
  mockTabProps.category = null;
  serverFlags = {};
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  (getTrendingHashtags as jest.Mock).mockResolvedValue({ ok: true, data: { trending: [] } });
  (getAvailableNow as jest.Mock).mockResolvedValue({ ok: true, data: { buddies: [] } });
  global.fetch = jest.fn((url: string | URL | Request) => {
    if (String(url).endsWith('/api/feature-flags')) {
      if (serverFlags === null) return Promise.reject(new Error('offline'));
      return Promise.resolve(new Response(JSON.stringify({ flags: serverFlags }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  await act(async () => {});
  global.fetch = realFetch;
});

async function renderScreen() {
  const utils = await render(
    <FeatureFlagsProvider>
      <DiscoveryHub />
    </FeatureFlagsProvider>,
  );
  await act(async () => {});   // the provider's GET /api/feature-flags
  return utils;
}

async function openFilters() {
  await fireEvent.press(screen.getByTestId('discovery-filters-toggle'));
  await act(async () => {});
}

async function chooseCategoryTab() {
  await fireEvent.press(screen.getByText('Food'));
  await waitFor(() => expect(screen.getByTestId('stub-category-tab')).toBeTruthy());
}

describe('W1 — capability not reported: no selector, and no tab is handed a mode', () => {
  for (const [name, flags] of [
    ['the flag read fails', null],
    ['the flag is absent', { some_other_flag: true }],
    ['2850 as seeded (FALSE)', { discovery_live_rank_enabled: false }],
  ] as const) {
    it(name, async () => {
      serverFlags = flags as Record<string, boolean> | null;
      await renderScreen();
      await openFilters();
      expect(screen.queryByTestId('discovery-intent-mode-selector')).toBeNull();
      expect(mockTabProps.forYou?.intentMode ?? null).toBeNull();
      await chooseCategoryTab();
      expect(mockTabProps.category?.intentMode ?? null).toBeNull();
    });
  }
});

describe('W2/W3 — 2850 TRUE: the choice reaches the tab that fetches, and clearing it removes it', () => {
  it('choose Quiet → For You is handed quiet; the badge counts it; a category tab is handed it too; press again → none', async () => {
    serverFlags = { discovery_live_rank_enabled: true };
    await renderScreen();
    await openFilters();
    await waitFor(() => expect(screen.getByTestId('discovery-intent-mode-selector')).toBeTruthy());
    expect(mockTabProps.forYou?.intentMode ?? null).toBeNull();
    expect(screen.queryByTestId('discovery-filters-badge')).toBeNull();

    await fireEvent.press(screen.getByTestId('discovery-intent-mode-quiet'));
    await act(async () => {});
    expect(mockTabProps.forYou?.intentMode).toBe('quiet');
    expect(screen.getByTestId('discovery-filters-badge')).toHaveTextContent('1');

    await chooseCategoryTab();
    expect(mockTabProps.category?.intentMode).toBe('quiet');

    // The filter panel stays open across a tab change; the chosen chip is still there.
    await fireEvent.press(screen.getByTestId('discovery-intent-mode-quiet'));
    await act(async () => {});
    expect(mockTabProps.category?.intentMode ?? null).toBeNull();
    expect(screen.queryByTestId('discovery-filters-badge')).toBeNull();
  });
});

describe('W4 — the choice is session state, not persisted', () => {
  it('a fresh mount of the screen starts with no mode', async () => {
    serverFlags = { discovery_live_rank_enabled: true };
    const first = await renderScreen();
    await openFilters();
    await waitFor(() => expect(screen.getByTestId('discovery-intent-mode-social')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('discovery-intent-mode-social'));
    await act(async () => {});
    expect(mockTabProps.forYou?.intentMode).toBe('social');
    first.unmount();

    mockTabProps.forYou = null;
    await renderScreen();
    expect(mockTabProps.forYou).not.toBeNull();
    expect((mockTabProps.forYou as Record<string, unknown> | null)?.intentMode ?? null).toBeNull();
  });
});
